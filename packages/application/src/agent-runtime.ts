import { z } from 'zod';

const jsonRecordSchema = z.record(z.string(), z.unknown());

/**
 * Eve 只能返回待执行建议。严格 schema 会拒绝 commandId、event、worldPatch 等
 * 越权控制字段；建议仍需由平台命令管线再次鉴权后才可能执行。
 */
export const proposedActionSchema = z
  .object({
    // advisor 是当前 Eve Session 所属的数据库参与方；target 才是 Kernel 中
    // 被建议执行动作的场景参与方 ID。二者必须显式分离，避免建议被误解为执行。
    advisorParticipantId: z.string().uuid(),
    targetParticipantId: z.string().uuid(),
    actionType: z.string().min(1).max(128),
    parameters: jsonRecordSchema.default({}),
    rationale: z.string().min(1).max(4_000),
    evidenceRefs: z.array(z.string().min(1).max(256)).max(20).default([]),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ProposedAction = z.infer<typeof proposedActionSchema>;

const availableActionSchema = z.object({
  targetParticipantId: z.string().uuid(),
  type: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  parameterSchema: jsonRecordSchema.default({}),
});

export const observationSchema = z
  .object({
    organizationId: z.string().uuid(),
    runId: z.string().uuid(),
    participant: z.object({
      id: z.string().uuid(),
      key: z.string().min(1),
      displayName: z.string().min(1),
      objectives: z.array(z.string()),
    }),
    virtualTimeMinutes: z.number().int().nonnegative(),
    visibleState: jsonRecordSchema,
    visibleSignals: z.array(jsonRecordSchema),
    recentEvents: z.array(
      z.object({
        sequence: z.number().int().positive(),
        type: z.string().min(1),
        summary: z.string().max(1_000),
      }),
    ),
    availableActions: z.array(availableActionSchema),
    budget: z.object({
      remainingTurns: z.number().int().nonnegative(),
      remainingTokens: z.number().int().nonnegative(),
    }),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export interface AgentHandle {
  readonly runParticipantId: string;
  readonly agentKey: string;
  readonly sessionId: string | undefined;
  readonly continuationToken: string | undefined;
  readonly streamIndex: number;
}

export type AgentRuntimeStatus =
  'active' | 'waiting_for_input' | 'completed' | 'failed' | 'terminated';

export type AgentInputRequest = {
  requestId: string;
  prompt: string;
  options: readonly {
    id: string;
    label: string;
  }[];
  allowFreeform: boolean;
};

export type AgentInputResponse = {
  requestId: string;
  optionId?: string;
  text?: string;
};

export type AgentTurnResult = {
  handle: AgentHandle;
  status: AgentRuntimeStatus;
  proposedAction: ProposedAction | undefined;
  inputRequests: readonly AgentInputRequest[];
  /**
   * 仅在发送 Observation 时生成。平台把它存入 Recommendation，确保 IC 能够
   * 回溯建议确实基于哪一份角色可见事实，而不是只依赖触发事件的元数据。
   */
  observationHash?: string;
  /** Eve durable session 与 Trace 仅用于审计，不能作为业务事实或执行凭据。 */
  eveSessionId?: string;
  eveTraceIdentity?: string;
};

/**
 * `compare` 不是让 Agent 生成多条可执行动作，而是要求它在角色授权范围内
 * 比较备选方案后，仍只输出一条当前最高优先级建议。
 */
export type AgentObservationIntent = 'recommend' | 'compare';

export interface AgentRuntime {
  start(input: { runParticipantId: string; agentKey: string }): Promise<AgentHandle>;
  sendObservation(
    handle: AgentHandle,
    observation: Observation,
    options?: { intent: AgentObservationIntent },
  ): Promise<AgentTurnResult>;
  answerInput(handle: AgentHandle, response: AgentInputResponse): Promise<AgentTurnResult>;
  terminate(handle: AgentHandle): Promise<void>;
  getStatus(handle: AgentHandle): Promise<AgentRuntimeStatus>;
}

export const proposedActionValidationContextSchema = z.object({
  advisorParticipantId: z.string().uuid(),
  allowedActions: z.array(
    z.object({
      targetParticipantId: z.string().uuid(),
      actionType: z.string().min(1).max(128),
    }),
  ),
});
export type ProposedActionValidationContext = z.infer<typeof proposedActionValidationContextSchema>;

export function createProposedActionValidationContext(
  observation: Observation,
): ProposedActionValidationContext {
  return {
    advisorParticipantId: observation.participant.id,
    allowedActions: observation.availableActions.map((action) => ({
      targetParticipantId: action.targetParticipantId,
      actionType: action.type,
    })),
  };
}

export function validateProposedActionContext(
  context: ProposedActionValidationContext,
  candidate: unknown,
): ProposedAction {
  const action = proposedActionSchema.parse(candidate);
  if (action.advisorParticipantId !== context.advisorParticipantId) {
    throw new Error('Proposed action advisor does not match the observation.');
  }
  if (
    !context.allowedActions.some(
      (allowed) =>
        allowed.targetParticipantId === action.targetParticipantId &&
        allowed.actionType === action.actionType,
    )
  ) {
    throw new Error('Proposed action is not authorized for the selected target participant.');
  }
  return action;
}

export function validateProposedAction(
  observation: Observation,
  candidate: unknown,
): ProposedAction {
  return validateProposedActionContext(
    createProposedActionValidationContext(observation),
    candidate,
  );
}

export interface RunScheduler {
  start(input: {
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
    firstTickIndex: number;
    holderId: string;
  }): Promise<void>;
  cancel(input: { runId: string; organizationId: string; generation: number }): Promise<void>;
}

/** 单测调度器不触碰墙上时间，调用方可手动取得下一 tick。 */
export class ManualRunScheduler implements RunScheduler {
  readonly started: Array<Parameters<RunScheduler['start']>[0]> = [];
  readonly cancelled: Array<Parameters<RunScheduler['cancel']>[0]> = [];
  private readonly activeSchedules = new Map<
    string,
    { organizationId: string; generation: number; nextTickIndex: number; holderId: string }
  >();
  private readonly minimumGeneration = new Map<string, number>();

  async start(input: Parameters<RunScheduler['start']>[0]): Promise<void> {
    this.started.push(input);
    const current = this.activeSchedules.get(input.runId);
    if (current && current.generation > input.generation) return;
    this.activeSchedules.set(input.runId, {
      organizationId: input.organizationId,
      generation: input.generation,
      holderId: input.holderId,
      // 重复消费同一 Start 时，不能把已手动取得的 tick 倒退。
      nextTickIndex:
        current?.generation === input.generation
          ? Math.max(current.nextTickIndex, input.firstTickIndex)
          : input.firstTickIndex,
    });
  }

  async cancel(input: Parameters<RunScheduler['cancel']>[0]): Promise<void> {
    this.cancelled.push(input);
    this.minimumGeneration.set(
      input.runId,
      Math.max(this.minimumGeneration.get(input.runId) ?? 0, input.generation),
    );
  }

  takeNextTick(runId: string):
    | {
        runId: string;
        organizationId: string;
        generation: number;
        tickIndex: number;
        holderId: string;
      }
    | undefined {
    const schedule = this.activeSchedules.get(runId);
    if (!schedule || schedule.generation < (this.minimumGeneration.get(runId) ?? 0))
      return undefined;
    const tick = {
      runId,
      organizationId: schedule.organizationId,
      generation: schedule.generation,
      holderId: schedule.holderId,
      tickIndex: schedule.nextTickIndex,
    };
    schedule.nextTickIndex += 1;
    return tick;
  }
}
