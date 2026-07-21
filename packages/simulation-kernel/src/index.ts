import {
  ApplicationError,
  commandEnvelopeSchema,
  domainEventSchema,
  type ActorRef,
  type ApplicationErrorCode,
  type CommandEnvelope,
  type DomainEvent,
  type EventSource,
} from '@readinessos/domain-events';
import { z } from 'zod';

export type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed';
export type ParticipantController = 'human' | 'agent' | 'system';
export type ParticipantStatus = 'active' | 'inactive' | 'blocked';
export type ActionRisk = 'low' | 'high';

export type StatePath = readonly string[];

export type Trigger<TState> =
  | { readonly kind: 'all'; readonly conditions: readonly Trigger<TState>[] }
  | { readonly kind: 'any'; readonly conditions: readonly Trigger<TState>[] }
  | { readonly kind: 'not'; readonly condition: Trigger<TState> }
  | { readonly kind: 'elapsed-minutes-gte'; readonly minutes: number }
  | { readonly kind: 'state-equals'; readonly path: StatePath; readonly value: unknown }
  | { readonly kind: 'state-number-gte'; readonly path: StatePath; readonly value: number }
  | { readonly kind: 'event-occurred'; readonly eventType: string }
  | {
      readonly kind: 'participant-action-count-gte';
      readonly participantId: string;
      readonly actionType: string;
      readonly count: number;
    };

export type Effect =
  | { readonly kind: 'set-state'; readonly path: StatePath; readonly value: unknown }
  | { readonly kind: 'increment-state'; readonly path: StatePath; readonly amount: number }
  | {
      readonly kind: 'emit-signal';
      readonly signalKey: string;
      readonly recipients: readonly string[];
      readonly payload?: Record<string, unknown>;
    }
  | { readonly kind: 'schedule-inject'; readonly injectKey: string; readonly delayMinutes: number }
  | {
      readonly kind: 'change-participant-status';
      readonly participantId: string;
      readonly status: ParticipantStatus;
    }
  | { readonly kind: 'record-metric'; readonly metricKey: string; readonly value: number }
  | { readonly kind: 'complete-run'; readonly reason: string };

export interface ParticipantTemplate {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly controller: ParticipantController;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly knowledgeScopes: readonly string[];
  readonly objectives: readonly string[];
  readonly initialStatus?: ParticipantStatus;
}

export interface RuntimeParticipant extends ParticipantTemplate {
  readonly status: ParticipantStatus;
}

export interface ActionDefinition<TState> {
  readonly key: string;
  readonly label: string;
  readonly requiredCapabilities?: readonly string[];
  readonly requiredPermissions?: readonly string[];
  readonly requiredKnowledgeScopes?: readonly string[];
  readonly risk: ActionRisk;
  readonly approval: 'none' | 'required';
  readonly precondition?: Trigger<TState>;
  readonly effects: readonly Effect[];
}

export interface InjectDefinition<TState> {
  readonly key: string;
  readonly trigger?: Trigger<TState>;
  readonly effects: readonly Effect[];
  readonly once?: true;
}

export interface SignalDefinition {
  readonly key: string;
  readonly label: string;
  readonly requiredKnowledgeScopes?: readonly string[];
}

export interface EvaluationDraft {
  readonly evaluatorKey: string;
  readonly score: number;
  readonly summary: string;
  readonly evidenceEventTypes: readonly string[];
}

export interface EvaluatorContext<TState> {
  readonly state: SimulationState<TState>;
  readonly definition: ScenarioDefinition<TState>;
}

export interface EvaluatorDefinition<TState> {
  readonly key: string;
  evaluate(context: EvaluatorContext<TState>): EvaluationDraft;
}

export interface ScenarioRuntimeBindings {
  readonly statusPath?: StatePath;
  readonly elapsedMinutesPath?: StatePath;
}

export interface ScenarioDefinition<TState> {
  readonly key: string;
  readonly stateSchema: z.ZodType<TState>;
  readonly initialState: (config: Record<string, unknown>) => TState;
  readonly participants: readonly ParticipantTemplate[];
  readonly actions: readonly ActionDefinition<TState>[];
  readonly signals: readonly SignalDefinition[];
  readonly injects: readonly InjectDefinition<TState>[];
  readonly evaluators: readonly EvaluatorDefinition<TState>[];
  readonly runtimeBindings?: ScenarioRuntimeBindings;
  readonly maxTriggerIterations?: number;
}

export interface SimulationRunState {
  readonly organizationId: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly seed: number;
  readonly version: number;
  readonly latestSequence: number;
  readonly virtualTimeMinutes: number;
  readonly simulatedAt: string;
  readonly appliedCommandIds: readonly string[];
  readonly appliedIdempotencyKeys: readonly string[];
  readonly completedReason?: string;
}

export interface ScheduledInject {
  readonly scheduleId: string;
  readonly injectKey: string;
  readonly dueAtMinute: number;
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly actionType: string;
  readonly participantId: string;
  readonly parameters: Record<string, unknown>;
  readonly requestedByCommandId: string;
}

export interface SimulationState<TState> {
  readonly run: SimulationRunState;
  readonly world: TState;
  readonly participants: Readonly<Record<string, RuntimeParticipant>>;
  readonly scheduledInjects: readonly ScheduledInject[];
  readonly triggeredInjectKeys: readonly string[];
  readonly pendingApprovals: Readonly<Record<string, PendingApproval>>;
  readonly actionCounts: Readonly<Record<string, number>>;
  readonly occurredEventTypes: Readonly<Record<string, number>>;
  readonly metrics: Readonly<Record<string, number>>;
}

export type RunCommandPayload =
  | { readonly type: 'start-run' }
  | { readonly type: 'pause-run'; readonly reason?: string }
  | { readonly type: 'resume-run' }
  | { readonly type: 'advance-clock'; readonly minutes: number }
  | {
      readonly type: 'submit-action';
      readonly actionType: string;
      readonly participantId: string;
      readonly parameters: Record<string, unknown>;
    }
  | {
      readonly type: 'resolve-approval';
      readonly approvalId: string;
      readonly decision: 'approved' | 'denied' | 'expired';
    }
  | { readonly type: 'trigger-inject'; readonly injectKey: string }
  | { readonly type: 'finish-run'; readonly reason: string }
  | { readonly type: 'create-checkpoint'; readonly label: string }
  | {
      readonly type: 'create-branch';
      readonly name: string;
      readonly childRunId?: string;
      readonly branchFromSequence?: number;
    };

