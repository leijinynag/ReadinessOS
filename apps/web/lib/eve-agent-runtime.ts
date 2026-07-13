import type {
  AgentHandle,
  AgentInputResponse,
  AgentRuntime,
  AgentRuntimeStatus,
  AgentTurnResult,
  Observation,
  ProposedAction,
} from '@readinessos/application';
import { proposedActionSchema, validateProposedAction } from '@readinessos/application';
import type { Prisma, PrismaClient } from '@readinessos/database';
import {
  Client,
  type InputResponse,
  type MessageResult,
  type SendTurnInput,
  type SessionState,
} from 'eve/client';

export interface EveSessionLike {
  readonly state: SessionState;
  send<T>(input: SendTurnInput<T>): Promise<{ result(): Promise<MessageResult<T>> }>;
}

export interface EveSessionFactory {
  session(state?: SessionState): EveSessionLike;
}

export class PrismaAgentRuntimeStore {
  constructor(private readonly client: PrismaClient) {}

  async loadOrCreate(runParticipantId: string, agentKey: string): Promise<AgentHandle> {
    const link = await this.client.agentSessionLink.upsert({
      where: {
        runParticipantId_provider_agentKey: { runParticipantId, provider: 'eve', agentKey },
      },
      create: { runParticipantId, provider: 'eve', agentKey },
      update: {},
    });
    return toHandle(link);
  }

  async persist(
    handle: AgentHandle,
    state: SessionState,
    status: AgentRuntimeStatus,
    events: readonly { type: string; data?: unknown }[],
  ): Promise<AgentHandle> {
    const participant = await this.client.runParticipant.findUniqueOrThrow({
      where: { id: handle.runParticipantId },
      select: { runId: true },
    });
    return this.client.$transaction(async (tx) => {
      for (let offset = 0; offset < events.length; offset += 1) {
        const streamIndex = handle.streamIndex + offset;
        const exists = await tx.agentTrace.findFirst({
          where: {
            sessionId: state.sessionId ?? null,
            streamIndex,
          },
          select: { id: true },
        });
        if (!exists) {
          const event = events[offset]!;
          await tx.agentTrace.create({
            data: {
              runId: participant.runId,
              runParticipantId: handle.runParticipantId,
              sessionId: state.sessionId ?? null,
              streamIndex,
              eventType: event.type,
              payload: json(event.data ?? {}),
            },
          });
        }
      }
      const link = await tx.agentSessionLink.update({
        where: {
          runParticipantId_provider_agentKey: {
            runParticipantId: handle.runParticipantId,
            provider: 'eve',
            agentKey: handle.agentKey,
          },
        },
        data: {
          sessionId: state.sessionId ?? null,
          continuationToken: state.continuationToken ?? null,
          streamIndex: state.streamIndex,
          status,
        },
      });
      return toHandle(link);
    });
  }

  async status(handle: AgentHandle): Promise<AgentRuntimeStatus> {
    const link = await this.client.agentSessionLink.findUniqueOrThrow({
      where: {
        runParticipantId_provider_agentKey: {
          runParticipantId: handle.runParticipantId,
          provider: 'eve',
          agentKey: handle.agentKey,
        },
      },
      select: { status: true },
    });
    return link.status;
  }

  async terminate(handle: AgentHandle): Promise<void> {
    await this.client.agentSessionLink.update({
      where: {
        runParticipantId_provider_agentKey: {
          runParticipantId: handle.runParticipantId,
          provider: 'eve',
          agentKey: handle.agentKey,
        },
      },
      data: { status: 'terminated' },
    });
  }
}

export class EveAgentRuntime implements AgentRuntime {
  constructor(
    private readonly sessions: EveSessionFactory,
    private readonly store: PrismaAgentRuntimeStore,
  ) {}

  start(input: { runParticipantId: string; agentKey: string }): Promise<AgentHandle> {
    return this.store.loadOrCreate(input.runParticipantId, input.agentKey);
  }

  async sendObservation(handle: AgentHandle, observation: Observation): Promise<AgentTurnResult> {
    return this.send(handle, observation, {
      message: '请根据当前 Observation 返回一个合法 ProposedAction。',
      clientContext: JSON.stringify(observation),
      outputSchema: proposedActionSchema,
    });
  }

  async answerInput(handle: AgentHandle, response: AgentInputResponse): Promise<AgentTurnResult> {
    const inputResponse: InputResponse = {
      requestId: response.requestId,
      ...(response.optionId === undefined ? {} : { optionId: response.optionId }),
      ...(response.text === undefined ? {} : { text: response.text }),
    };
    return this.send(handle, undefined, { inputResponses: [inputResponse] });
  }

  terminate(handle: AgentHandle): Promise<void> {
    return this.store.terminate(handle);
  }

  getStatus(handle: AgentHandle): Promise<AgentRuntimeStatus> {
    return this.store.status(handle);
  }

  private async send(
    handle: AgentHandle,
    observation: Observation | undefined,
    input: SendTurnInput<ProposedAction>,
  ): Promise<AgentTurnResult> {
    const session = this.sessions.session({
      streamIndex: handle.streamIndex,
      ...(handle.sessionId === undefined ? {} : { sessionId: handle.sessionId }),
      ...(handle.continuationToken === undefined
        ? {}
        : { continuationToken: handle.continuationToken }),
    });
    const response = await session.send(input);
    const result = await response.result();
    const status = mapStatus(result.status);
    let proposedAction: ProposedAction | undefined;
    let validationError: unknown;
    if (result.status === 'completed' && result.data !== undefined) {
      try {
        proposedAction = observation
          ? validateProposedAction(observation, result.data)
          : proposedActionSchema.parse(result.data);
      } catch (error) {
        validationError = error;
      }
    }
    const events =
      validationError === undefined
        ? result.events
        : [
            ...result.events,
            {
              type: 'adapter.validation_failed',
              data: {
                message:
                  validationError instanceof Error
                    ? validationError.message
                    : String(validationError),
              },
            },
          ];
    const persistedStatus = validationError === undefined ? status : 'failed';
    const nextHandle = await this.store.persist(handle, session.state, persistedStatus, events);
    if (validationError !== undefined) {
      throw validationError;
    }
    return {
      handle: nextHandle,
      status,
      proposedAction,
      inputRequests: result.inputRequests.map((request) => ({
        requestId: request.requestId,
        prompt: request.prompt,
      })),
    };
  }
}

export function createEveAgentRuntime(
  client: PrismaClient,
  host: string,
  apiKey?: string,
): EveAgentRuntime {
  const eve = new Client({
    host,
    ...(apiKey === undefined ? {} : { auth: { bearer: apiKey } }),
    redirect: 'error',
  });
  return new EveAgentRuntime(eve, new PrismaAgentRuntimeStore(client));
}

function mapStatus(status: MessageResult['status']): AgentRuntimeStatus {
  return status === 'waiting' ? 'waiting_for_input' : status;
}

function toHandle(link: {
  runParticipantId: string;
  agentKey: string;
  sessionId: string | null;
  continuationToken: string | null;
  streamIndex: number;
}): AgentHandle {
  return {
    runParticipantId: link.runParticipantId,
    agentKey: link.agentKey,
    sessionId: link.sessionId ?? undefined,
    continuationToken: link.continuationToken ?? undefined,
    streamIndex: link.streamIndex,
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
