import type {
  AgentHandle,
  AgentInputResponse,
  AgentObservationIntent,
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
import { withSpan } from './observability';

export interface EveSessionLike {
  readonly state: SessionState;
  send<T>(input: SendTurnInput<T>): Promise<{ result(): Promise<MessageResult<T>> }>;
}

export interface EveSessionFactory {
  session(state?: SessionState): EveSessionLike;
}

interface AgentTurnTelemetry {
  readonly elapsedMilliseconds: number;
  readonly usage: AgentUsage;
}

interface AgentUsage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly toolSteps?: number;
  readonly subagentSteps?: number;
  readonly completedSteps: number;
}

type ReportedAgentUsageMetric =
  'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens';

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
    telemetry?: AgentTurnTelemetry,
  ): Promise<AgentHandle> {
    const participant = await this.client.runParticipant.findUniqueOrThrow({
      where: { id: handle.runParticipantId },
      select: {
        runId: true,
        run: { select: { organizationId: true } },
      },
    });
    return this.client.$transaction(async (tx) => {
      const sessionIdentity = state.sessionId ?? `pending:${handle.sessionId ?? handle.agentKey}`;
      // Provider 未返回流事件时补充 Turn 锚点，保证遥测仍可被可靠地幂等记账。
      const traceEvents =
        events.length > 0 || telemetry === undefined
          ? events
          : [{ type: 'adapter.turn_completed', data: {} }];
      const traceWrite = await tx.agentTrace.createMany({
        data: traceEvents.map((event, offset) => {
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
      // Trace 是当前 Turn 的幂等锚点，只有首次写入时才累计账本，避免重放重复计费。
      if (telemetry !== undefined && traceWrite.count > 0) {
        await tx.usageLedger.createMany({
          data: createUsageLedgerEntries({
            organizationId: participant.run.organizationId,
            runId: participant.runId,
            runParticipantId: handle.runParticipantId,
            agentKey: handle.agentKey,
            sessionId: state.sessionId,
            status,
            telemetry,
          }),
        });
      }
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
          // Eve 只有 waiting_for_input 才允许用 continuation token 继续同一
          // durable session。completed/failed/terminated 的下一次 Observation
          // 必须创建新 session，不能错误复用已经结束的上下文。
          sessionId: status === 'waiting_for_input' ? (state.sessionId ?? null) : null,
          continuationToken:
            status === 'waiting_for_input' ? (state.continuationToken ?? null) : null,
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

  async sendObservation(
    handle: AgentHandle,
    observation: Observation,
    options?: { intent: AgentObservationIntent },
  ): Promise<AgentTurnResult> {
    const context = createProposedActionValidationContext(observation);
    return this.send(handle, context, {
      message:
        options?.intent === 'compare'
          ? 'IC 请求你比较当前角色可建议的备选方案。请在内部完成比较后，只返回一条最高优先级、合法的 ProposedAction，并在 rationale 中说明取舍。'
          : '请根据当前 Observation 返回一条最高优先级、合法的 ProposedAction。',
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
    return withSpan(
      'readinessos.agent.turn',
      {
        'agent.key': handle.agentKey,
        'run_participant.id': handle.runParticipantId,
      },
      () => this.sendWithTrace(handle, validationContext, input),
    );
  }

  private async sendWithTrace(
    handle: AgentHandle,
    validationContext: ProposedActionValidationContext,
    input: SendTurnInput<ProposedAction>,
  ): Promise<AgentTurnResult> {
    // continuation token 是 Eve 的唯一恢复凭据。没有它时，即使数据库仍有
    // 已完成 sessionId，也必须从新的 durable session 开始一次 Observation。
    const session = this.sessions.session(
      handle.continuationToken === undefined
        ? { streamIndex: 0 }
        : {
            streamIndex: handle.streamIndex,
            ...(handle.sessionId === undefined ? {} : { sessionId: handle.sessionId }),
            continuationToken: handle.continuationToken,
          },
    );
    let response: { result(): Promise<MessageResult<ProposedAction>> };
    const startedAt = performance.now();
    try {
      response = await session.send(input);
    } catch (error) {
      await this.persistFailure(
        handle,
        session.state,
        'adapter.send_failed',
        error,
        validationContext,
        createAgentTurnTelemetry(startedAt, []),
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
        createAgentTurnTelemetry(startedAt, []),
      );
      throw error;
    }
    const status = mapStatus(result);
    let proposedAction: ProposedAction | undefined;
    let validationError: unknown;
    if (status === 'completed' && result.data !== undefined) {
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
    const traceEvents =
      events.length > 0 ? events : [{ type: 'adapter.turn_completed', data: {} }];
    const sessionIdentity = session.state.sessionId ?? `pending:${handle.sessionId ?? handle.agentKey}`;
    const traceIdentity = createTraceIdentity({
      runParticipantId: handle.runParticipantId,
      sessionIdentity,
      streamIndex: handle.streamIndex + traceEvents.length - 1,
    });
    const nextHandle = await this.store.persist(
      handle,
      session.state,
      persistedStatus,
      events,
      validationContext,
      createAgentTurnTelemetry(startedAt, result.events),
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
        options: readInputRequestOptions(request),
        allowFreeform: readAllowFreeform(request),
      })),
      ...(session.state.sessionId === undefined ? {} : { eveSessionId: session.state.sessionId }),
      eveTraceIdentity: traceIdentity,
    };
  }

  private async persistFailure(
    handle: AgentHandle,
    state: SessionState,
    eventType: 'adapter.send_failed' | 'adapter.result_failed',
    error: unknown,
    validationContext: ProposedActionValidationContext,
    telemetry: AgentTurnTelemetry,
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
        telemetry,
      );
    } catch {
      // 失败诊断不能替换原始 transport 异常；调用方仍收到真正根因。
    }
  }
}

export function createEveAgentRuntime(
  client: PrismaClient,
  host: string,
): EveAgentRuntime {
  const eve = new Client({
    host,
    redirect: 'error',
  });
  return new EveAgentRuntime(eve, new PrismaAgentRuntimeStore(client));
}

function mapStatus(result: Pick<MessageResult<unknown>, 'status' | 'data' | 'inputRequests'>): AgentRuntimeStatus {
  if (result.status !== 'waiting') return result.status;

  // Eve 会在结果已完成后将 durable session 置为 “等待下一条普通用户消息”。
  // 这不是 ask_question 的 HITL 状态：没有 inputRequests 时，平台必须消费
  // 已返回的结构化结果并结束本次 Observation，下一轮重新创建 session。
  return result.inputRequests.length > 0 ? 'waiting_for_input' : 'completed';
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

function readInputRequestOptions(
  request: unknown,
): readonly { id: string; label: string }[] {
  const options = objectValue(request).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    const value = objectValue(option);
    const id =
      typeof value.id === 'string'
        ? value.id
        : typeof value.optionId === 'string'
          ? value.optionId
          : undefined;
    const label =
      typeof value.label === 'string'
        ? value.label
        : typeof value.text === 'string'
          ? value.text
          : id;
    return id === undefined || label === undefined ? [] : [{ id, label }];
  });
}

function readAllowFreeform(request: unknown): boolean {
  return objectValue(request).allowFreeform === true;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function createAgentTurnTelemetry(
  startedAt: number,
  events: readonly { type: string; data?: unknown }[],
): AgentTurnTelemetry {
  return {
    elapsedMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
    usage: collectAgentUsage(events),
  };
}

function collectAgentUsage(events: readonly { type: string; data?: unknown }[]): AgentUsage {
  const totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolSteps: 0,
    subagentSteps: 0,
    completedSteps: 0,
  };
  const reported = {
    costUsd: false,
    inputTokens: false,
    outputTokens: false,
    cacheReadTokens: false,
    cacheWriteTokens: false,
  };

  for (const event of events) {
    if (event.type.startsWith('tool.')) totals.toolSteps += 1;
    if (event.type.startsWith('subagent.')) totals.subagentSteps += 1;
    if (event.type !== 'step.completed') continue;
    totals.completedSteps += 1;
    const usage = objectValue(objectValue(event.data).usage);
    addUsageMetric(totals, reported, 'costUsd', usage.costUsd);
    addUsageMetric(totals, reported, 'inputTokens', usage.inputTokens);
    addUsageMetric(totals, reported, 'outputTokens', usage.outputTokens);
    addUsageMetric(totals, reported, 'cacheReadTokens', usage.cacheReadTokens);
    addUsageMetric(totals, reported, 'cacheWriteTokens', usage.cacheWriteTokens);
  }

  return {
    completedSteps: totals.completedSteps,
    toolSteps: totals.toolSteps,
    subagentSteps: totals.subagentSteps,
    ...(reported.costUsd ? { costUsd: totals.costUsd } : {}),
    ...(reported.inputTokens ? { inputTokens: totals.inputTokens } : {}),
    ...(reported.outputTokens ? { outputTokens: totals.outputTokens } : {}),
    ...(reported.cacheReadTokens ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(reported.cacheWriteTokens ? { cacheWriteTokens: totals.cacheWriteTokens } : {}),
  };
}

function addUsageMetric(
  totals: Record<keyof Omit<AgentUsage, 'completedSteps'> | 'completedSteps', number>,
  reported: Record<ReportedAgentUsageMetric, boolean>,
  key: ReportedAgentUsageMetric,
  value: unknown,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
  totals[key] += value;
  reported[key] = true;
}

function createUsageLedgerEntries(input: {
  organizationId: string;
  runId: string;
  runParticipantId: string;
  agentKey: string;
  sessionId: string | undefined;
  status: AgentRuntimeStatus;
  telemetry: AgentTurnTelemetry;
}): Prisma.UsageLedgerCreateManyInput[] {
  const common = {
    organizationId: input.organizationId,
    runId: input.runId,
    runParticipantId: input.runParticipantId,
    metadata: json({
      provider: 'eve',
      agentKey: input.agentKey,
      sessionId: input.sessionId ?? null,
      status: input.status,
      completedSteps: input.telemetry.usage.completedSteps,
    }),
  };
  const entries: Prisma.UsageLedgerCreateManyInput[] = [
    { ...common, category: 'agent_turns', quantity: 1, unit: 'turn' },
    {
      ...common,
      category: 'agent_latency_ms',
      quantity: toLedgerQuantity(input.telemetry.elapsedMilliseconds),
      unit: 'ms',
    },
  ];
  addLedgerEntry(entries, common, 'agent_input_tokens', input.telemetry.usage.inputTokens, 'token');
  addLedgerEntry(
    entries,
    common,
    'agent_output_tokens',
    input.telemetry.usage.outputTokens,
    'token',
  );
  addLedgerEntry(
    entries,
    common,
    'agent_cache_read_tokens',
    input.telemetry.usage.cacheReadTokens,
    'token',
  );
  addLedgerEntry(
    entries,
    common,
    'agent_cache_write_tokens',
    input.telemetry.usage.cacheWriteTokens,
    'token',
  );
  addLedgerEntry(entries, common, 'agent_tool_steps', input.telemetry.usage.toolSteps, 'step');
  addLedgerEntry(
    entries,
    common,
    'agent_subagent_steps',
    input.telemetry.usage.subagentSteps,
    'step',
  );
  if (input.telemetry.usage.costUsd !== undefined) {
    addLedgerEntry(
      entries,
      common,
      'agent_cost_micro_usd',
      input.telemetry.usage.costUsd * 1_000_000,
      'micro_usd',
    );
  }
  return entries;
}

function addLedgerEntry(
  entries: Prisma.UsageLedgerCreateManyInput[],
  common: Omit<Prisma.UsageLedgerCreateManyInput, 'category' | 'quantity' | 'unit'>,
  category: string,
  quantity: number | undefined,
  unit: string,
): void {
  if (quantity === undefined || quantity <= 0) return;
  entries.push({ ...common, category, quantity: toLedgerQuantity(quantity), unit });
}

function toLedgerQuantity(value: number): number {
  return Math.max(0, Math.min(2_147_483_647, Math.round(value)));
}