export type RunCommand = CommandEnvelope<RunCommandPayload>;

export interface CreateRunInput {
  readonly organizationId: string;
  readonly runId: string;
  readonly seed: number;
  readonly config?: Record<string, unknown>;
  readonly simulatedAt: string;
}

export interface KernelContext {
  /**
   * Kernel 不读取系统时间或随机数。调用方提供录入时间和事件 ID，
   * 因而相同输入在本地、测试和生产环境都能生成相同的事件序列。
   */
  readonly recordedAt: string;
  readonly nextEventId: () => string;
}

export interface SideEffectIntent {
  readonly type: 'schedule-wakeup' | 'notify-participants';
  readonly payload: Record<string, unknown>;
}

export interface KernelRejection {
  readonly code: ApplicationErrorCode;
  readonly message: string;
}

export interface KernelResult<TState> {
  readonly state: SimulationState<TState>;
  readonly events: readonly DomainEvent[];
  readonly sideEffects: readonly SideEffectIntent[];
  readonly evaluations: readonly EvaluationDraft[];
  readonly status: 'accepted' | 'rejected' | 'duplicate';
  readonly rejection?: KernelRejection;
}

export interface ScenarioValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DeterministicRandom {
  next(): number;
  integer(min: number, max: number): number;
}

/**
 * 使用显式种子构造伪随机数。内核和场景包禁止直接调用 Math.random，
 * 否则同一运行历史在复盘时无法稳定重放。
 */
export function createDeterministicRandom(seed: number): DeterministicRandom {
  let value = seed >>> 0;

  return {
    next() {
      value += 0x6d2b79f5;
      let mixed = value;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    },
    integer(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        throw new Error('Deterministic random integer bounds are invalid.');
      }

      return min + Math.floor(this.next() * (max - min + 1));
    },
  };
}

export const all = <TState>(...conditions: readonly Trigger<TState>[]): Trigger<TState> => ({
  kind: 'all',
  conditions,
});

export const any = <TState>(...conditions: readonly Trigger<TState>[]): Trigger<TState> => ({
  kind: 'any',
  conditions,
});

export const not = <TState>(condition: Trigger<TState>): Trigger<TState> => ({
  kind: 'not',
  condition,
});

export const elapsedMinutesGte = <TState>(minutes: number): Trigger<TState> => ({
  kind: 'elapsed-minutes-gte',
  minutes,
});

export const stateEquals = <TState>(path: StatePath, value: unknown): Trigger<TState> => ({
  kind: 'state-equals',
  path,
  value,
});

export const stateNumberGte = <TState>(path: StatePath, value: number): Trigger<TState> => ({
  kind: 'state-number-gte',
  path,
  value,
});

export const eventOccurred = <TState>(eventType: string): Trigger<TState> => ({
  kind: 'event-occurred',
  eventType,
});

export const participantActionCountGte = <TState>(
  participantId: string,
  actionType: string,
  count: number,
): Trigger<TState> => ({
  kind: 'participant-action-count-gte',
  participantId,
  actionType,
  count,
});

export function validateScenarioDefinition<TState>(
  definition: ScenarioDefinition<TState>,
): ScenarioValidationResult {
  const errors: string[] = [];
  const initialState = definition.initialState({});
  const stateResult = definition.stateSchema.safeParse(initialState);

  if (!stateResult.success) {
    errors.push(`初始 WorldState 未通过 Zod 校验：${stateResult.error.message}`);
  }

  validateUniqueKeys(definition.participants, '参与方', errors);
  validateUniqueKeys(definition.actions, '动作', errors);
  validateUniqueKeys(definition.signals, '信号', errors);
  validateUniqueKeys(definition.injects, '注入', errors);
  validateUniqueKeys(definition.evaluators, '评估器', errors);

  for (const participant of definition.participants) {
    if (!participant.id || !participant.key || !participant.displayName) {
      errors.push('参与方必须包含 id、key 和 displayName。');
    }
  }

  for (const action of definition.actions) {
    if (action.risk === 'high' && action.approval !== 'required') {
      errors.push(`高风险动作 ${action.key} 必须要求审批。`);
    }
    validateEffects(action.effects, initialState, definition, `动作 ${action.key}`, errors);
    validateTrigger(action.precondition, initialState, `动作 ${action.key}`, errors);
  }

  for (const signal of definition.signals) {
    if (!signal.label) {
      errors.push(`信号 ${signal.key} 必须包含 label。`);
    }
  }

  for (const inject of definition.injects) {
    validateEffects(inject.effects, initialState, definition, `注入 ${inject.key}`, errors);
    validateTrigger(inject.trigger, initialState, `注入 ${inject.key}`, errors);
  }

  validateStatePath(definition.runtimeBindings?.statusPath, initialState, '运行状态绑定', errors);
  validateStatePath(
    definition.runtimeBindings?.elapsedMinutesPath,
    initialState,
    '虚拟时间绑定',
    errors,
  );

  if (
    definition.maxTriggerIterations !== undefined &&
    (!Number.isInteger(definition.maxTriggerIterations) || definition.maxTriggerIterations <= 0)
  ) {
    errors.push('maxTriggerIterations 必须是正整数。');
  }

  return { valid: errors.length === 0, errors };
}

export class SimulationKernel<TState> {
  constructor(readonly definition: ScenarioDefinition<TState>) {
    const validation = validateScenarioDefinition(definition);
    if (!validation.valid) {
      throw new Error(`Scenario definition is invalid:\n${validation.errors.join('\n')}`);
    }
  }

  /**
   * 创建空的聚合状态，供从完整事件流或 Snapshot 重放时使用。
   * `run.created` 由 createRun 单独写入，因此该入口的 latestSequence 固定为 0。
   */
  initialize(input: CreateRunInput): SimulationState<TState> {
    const world = this.definition.stateSchema.parse(
      this.definition.initialState(input.config ?? {}),
    ) as TState;
    return this.createInitialState(input, world);
  }

