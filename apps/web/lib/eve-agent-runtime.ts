import type {
  AgentHandle,
  AgentInputResponse,
  AgentRuntime,
  AgentRuntimeStatus,
  AgentTurnResult,
  Observation,
  ProposedAction,
  ProposedActionValidationContext,
} from '@readinessos/application';
import {
  createProposedActionValidationContext,
  proposedActionSchema,
  proposedActionValidationContextSchema,
  validateProposedActionContext,
} from '@readinessos/application';
import type { Prisma, PrismaClient } from '@readinessos/database';
import {
  Client,
  type InputResponse,
  type MessageResult,
  type SendTurnInput,
  type SessionState,
} from 'eve/client';
import { createHash } from 'node:crypto';

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

  async loadValidationContext(handle: AgentHandle): Promise<ProposedActionValidationContext> {
    const link = await this.client.agentSessionLink.findUniqueOrThrow({
      where: {
        runParticipantId_provider_agentKey: {
          runParticipantId: handle.runParticipantId,
          provider: 'eve',
          agentKey: handle.agentKey,
        },
      },
      select: { metadata: true },
    });
    return proposedActionValidationContextSchema.parse(
      objectValue(link.metadata).validationContext,
    );
  }

  async persist(
    handle: AgentHandle,
    state: SessionState,
    status: AgentRuntimeStatus,
    events: readonly { type: string; data?: unknown }[],
    validationContext?: ProposedActionValidationContext,
  ): Promise<AgentHandle> {
    const participant = await this.client.runParticipant.findUniqueOrThrow({
      where: { id: handle.runParticipantId },
      select: { runId: true },
    });
    return this.client.$transaction(async (tx) => {
      const sessionIdentity = state.sessionId ?? `pending:${handle.sessionId ?? handle.agentKey}`;
      await tx.agentTrace.createMany({
        data: events.map((event, offset) => {
          const streamIndex = handle.streamIndex + offset;
          return {
            runId: participant.runId,
            runParticipantId: handle.runParticipantId,
            sessionId: state.sessionId ?? null,
            streamIndex,
            traceIdentity: createTraceIdentity({
              runParticipantId: handle.runParticipantId,
              sessionIdentity,
              streamIndex,
            }),
            eventType: event.type,
            payload: json(event.data ?? {}),
          };
        }),
        skipDuplicates: true,
      });
      const currentMetadata = await tx.agentSessionLink.findUniqueOrThrow({
        where: {
          runParticipantId_provider_agentKey: {
            runParticipantId: handle.runParticipantId,
            provider: 'eve',
            agentKey: handle.agentKey,
          },
        },
        select: { metadata: true },
      });
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
          metadata: json({
            ...objectValue(currentMetadata.metadata),
            ...(validationContext === undefined ? {} : { validationContext }),
          }),
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
    const context = createProposedActionValidationContext(observation);
    return this.send(handle, context, {
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
    return this.send(handle, await this.store.loadValidationContext(handle), {
      inputResponses: [inputResponse],
      outputSchema: proposedActionSchema,
    });
  }

  terminate(handle: AgentHandle): Promise<void> {
    return this.store.terminate(handle);
  }

  getStatus(handle: AgentHandle): Promise<AgentRuntimeStatus> {
    return this.store.status(handle);
  }

  private async send(
    handle: AgentHandle,
    validationContext: ProposedActionValidationContext,
    input: SendTurnInput<ProposedAction>,
  ): Promise<AgentTurnResult> {
    const session = this.sessions.session({
      streamIndex: handle.streamIndex,
      ...(handle.sessionId === undefined ? {} : { sessionId: handle.sessionId }),
      ...(handle.continuationToken === undefined
        ? {}
        : { continuationToken: handle.continuationToken }),
    });
    let response: { result(): Promise<MessageResult<ProposedAction>> };
    try {
      response = await session.send(input);
    } catch (error) {
      await this.persistFailure(
        handle,
        session.state,
        'adapter.send_failed',
        error,
        validationContext,
      );
      throw error;
    }
    let result: MessageResult<ProposedAction>;
    try {
      result = await response.result();
    } catch (error) {
      await this.persistFailure(
        handle,
        session.state,
        'adapter.result_failed',
        error,
        validationContext,
      );
      throw error;
    }
    const status = mapStatus(result.status);
    let proposedAction: ProposedAction | undefined;
    let validationError: unknown;
    if (result.status === 'completed' && result.data !== undefined) {
      try {
        proposedAction = validateProposedActionContext(validationContext, result.data);
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
    const nextHandle = await this.store.persist(
      handle,
      session.state,
      persistedStatus,
      events,
      validationContext,
    );
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

  private async persistFailure(
    handle: AgentHandle,
    state: SessionState,
    eventType: 'adapter.send_failed' | 'adapter.result_failed',
    error: unknown,
    validationContext: ProposedActionValidationContext,
  ): Promise<void> {
    try {
      await this.store.persist(
        handle,
        state,
        'failed',
        [
          {
            type: eventType,
            data: { message: error instanceof Error ? error.message : String(error) },
          },
        ],
        validationContext,
      );
    } catch {
      // 失败诊断不能替换原始 transport 异常；调用方仍收到真正根因。
    }
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

function createTraceIdentity(input: {
  runParticipantId: string;
  sessionIdentity: string;
  streamIndex: number;
}): string {
  return createHash('sha256')
    .update(`${input.runParticipantId}:${input.sessionIdentity}:${input.streamIndex}`)
    .digest('hex');
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