  createRun(input: CreateRunInput, context: KernelContext): KernelResult<TState> {
    const initialState = this.initialize(input);
    const event = this.createEvent(initialState, context, {
      type: 'run.created',
      source: 'system',
      idempotencyKey: `create:${input.runId}`,
      payload: {
        seed: input.seed,
        scenarioKey: this.definition.key,
        simulatedAt: input.simulatedAt,
      },
    });
    const state = this.applyEvent(initialState, event);

    return {
      state,
      events: [event],
      sideEffects: [],
      evaluations: [],
      status: 'accepted',
    };
  }

  /**
   * 分支 Run 不复制父事件流，而是把父状态作为新 Run 的创建基线写进自身首个事件。
   * 这样即使子 Run 的 Snapshot 缺失，也能只靠自己的事件流恢复同一状态。
   */
  createBranchRun(
    input: CreateRunInput,
    inheritedState: SimulationState<TState>,
    context: KernelContext,
  ): KernelResult<TState> {
    const initialState = this.initialize(input);
    const branchState: SimulationState<TState> = {
      ...cloneState(inheritedState),
      run: {
        organizationId: input.organizationId,
        runId: input.runId,
        status: 'created',
        seed: input.seed,
        version: 0,
        latestSequence: 0,
        virtualTimeMinutes: inheritedState.run.virtualTimeMinutes,
        simulatedAt: inheritedState.run.simulatedAt,
        appliedCommandIds: [],
        appliedIdempotencyKeys: [],
      },
      pendingApprovals: {},
    };
    const event = this.createEvent(initialState, context, {
      type: 'run.created',
      source: 'system',
      idempotencyKey: `create:${input.runId}`,
      payload: {
        seed: input.seed,
        scenarioKey: this.definition.key,
        simulatedAt: input.simulatedAt,
        inheritedState: branchState,
      },
    });
    const state = this.applyEvent(initialState, event);

    return {
      state,
      events: [event],
      sideEffects: [],
      evaluations: this.evaluate(state),
      status: 'accepted',
    };
  }

  execute(
    state: SimulationState<TState>,
    command: RunCommand,
    context: KernelContext,
  ): KernelResult<TState> {
    commandEnvelopeSchema.parse(command);
    const normalizedState = this.normalizeState(state);

    if (
      command.organizationId !== normalizedState.run.organizationId ||
      command.runId !== normalizedState.run.runId
    ) {
      return this.reject(
        normalizedState,
        'VALIDATION_ERROR',
        'Command does not match the current run.',
      );
    }

    if (
      normalizedState.run.appliedCommandIds.includes(command.commandId) ||
      normalizedState.run.appliedIdempotencyKeys.includes(command.idempotencyKey)
    ) {
      return {
        state: normalizedState,
        events: [],
        sideEffects: [],
        evaluations: [],
        status: 'duplicate',
      };
    }

    if (command.expectedRunVersion !== normalizedState.run.version) {
      return this.reject(
        normalizedState,
        'RUN_VERSION_CONFLICT',
        'Run version does not match the command.',
      );
    }

    if (
      this.isTerminal(normalizedState) &&
      command.payload.type !== 'create-checkpoint' &&
      command.payload.type !== 'create-branch'
    ) {
      return this.reject(normalizedState, 'RUN_TERMINAL', 'Terminal runs cannot accept this command.');
    }

    let workingState = normalizedState;
    const events: DomainEvent[] = [];
    const sideEffects: SideEffectIntent[] = [];
    let eventIndex = 0;

    const append = (draft: EventDraft): void => {
      const event = this.createEvent(workingState, context, {
        ...draft,
        causationId: command.commandId,
        correlationId: command.commandId,
        idempotencyKey:
          eventIndex++ === 0
            ? command.idempotencyKey
            : `${command.idempotencyKey}:${eventIndex - 1}:${draft.idempotencyKey}`,
      });
      workingState = this.applyEvent(workingState, event);
      events.push(event);
    };

    const executeAction = (
      action: ActionDefinition<TState>,
      participantId: string,
      parameters: Record<string, unknown>,
    ): void => {
      append({
        type: 'action.executed',
        source: eventSourceForActor(command.actor),
        participantId,
        idempotencyKey: `${command.idempotencyKey}:executed:${action.key}`,
        payload: { actionType: action.key, participantId, parameters },
      });
      this.applyEffects(() => workingState, action.effects, append, sideEffects);
    };

    const payload = command.payload;
    switch (payload.type) {
      case 'start-run': {
        if (workingState.run.status !== 'created') {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'Only a created run can be started.',
          );
        }
        append({
          type: 'run.started',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'run.started',
          payload: {},
        });
        sideEffects.push({
          type: 'schedule-wakeup',
          payload: { runId: command.runId, generation: workingState.run.version },
        });
        this.runDueInjects(() => workingState, append, sideEffects);
        break;
      }

      case 'pause-run': {
        if (workingState.run.status !== 'running') {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'Only a running run can be paused.',
          );
        }
        append({
          type: 'run.paused',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'run.paused',
          payload: payload.reason === undefined ? {} : { reason: payload.reason },
        });
        break;
      }

      case 'resume-run': {
        if (workingState.run.status !== 'paused') {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'Only a paused run can be resumed.',
          );
        }
        append({
          type: 'run.resumed',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'run.resumed',
          payload: {},
        });
        sideEffects.push({
          type: 'schedule-wakeup',
          payload: { runId: command.runId, generation: workingState.run.version },
        });
        break;
      }

      case 'advance-clock': {
        if (workingState.run.status !== 'running') {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'Only a running run can advance time.',
          );
        }
        if (!Number.isInteger(payload.minutes) || payload.minutes <= 0) {
          return this.reject(
            normalizedState,
            'VALIDATION_ERROR',
            'Clock minutes must be a positive integer.',
          );
        }
        append({
          type: 'clock.advanced',
          source: 'system',
          idempotencyKey: 'clock.advanced',
          payload: { minutes: payload.minutes },
        });
        this.runDueInjects(() => workingState, append, sideEffects);
        break;
      }

      case 'submit-action': {
        if (workingState.run.status !== 'running') {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'Only a running run can submit actions.',
          );
        }
        const participant = workingState.participants[payload.participantId];
        const action = this.definition.actions.find(
          (candidate) => candidate.key === payload.actionType,
        );

        if (!participant || !action) {
          return this.recordActionRejection(
            workingState,
            command,
            context,
            events,
            sideEffects,
            'ACTION_NOT_ALLOWED',
            'Action or participant is unavailable.',
          );
        }

        const policyFailure = getActionPolicyFailure(workingState, participant, action);
        if (policyFailure) {
          return this.recordActionRejection(
            workingState,
            command,
            context,
            events,
            sideEffects,
            policyFailure.code,
            policyFailure.message,
          );
        }

        append({
          type: 'action.proposed',
          source: eventSourceForActor(command.actor),
          participantId: participant.id,
          idempotencyKey: `${command.idempotencyKey}:proposed`,
          payload: {
            actionType: action.key,
            participantId: participant.id,
            parameters: payload.parameters,
          },
        });

        if (action.approval === 'required') {
          append({
            type: 'action.approval_requested',
            source: eventSourceForActor(command.actor),
            participantId: participant.id,
            idempotencyKey: `${command.idempotencyKey}:approval`,
            payload: {
              approvalId: command.commandId,
              actionType: action.key,
              participantId: participant.id,
              parameters: payload.parameters,
              requestedByCommandId: command.commandId,
            },
          });
          break;
        }

        executeAction(action, participant.id, payload.parameters);
        this.runDueInjects(() => workingState, append, sideEffects);
        break;
      }

      case 'resolve-approval': {
        const pendingApproval = workingState.pendingApprovals[payload.approvalId];
        if (!pendingApproval) {
          return this.reject(normalizedState, 'APPROVAL_STALE', 'The approval no longer exists.');
        }
        if (payload.decision === 'expired') {
          append({
            type: 'action.approval_expired',
            source: eventSourceForActor(command.actor),
            participantId: pendingApproval.participantId,
            idempotencyKey: `${command.idempotencyKey}:expired`,
            payload: { approvalId: pendingApproval.approvalId },
          });
          break;
        }
        if (payload.decision === 'denied') {
          append({
            type: 'action.denied',
            source: eventSourceForActor(command.actor),
            participantId: pendingApproval.participantId,
            idempotencyKey: `${command.idempotencyKey}:denied`,
            payload: { approvalId: pendingApproval.approvalId },
          });
          break;
        }

        const action = this.definition.actions.find(
          (candidate) => candidate.key === pendingApproval.actionType,
        );
        const participant = workingState.participants[pendingApproval.participantId];
        if (!action || !participant) {
          return this.reject(
            normalizedState,
            'APPROVAL_STALE',
            'The approved action is no longer valid.',
          );
        }

        const policyFailure = getActionPolicyFailure(workingState, participant, action);
        if (policyFailure) {
          return this.reject(
            normalizedState,
            'APPROVAL_STALE',
            'The action preconditions have changed.',
          );
        }

        append({
          type: 'action.approved',
          source: eventSourceForActor(command.actor),
          participantId: pendingApproval.participantId,
          idempotencyKey: `${command.idempotencyKey}:approved`,
          payload: { approvalId: pendingApproval.approvalId },
        });
        executeAction(action, pendingApproval.participantId, pendingApproval.parameters);
        this.runDueInjects(() => workingState, append, sideEffects);
        break;
      }

      case 'trigger-inject': {
        const inject = this.definition.injects.find(
          (candidate) => candidate.key === payload.injectKey,
        );
        if (!inject || workingState.triggeredInjectKeys.includes(payload.injectKey)) {
          return this.reject(
            normalizedState,
            'ACTION_NOT_ALLOWED',
            'The inject is unavailable.',
          );
        }
        this.triggerInject(() => workingState, inject, append, sideEffects);
        break;
      }

      case 'finish-run': {
        append({
          type: 'run.completed',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'run.completed',
          payload: { reason: payload.reason },
        });
        break;
      }

      case 'create-checkpoint': {
        append({
          type: 'checkpoint.created',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'checkpoint.created',
          payload: { label: payload.label },
        });
        break;
      }

      case 'create-branch': {
        append({
          type: 'branch.created',
          source: eventSourceForActor(command.actor),
          idempotencyKey: 'branch.created',
          payload: {
            name: payload.name,
            ...(payload.childRunId === undefined ? {} : { childRunId: payload.childRunId }),
            ...(payload.branchFromSequence === undefined
              ? {}
              : { branchFromSequence: payload.branchFromSequence }),
          },
        });
        break;
      }
    }

    this.assertValidState(workingState);
    return {
      state: workingState,
      events,
      sideEffects,
      evaluations: this.evaluate(workingState),
      status: 'accepted',
    };
  }

  replay(
    initialState: SimulationState<TState>,
    events: readonly DomainEvent[],
  ): SimulationState<TState> {
    let state = this.normalizeState(initialState);
    for (const event of events) {
      state = this.applyEvent(state, event);
    }
    this.assertValidState(state);
    return state;
  }

  evaluate(state: SimulationState<TState>): readonly EvaluationDraft[] {
    return this.definition.evaluators.map((evaluator) =>
      evaluator.evaluate({ state, definition: this.definition }),
    );
  }

  private createInitialState(input: CreateRunInput, world: TState): SimulationState<TState> {
    const participants: Record<string, RuntimeParticipant> = {};
    for (const template of this.definition.participants) {
      participants[template.id] = {
        ...template,
        status: template.initialStatus ?? 'active',
      };
    }

    return {
      run: {
        organizationId: input.organizationId,
        runId: input.runId,
        status: 'created',
        seed: input.seed,
        version: 0,
        latestSequence: 0,
        virtualTimeMinutes: 0,
        simulatedAt: input.simulatedAt,
        appliedCommandIds: [],
        appliedIdempotencyKeys: [],
      },
      world,
      participants,
      scheduledInjects: [],
      triggeredInjectKeys: [],
      pendingApprovals: {},
      actionCounts: {},
      occurredEventTypes: {},
      metrics: {},
    };
  }

  private createEvent(
    state: SimulationState<TState>,
    context: KernelContext,
    draft: EventDraft,
  ): DomainEvent {
    const event: DomainEvent = {
      id: context.nextEventId(),
      organizationId: state.run.organizationId,
      runId: state.run.runId,
      sequence: state.run.latestSequence + 1,
      type: draft.type,
      version: 1,
      source: draft.source,
      simulatedAt: state.run.simulatedAt,
      recordedAt: context.recordedAt,
      idempotencyKey: draft.idempotencyKey,
      payload: draft.payload,
    };

    if (draft.participantId !== undefined) {
      event.participantId = draft.participantId;
    }
    if (draft.causationId !== undefined) {
      event.causationId = draft.causationId;
    }
    if (draft.correlationId !== undefined) {
      event.correlationId = draft.correlationId;
    }

    domainEventSchema.parse(event);
    return event;
  }

  private applyEvent(state: SimulationState<TState>, event: DomainEvent): SimulationState<TState> {
    if (event.sequence !== state.run.latestSequence + 1) {
      throw new ApplicationError(
        'SEQUENCE_GAP',
        'Domain events must have contiguous sequence numbers.',
      );
    }

    let next = cloneState(state);
    next = {
      ...next,
      run: {
        ...next.run,
        latestSequence: event.sequence,
        appliedCommandIds: appendUnique(next.run.appliedCommandIds, event.causationId),
        appliedIdempotencyKeys: appendUnique(next.run.appliedIdempotencyKeys, event.idempotencyKey),
      },
      occurredEventTypes: incrementRecord(next.occurredEventTypes, event.type),
    };

    if (event.causationId !== undefined) {
      next = {
        ...next,
        run: {
          ...next.run,
          version: next.run.appliedCommandIds.length,
        },
      };
    }

    switch (event.type) {
      case 'run.created': {
        const payload = recordPayload(event.payload);
        const inheritedState = payload.inheritedState;
        if (
          typeof inheritedState !== 'object' ||
          inheritedState === null ||
          Array.isArray(inheritedState)
        ) {
          const simulatedAt = readOptionalString(payload, 'simulatedAt');
          return simulatedAt === undefined
            ? next
            : {
                ...next,
                run: {
                  ...next.run,
                  simulatedAt,
                },
              };
        }
        const inherited = cloneState(inheritedState as SimulationState<TState>);
        return {
          ...inherited,
          run: {
            ...next.run,
            virtualTimeMinutes: inherited.run.virtualTimeMinutes,
            simulatedAt: inherited.run.simulatedAt,
          },
          occurredEventTypes: incrementRecord(inherited.occurredEventTypes, event.type),
        };
      }
      case 'run.started':
        return this.updateRunStatus(next, 'running');
      case 'run.paused':
        return this.updateRunStatus(next, 'paused');
      case 'run.resumed':
        return this.updateRunStatus(next, 'running');
      case 'run.completed': {
        const payload = recordPayload(event.payload);
        return this.updateRunStatus(next, 'completed', readString(payload, 'reason'));
      }
      case 'run.failed':
        return this.updateRunStatus(next, 'failed');
      case 'clock.advanced': {
        const payload = recordPayload(event.payload);
        const minutes = readNumber(payload, 'minutes');
        const virtualTimeMinutes = next.run.virtualTimeMinutes + minutes;
        let world = next.world;
        const elapsedMinutesPath = this.definition.runtimeBindings?.elapsedMinutesPath;
        if (elapsedMinutesPath) {
          world = setValueAtPath(world, elapsedMinutesPath, virtualTimeMinutes);
        }
        return {
          ...next,
          run: {
            ...next.run,
            virtualTimeMinutes,
            simulatedAt: addMinutes(next.run.simulatedAt, minutes),
          },
          world,
        };
      }
      case 'state.changed': {
        const payload = recordPayload(event.payload);
        const changes = payload.changes;
        if (!Array.isArray(changes)) {
          throw new Error('state.changed must contain a changes array.');
        }
        let world = next.world;
        for (const change of changes) {
          const item = recordPayload(change);
          const rawPath = item.path;
          if (!Array.isArray(rawPath) || !rawPath.every((part) => typeof part === 'string')) {
            throw new Error('state.changed contains an invalid state path.');
          }
          world = setValueAtPath(world, rawPath, item.value);
        }
        return { ...next, world };
      }
      case 'inject.scheduled': {
        const payload = recordPayload(event.payload);
        const scheduled: ScheduledInject = {
          scheduleId: readString(payload, 'scheduleId'),
          injectKey: readString(payload, 'injectKey'),
          dueAtMinute: readNumber(payload, 'dueAtMinute'),
        };
        return { ...next, scheduledInjects: [...next.scheduledInjects, scheduled] };
      }
      case 'inject.triggered': {
        const payload = recordPayload(event.payload);
        const injectKey = readString(payload, 'injectKey');
        const scheduleId = readOptionalString(payload, 'scheduleId');
        return {
          ...next,
          triggeredInjectKeys: appendUnique(next.triggeredInjectKeys, injectKey),
          scheduledInjects:
            scheduleId === undefined
              ? next.scheduledInjects
              : next.scheduledInjects.filter((scheduled) => scheduled.scheduleId !== scheduleId),
        };
      }
      case 'participant.status_changed': {
        const payload = recordPayload(event.payload);
        const participantId = readString(payload, 'participantId');
        const participant = next.participants[participantId];
        if (!participant) {
          throw new Error(`Unknown participant ${participantId}.`);
        }
        const status = readParticipantStatus(payload, 'status');
        return {
          ...next,
          participants: {
            ...next.participants,
            [participantId]: { ...participant, status },
          },
        };
      }
      case 'metric.recorded': {
        const payload = recordPayload(event.payload);
        return {
          ...next,
          metrics: {
            ...next.metrics,
            [readString(payload, 'metricKey')]: readNumber(payload, 'value'),
          },
        };
      }
      case 'action.approval_requested': {
        const payload = recordPayload(event.payload);
        const approval: PendingApproval = {
          approvalId: readString(payload, 'approvalId'),
          actionType: readString(payload, 'actionType'),
          participantId: readString(payload, 'participantId'),
          parameters: readRecord(payload, 'parameters'),
          requestedByCommandId: readString(payload, 'requestedByCommandId'),
        };
        return {
          ...next,
          pendingApprovals: {
            ...next.pendingApprovals,
            [approval.approvalId]: approval,
          },
        };
      }
      case 'action.approved':
      case 'action.denied':
      case 'action.approval_expired': {
        const payload = recordPayload(event.payload);
        const approvalId = readString(payload, 'approvalId');
        const pendingApprovals = { ...next.pendingApprovals };
        delete pendingApprovals[approvalId];
        return { ...next, pendingApprovals };
      }
      case 'action.executed': {
        const payload = recordPayload(event.payload);
        const participantId = readString(payload, 'participantId');
        const actionType = readString(payload, 'actionType');
        return {
          ...next,
          actionCounts: incrementRecord(
            next.actionCounts,
            actionCountKey(participantId, actionType),
          ),
        };
      }
      default:
        return next;
    }
  }

  private updateRunStatus(
    state: SimulationState<TState>,
    status: RunStatus,
    completedReason?: string,
  ): SimulationState<TState> {
    let world = state.world;
    const statusPath = this.definition.runtimeBindings?.statusPath;
    if (statusPath) {
      world = setValueAtPath(world, statusPath, status);
    }
    const run = {
      ...state.run,
      status,
      ...(completedReason === undefined ? {} : { completedReason }),
    };
    return { ...state, run, world };
  }

  private applyEffects(
    getState: () => SimulationState<TState>,
    effects: readonly Effect[],
    append: (draft: EventDraft) => void,
    sideEffects: SideEffectIntent[],
  ): void {
    // 事件是状态变化的唯一载体。Effect 不直接改写对象，确保 replay 与即时执行共用同一逻辑。
    for (const effect of effects) {
      if (this.isTerminal(getState())) {
        return;
      }

      switch (effect.kind) {
        case 'set-state':
          append({
            type: 'state.changed',
            source: 'system',
            idempotencyKey: `effect:set:${effect.path.join('.')}`,
            payload: { changes: [{ path: [...effect.path], value: effect.value }] },
          });
          break;
        case 'increment-state': {
          const currentValue = getValueAtPath(getState().world, effect.path);
          if (typeof currentValue !== 'number') {
            throw new Error(`Cannot increment non-number state path ${effect.path.join('.')}.`);
          }
          append({
            type: 'state.changed',
            source: 'system',
            idempotencyKey: `effect:increment:${effect.path.join('.')}`,
            payload: {
              changes: [{ path: [...effect.path], value: currentValue + effect.amount }],
            },
          });
          break;
        }
        case 'emit-signal':
          this.assertSignalAudience(effect);
          append({
            type: 'signal.emitted',
            source: 'system',
            idempotencyKey: `effect:signal:${effect.signalKey}`,
            payload: {
              signalKey: effect.signalKey,
              recipients: [...effect.recipients],
              requiredKnowledgeScopes: [
                ...(this.definition.signals.find((candidate) => candidate.key === effect.signalKey)
                  ?.requiredKnowledgeScopes ?? []),
              ],
              ...(effect.payload === undefined ? {} : { payload: effect.payload }),
            },
          });
          sideEffects.push({
            type: 'notify-participants',
            payload: { signalKey: effect.signalKey, recipients: [...effect.recipients] },
          });
          break;
        case 'schedule-inject': {
          const state = getState();
          append({
            type: 'inject.scheduled',
            source: 'system',
            idempotencyKey: `effect:schedule:${effect.injectKey}`,
            payload: {
              scheduleId: `${effect.injectKey}:${state.run.latestSequence + 1}`,
              injectKey: effect.injectKey,
              dueAtMinute: state.run.virtualTimeMinutes + effect.delayMinutes,
            },
          });
          sideEffects.push({
            type: 'schedule-wakeup',
            payload: {
              runId: state.run.runId,
              dueAtMinute: state.run.virtualTimeMinutes + effect.delayMinutes,
            },
          });
          break;
        }
        case 'change-participant-status':
          append({
            type: 'participant.status_changed',
            source: 'system',
            participantId: effect.participantId,
            idempotencyKey: `effect:participant:${effect.participantId}`,
            payload: { participantId: effect.participantId, status: effect.status },
          });
          break;
        case 'record-metric':
          append({
            type: 'metric.recorded',
            source: 'system',
            idempotencyKey: `effect:metric:${effect.metricKey}`,
            payload: { metricKey: effect.metricKey, value: effect.value },
          });
          break;
        case 'complete-run':
          append({
            type: 'run.completed',
            source: 'system',
            idempotencyKey: 'effect:complete-run',
            payload: { reason: effect.reason },
          });
          break;
      }
    }
  }

  private runDueInjects(
    getState: () => SimulationState<TState>,
    append: (draft: EventDraft) => void,
    sideEffects: SideEffectIntent[],
  ): void {
    const maxIterations = this.definition.maxTriggerIterations ?? 100;
    let iteration = 0;

    const trigger = (inject: InjectDefinition<TState>, scheduleId?: string): void => {
      append({
        type: 'inject.triggered',
        source: 'system',
        idempotencyKey: `inject:${inject.key}:${scheduleId ?? 'condition'}`,
        payload: { injectKey: inject.key, ...(scheduleId === undefined ? {} : { scheduleId }) },
      });
      this.applyEffects(getState, inject.effects, append, sideEffects);
    };

    // 每个 Inject 最多触发一次；配合非零延迟 schedule，可排除零延迟互相触发造成的死循环。
    while (iteration < maxIterations) {
      const state = getState();
      if (this.isTerminal(state)) {
        return;
      }

      const dueSchedule = state.scheduledInjects
        .filter(
          (scheduled) =>
            scheduled.dueAtMinute <= state.run.virtualTimeMinutes &&
            !state.triggeredInjectKeys.includes(scheduled.injectKey),
        )
        .sort(
          (left, right) =>
            left.dueAtMinute - right.dueAtMinute || left.scheduleId.localeCompare(right.scheduleId),
        )[0];

      if (dueSchedule) {
        const inject = this.definition.injects.find(
          (candidate) => candidate.key === dueSchedule.injectKey,
        );
        if (!inject) {
          throw new Error(`Scheduled inject ${dueSchedule.injectKey} is not defined.`);
        }
        trigger(inject, dueSchedule.scheduleId);
        iteration += 1;
        continue;
      }

      const eligible = this.definition.injects.find(
        (inject) =>
          !getState().triggeredInjectKeys.includes(inject.key) &&
          inject.trigger !== undefined &&
          evaluateTrigger(inject.trigger, getState()),
      );
      if (!eligible) {
        return;
      }
      trigger(eligible);
      iteration += 1;
    }

    throw new Error(`Inject processing exceeded ${maxIterations} iterations.`);
  }

  private triggerInject(
    getState: () => SimulationState<TState>,
    inject: InjectDefinition<TState>,
    append: (draft: EventDraft) => void,
    sideEffects: SideEffectIntent[],
  ): void {
    append({
      type: 'inject.triggered',
      source: 'system',
      idempotencyKey: `inject:${inject.key}:manual`,
      payload: { injectKey: inject.key },
    });
    this.applyEffects(getState, inject.effects, append, sideEffects);
  }

  private recordActionRejection(
    state: SimulationState<TState>,
    command: RunCommand,
    context: KernelContext,
    events: DomainEvent[],
    sideEffects: SideEffectIntent[],
    code: ApplicationErrorCode,
    message: string,
  ): KernelResult<TState> {
    const event = this.createEvent(state, context, {
      type: 'action.rejected',
      source: eventSourceForActor(command.actor),
      idempotencyKey: command.idempotencyKey,
      causationId: command.commandId,
      correlationId: command.commandId,
      payload: {
        actionType:
          command.payload.type === 'submit-action' ? command.payload.actionType : undefined,
        reason: message,
        code,
      },
    });
    const nextState = this.applyEvent(state, event);
    events.push(event);
    return {
      state: nextState,
      events,
      sideEffects,
      evaluations: this.evaluate(nextState),
      status: 'rejected',
      rejection: { code, message },
    };
  }

  private reject(
    state: SimulationState<TState>,
    code: ApplicationErrorCode,
    message: string,
  ): KernelResult<TState> {
    return {
      state,
      events: [],
      sideEffects: [],
      evaluations: this.evaluate(state),
      status: 'rejected',
      rejection: { code, message },
    };
  }

  private isTerminal(state: SimulationState<TState>): boolean {
    return state.run.status === 'completed' || state.run.status === 'failed';
  }

  private assertValidState(state: SimulationState<TState>): void {
    this.definition.stateSchema.parse(state.world);
  }

  /**
   * Run Snapshot 以 JSON 形式长期保存。场景 schema 新增带默认值的字段后，
   * 历史 Snapshot 仍可能没有该字段；每次进入 Kernel 时统一使用 Zod 输出
   * 归一化 WorldState，确保默认值会回写到下一份权威运行状态。
   */
  private normalizeState(state: SimulationState<TState>): SimulationState<TState> {
    return {
      ...cloneState(state),
      world: this.definition.stateSchema.parse(state.world) as TState,
    };
  }

  private assertSignalAudience(effect: Extract<Effect, { kind: 'emit-signal' }>): void {
    const signal = this.definition.signals.find((candidate) => candidate.key === effect.signalKey);
    if (!signal) {
      throw new Error(`Signal ${effect.signalKey} is not defined.`);
    }

    for (const participantId of effect.recipients) {
      const participant = this.definition.participants.find(
        (candidate) => candidate.id === participantId,
      );
      if (!participant) {
        throw new Error(`Signal recipient ${participantId} is not defined.`);
      }
      if (!containsAll(participant.knowledgeScopes, signal.requiredKnowledgeScopes)) {
        throw new Error(`Signal ${signal.key} exceeds recipient ${participantId} knowledge scope.`);
      }
    }
  }
}

interface EventDraft {
  readonly type: string;
  readonly source: EventSource;
  readonly participantId?: string;
  readonly idempotencyKey: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly payload: unknown;
}

export function evaluateTrigger<TState>(
  trigger: Trigger<TState>,
  state: SimulationState<TState>,
): boolean {
  switch (trigger.kind) {
    case 'all':
      return trigger.conditions.every((condition) => evaluateTrigger(condition, state));
    case 'any':
      return trigger.conditions.some((condition) => evaluateTrigger(condition, state));
    case 'not':
      return !evaluateTrigger(trigger.condition, state);
    case 'elapsed-minutes-gte':
      return state.run.virtualTimeMinutes >= trigger.minutes;
    case 'state-equals':
      return Object.is(getValueAtPath(state.world, trigger.path), trigger.value);
    case 'state-number-gte': {
      const value = getValueAtPath(state.world, trigger.path);
      return typeof value === 'number' && value >= trigger.value;
    }
    case 'event-occurred':
      return (state.occurredEventTypes[trigger.eventType] ?? 0) > 0;
    case 'participant-action-count-gte':
      return (
        (state.actionCounts[actionCountKey(trigger.participantId, trigger.actionType)] ?? 0) >=
        trigger.count
      );
  }
}

/**
 * 这是提交动作前的唯一策略校验。Application 可用它筛掉当前无法执行的
 * Agent 建议动作，但不能据此执行任何动作；真正提交时 Kernel 仍会再次校验。
 */
export function getActionPolicyFailure<TState>(
  state: SimulationState<TState>,
  participant: RuntimeParticipant,
  action: ActionDefinition<TState>,
): KernelRejection | undefined {
  if (participant.status !== 'active') {
    return { code: 'ACTION_NOT_ALLOWED', message: 'Participant is not active.' };
  }
  if (!containsAll(participant.capabilities, action.requiredCapabilities)) {
    return { code: 'ACTION_NOT_ALLOWED', message: 'Participant lacks required capabilities.' };
  }
  if (!containsAll(participant.permissions, action.requiredPermissions)) {
    return { code: 'ACTION_NOT_ALLOWED', message: 'Participant lacks required permissions.' };
  }
  if (!containsAll(participant.knowledgeScopes, action.requiredKnowledgeScopes)) {
    return { code: 'ACTION_NOT_ALLOWED', message: 'Participant lacks required knowledge scope.' };
  }
  if (action.precondition && !evaluateTrigger(action.precondition, state)) {
    return { code: 'ACTION_NOT_ALLOWED', message: 'Action precondition is not satisfied.' };
  }
  return undefined;
}

function validateUniqueKeys(
  values: readonly { readonly key: string }[],
  label: string,
  errors: string[],
): void {
  const keys = new Set<string>();
  for (const value of values) {
    if (!value.key) {
      errors.push(`${label} key 不能为空。`);
      continue;
    }
    if (keys.has(value.key)) {
      errors.push(`${label} key 重复：${value.key}。`);
    }
    keys.add(value.key);
  }
}

function validateEffects<TState>(
  effects: readonly Effect[],
  initialState: TState,
  definition: ScenarioDefinition<TState>,
  owner: string,
  errors: string[],
): void {
  for (const effect of effects) {
    if (effect.kind === 'set-state' || effect.kind === 'increment-state') {
      validateStatePath(effect.path, initialState, `${owner} Effect`, errors);
      if (
        effect.kind === 'increment-state' &&
        typeof getValueAtPath(initialState, effect.path) !== 'number'
      ) {
        errors.push(`${owner} 的 increment-state 只能作用于 number State path。`);
      }
    }
    if (effect.kind === 'schedule-inject' && effect.delayMinutes <= 0) {
      errors.push(`${owner} 的 schedule-inject 延迟必须大于 0，避免零延迟循环。`);
    }
    if (
      effect.kind === 'schedule-inject' &&
      !definition.injects.some((inject) => inject.key === effect.injectKey)
    ) {
      errors.push(`${owner} 调度了未定义的 Inject：${effect.injectKey}。`);
    }
    if (effect.kind === 'change-participant-status') {
      if (!definition.participants.some((participant) => participant.id === effect.participantId)) {
        errors.push(`${owner} 引用了未定义的参与方：${effect.participantId}。`);
      }
    }
    if (effect.kind === 'emit-signal') {
      const signal = definition.signals.find((candidate) => candidate.key === effect.signalKey);
      if (!signal) {
        errors.push(`${owner} 发出了未定义的 Signal：${effect.signalKey}。`);
        continue;
      }
      for (const recipientId of effect.recipients) {
        const recipient = definition.participants.find(
          (participant) => participant.id === recipientId,
        );
        if (!recipient) {
          errors.push(`${owner} 向未定义的参与方发送 Signal：${recipientId}。`);
          continue;
        }
        if (!containsAll(recipient.knowledgeScopes, signal.requiredKnowledgeScopes)) {
          errors.push(`${owner} 向 Knowledge Scope 不足的参与方发送 Signal：${recipientId}。`);
        }
      }
    }
  }
}

function validateTrigger<TState>(
  trigger: Trigger<TState> | undefined,
  initialState: TState,
  owner: string,
  errors: string[],
): void {
  if (!trigger) {
    return;
  }
  switch (trigger.kind) {
    case 'all':
    case 'any':
      trigger.conditions.forEach((condition) =>
        validateTrigger(condition, initialState, owner, errors),
      );
      return;
    case 'not':
      validateTrigger(trigger.condition, initialState, owner, errors);
      return;
    case 'state-equals':
    case 'state-number-gte':
      validateStatePath(trigger.path, initialState, `${owner} Trigger`, errors);
      return;
    default:
      return;
  }
}

function validateStatePath(
  path: StatePath | undefined,
  state: unknown,
  owner: string,
  errors: string[],
): void {
  if (path === undefined) {
    return;
  }
  if (path.length === 0 || path.some((part) => !isSafePathPart(part))) {
    errors.push(`${owner} 包含不安全或为空的 State path。`);
    return;
  }
  if (!hasPath(state, path)) {
    errors.push(`${owner} 引用了不存在的 State path：${path.join('.')}。`);
  }
}

function eventSourceForActor(actor: ActorRef): EventSource {
  if (actor.type === 'agent') {
    return 'agent';
  }
  if (actor.type === 'system') {
    return 'system';
  }
  return 'human';
}

function containsAll(
  available: readonly string[],
  required: readonly string[] | undefined,
): boolean {
  return required === undefined || required.every((value) => available.includes(value));
}

function actionCountKey(participantId: string, actionType: string): string {
  return `${participantId}:${actionType}`;
}

function appendUnique(values: readonly string[], value: string | undefined): readonly string[] {
  if (value === undefined || values.includes(value)) {
    return values;
  }
  return [...values, value];
}

function incrementRecord(
  values: Readonly<Record<string, number>>,
  key: string,
): Readonly<Record<string, number>> {
  return { ...values, [key]: (values[key] ?? 0) + 1 };
}

function cloneState<TState>(state: SimulationState<TState>): SimulationState<TState> {
  return structuredClone(state);
}

function getValueAtPath(value: unknown, path: StatePath): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function hasPath(value: unknown, path: StatePath): boolean {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function setValueAtPath<TState>(value: TState, path: StatePath, nextValue: unknown): TState {
  if (path.length === 0 || path.some((part) => !isSafePathPart(part))) {
    throw new Error('Invalid state path.');
  }
  const root = structuredClone(value) as unknown;
  if (!isRecord(root)) {
    throw new Error('WorldState must be an object.');
  }

  let current: Record<string, unknown> = root;
  for (const part of path.slice(0, -1)) {
    const child = current[part];
    if (!isRecord(child)) {
      throw new Error(`State path ${path.join('.')} does not exist.`);
    }
    current = child;
  }

  const last = path[path.length - 1];
  if (last === undefined || !Object.hasOwn(current, last)) {
    throw new Error(`State path ${path.join('.')} does not exist.`);
  }
  current[last] = nextValue;
  return root as TState;
}

function isSafePathPart(part: string): boolean {
  return part.length > 0 && part !== '__proto__' && part !== 'prototype' && part !== 'constructor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Event payload must be an object.');
  }
  return value;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected object payload field ${key}.`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string payload field ${key}.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected optional string payload field ${key}.`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected number payload field ${key}.`);
  }
  return value;
}

function readParticipantStatus(record: Record<string, unknown>, key: string): ParticipantStatus {
  const value = readString(record, key);
  if (value !== 'active' && value !== 'inactive' && value !== 'blocked') {
    throw new Error(`Expected participant status payload field ${key}.`);
  }
  return value;
}

function addMinutes(isoTimestamp: string, minutes: number): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    throw new Error('Invalid simulated timestamp.');
  }
  return new Date(timestamp + minutes * 60_000).toISOString();
}
