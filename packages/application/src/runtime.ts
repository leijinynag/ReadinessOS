import { createHash, randomUUID } from 'node:crypto';
import {
  ApplicationError,
  domainEventSchema,
  type ActorRef,
  type CommandEnvelope,
  type DomainEvent,
} from '@readinessos/domain-events';
import type { ScenarioPack } from '@readinessos/scenario-sdk';
import {
  SimulationKernel,
  type CreateRunInput,
  type Effect,
  type KernelResult,
  type RunCommand,
  type SimulationState,
  type Trigger,
} from '@readinessos/simulation-kernel';
import { ApprovalStatus, EventSource, Prisma, PrismaClient, RunStatus } from '@prisma/client';
import { z } from 'zod';
import type { RunScheduler } from './agent-runtime';

export const streamEnvelopeSchema = z.object({
  cursor: z.number().int().positive(),
  event: domainEventSchema,
});
export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

const stateSnapshotSchemaVersion = 2;
const approvalTtlMilliseconds = 15 * 60 * 1_000;

const scenarioVersionConfigSchema = z
  .object({
    packKey: z.string().min(1),
    tickIntervalSeconds: z.number().int().min(1).max(3_600).optional(),
    participants: z
      .array(
        z.object({
          id: z.string().uuid(),
          enabled: z.boolean(),
          controller: z.enum(['human', 'agent', 'system']),
        }),
      )
      .optional(),
  })
  .passthrough();
type ScenarioVersionRuntimeConfig = z.infer<typeof scenarioVersionConfigSchema>;

const outboxEventPayloadSchema = z.object({
  cursor: z.number().int().positive(),
  event: domainEventSchema,
});

const persistedSimulationStateSchema = z
  .object({
    run: z.object({
      organizationId: z.string().uuid(),
      runId: z.string().uuid(),
      status: z.enum(['created', 'running', 'paused', 'completed', 'failed']),
      seed: z.number().int(),
      version: z.number().int().nonnegative(),
      latestSequence: z.number().int().nonnegative(),
      virtualTimeMinutes: z.number().int().nonnegative(),
      simulatedAt: z.string().datetime(),
      appliedCommandIds: z.array(z.string().uuid()),
      appliedIdempotencyKeys: z.array(z.string().min(1)),
    }),
    world: z.unknown(),
    participants: z.record(z.string().uuid(), z.unknown()),
    scheduledInjects: z.array(z.unknown()),
    triggeredInjectKeys: z.array(z.string()),
    pendingApprovals: z.record(z.string(), z.unknown()),
    actionCounts: z.record(z.string(), z.number().int().nonnegative()),
    occurredEventTypes: z.record(z.string(), z.number().int().nonnegative()),
    metrics: z.record(z.string(), z.number()),
  })
  .passthrough();

export type RunSummary = {
  id: string;
  organizationId: string;
  scenarioVersionId: string;
  status: RunStatus;
  version: number;
  seed: number;
  virtualTime: number;
  latestSequence: number;
  schedulerGeneration: number;
  nextTickIndex: number;
  tickIntervalSeconds: number;
  startedAt: string | undefined;
  completedAt: string | undefined;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
};

export type ApprovalSummary = {
  id: string;
  actionType: string;
  participantId: string;
  requestedSequence: number;
  parameters: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | undefined;
  resolvedById: string | undefined;
  resolutionSequence: number | undefined;
  evidence: readonly {
    id: string;
    sequence: number;
    eventType: string;
    label: string;
    data: Record<string, unknown>;
  }[];
};

export type ReviewSummary = {
  run: RunSummary;
  timeline: readonly {
    sequence: number;
    type: string;
    source: EventSource;
    simulatedAt: string;
    payload: Record<string, unknown>;
  }[];
  approvals: readonly ApprovalSummary[];
  decisions: readonly {
    id: string;
    sequence: number;
    decision: string;
    approvalId: string | undefined;
    actorName: string | undefined;
    createdAt: string;
  }[];
  evaluations: readonly {
    id: string;
    evaluatorKey: string;
    sequence: number;
    score: number;
    summary: string;
    evidence: readonly {
      id: string;
      sequence: number;
      eventType: string;
      label: string;
    }[];
  }[];
  remediationItems: readonly {
    id: string;
    evaluationId: string | undefined;
    title: string;
    description: string;
    status: 'open' | 'in_progress' | 'resolved';
    dueAt: string | undefined;
    updatedAt: string;
  }[];
  checkpoints: readonly { sequence: number; label: string; createdAt: string }[];
  branch: {
    parentRunId: string | undefined;
    branchFromSequence: number | undefined;
    childRunIds: readonly string[];
    comparison:
      | {
          parentRunId: string;
          branchRunId: string;
          branchFromSequence: number;
          virtualTime: { parent: number; branch: number; delta: number };
          eventCounts: { parentAfterBranch: number; branch: number };
          significantEvents: readonly {
            type: string;
            parentCount: number;
            branchCount: number;
          }[];
          evaluationChanges: readonly {
            evaluatorKey: string;
            parentScore: number | undefined;
            branchScore: number | undefined;
            delta: number | undefined;
          }[];
          status: { parent: RunStatus; branch: RunStatus };
        }
      | undefined;
  };
};

export type ReplaySummary = {
  sequence: number;
  source: 'snapshot' | 'full';
  state: Record<string, unknown>;
};

export type CreateRunRequest = {
  organizationId: string;
  scenarioVersionId: string;
  createdById: string;
  idempotencyKey: string;
  seed: number;
  simulatedAt: string;
  tickIntervalSeconds?: number;
};

export type CreateBranchRequest = {
  parentRunId: string;
  organizationId: string;
  createdById: string;
  idempotencyKey: string;
  expectedParentRunVersion: number;
  branchFromSequence: number;
  name: string;
};

export type CommandExecution<TState = unknown> = {
  result: KernelResult<TState>;
  scheduler: SchedulerInstruction | undefined;
};

export type SchedulerInstruction =
  | {
      type: 'start';
      runId: string;
      generation: number;
      intervalSeconds: number;
      firstTickIndex: number;
    }
  | {
      type: 'cancel';
      runId: string;
      generation: number;
    };

export const runScheduleLeaseTtlMilliseconds = 180_000;

export type RunScheduleLeaseClaim = {
  runId: string;
  organizationId: string;
  generation: number;
  intervalSeconds: number;
  firstTickIndex: number;
  holderId: string;
};

export type RunScheduleClaimResult =
  | { status: 'claimed'; lease: RunScheduleLeaseClaim }
  | { status: 'active' }
  | { status: 'ineligible' };

export type ScheduledTick = {
  generation: number;
  tickIndex: number;
  holderId: string;
};

export type ClaimedOutboxMessage = {
  id: string;
  organizationId: string;
  runId: string | null;
  topic: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
};

export interface ScenarioPackRegistry {
  get(key: string): ScenarioPack<unknown> | undefined;
}

/**
 * 将已发布版本中的参与方选择收敛成运行时 Pack。版本 config 是静态 Pack 的
 * 受限派生数据，不能借此注入能力、权限、知识范围或显示名称。
 */
export function specializeScenarioPack<TState>(
  pack: ScenarioPack<TState>,
  config: ScenarioVersionRuntimeConfig,
): ScenarioPack<TState> {
  if (config.participants === undefined) {
    // W3 和早期版本没有 Studio 参与方配置，必须保持原 Pack 语义。
    return pack;
  }

  const participantOverrides = config.participants;
  const overrides = new Map<string, (typeof config.participants)[number]>();
  const knownParticipantIds = new Set(pack.participants.map((participant) => participant.id));
  for (const participant of participantOverrides) {
    if (!knownParticipantIds.has(participant.id)) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `Scenario version references an unknown participant: ${participant.id}.`,
      );
    }
    if (overrides.has(participant.id)) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `Scenario version contains a duplicate participant: ${participant.id}.`,
      );
    }
    overrides.set(participant.id, participant);
  }

  // 有 participants 字段时，它是该版本的完整参与方选择。Studio 停用的
  // 参与方不会写入新版本，因此未出现的静态参与方也必须排除。
  const enabledIds = new Set(
    participantOverrides
      .filter((participant) => participant.enabled)
      .map((participant) => participant.id),
  );
  const participants = pack.participants
    .filter((participant) => enabledIds.has(participant.id))
    .map((participant) => ({
      ...participant,
      controller: overrides.get(participant.id)?.controller ?? participant.controller,
    }));

  const actions = pack.actions
    .filter((action) => !triggerReferencesDisabledParticipant(action.precondition, enabledIds))
    .map((action) => ({
      ...action,
      effects: filterParticipantEffects(action.effects, enabledIds),
    }));
  const injectsWithoutDisabledTriggers = pack.injects
    .filter((inject) => !triggerReferencesDisabledParticipant(inject.trigger, enabledIds))
    .map((inject) => ({
      ...inject,
      effects: filterParticipantEffects(inject.effects, enabledIds),
    }));
  const enabledInjectKeys = new Set(injectsWithoutDisabledTriggers.map((inject) => inject.key));
  const filterMissingInjectSchedules = (effects: readonly Effect[]) =>
    effects.filter(
      (effect) => effect.kind !== 'schedule-inject' || enabledInjectKeys.has(effect.injectKey),
    );

  return {
    ...pack,
    participants,
    actions: actions.map((action) => ({
      ...action,
      effects: filterMissingInjectSchedules(action.effects),
    })),
    injects: injectsWithoutDisabledTriggers.map((inject) => ({
      ...inject,
      effects: filterMissingInjectSchedules(inject.effects),
    })),
  };
}

/**
 * 运行时只通过 Registry 查找 Pack。Application 不导入任何具体场景，
 * 保持场景包、数据库和 Web 框架之间的单向依赖。
 */
export class InMemoryScenarioPackRegistry implements ScenarioPackRegistry {
  private readonly packs = new Map<string, ScenarioPack<unknown>>();

  constructor(packs: readonly ScenarioPack<unknown>[]) {
    for (const pack of packs) {
      this.packs.set(pack.key, pack);
    }
  }

  get(key: string): ScenarioPack<unknown> | undefined {
    return this.packs.get(key);
  }
}

/**
 * 进程内 Hub 仅优化实时性，绝不承担可靠事件存储职责。
 * 客户端的权威 Cursor 永远来自 run_events。
 */
export class RunEventHub {
  private readonly listeners = new Map<string, Set<(envelope: StreamEnvelope) => void>>();

  publish(envelope: StreamEnvelope): void {
    const runListeners = this.listeners.get(envelope.event.runId);
    if (!runListeners) {
      return;
    }

    for (const listener of runListeners) {
      listener(envelope);
    }
  }

  subscribe(runId: string, listener: (envelope: StreamEnvelope) => void): () => void {
    const runListeners = this.listeners.get(runId) ?? new Set<(envelope: StreamEnvelope) => void>();
    runListeners.add(listener);
    this.listeners.set(runId, runListeners);

    return () => {
      runListeners.delete(listener);
      if (runListeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }
}

export class PrismaRunRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly snapshotInterval = 100,
  ) {}

  async createRun<TState>(
    request: CreateRunRequest,
    pack: ScenarioPack<TState>,
  ): Promise<RunSummary> {
    const runId = randomUUID();
    const recordedAt = new Date().toISOString();
    const kernel = new SimulationKernel(pack);

    try {
      return await this.client.$transaction(async (tx) => {
        // 创建请求没有 CommandEnvelope，使用调用方提供的 key 作为同一用户、
        // 同一组织下的幂等边界，网络重试不会生成第二条演练记录。
        const existingRun = await tx.simulationRun.findFirst({
          where: {
            organizationId: request.organizationId,
            createdById: request.createdById,
            createIdempotencyKey: request.idempotencyKey,
          },
          select: {
            id: true,
          },
        });
        if (existingRun) {
          return toRunSummary(await this.requireRun(tx, existingRun.id, request.organizationId));
        }

        const scenarioVersion = await tx.scenarioVersion.findFirst({
          where: {
            id: request.scenarioVersionId,
            scenario: {
              organizationId: request.organizationId,
            },
          },
          select: {
            config: true,
          },
        });

        if (!scenarioVersion) {
          throw new ApplicationError(
            'NOT_FOUND',
            'Scenario version was not found for this organization.',
          );
        }

        const config = parseScenarioVersionConfig(scenarioVersion.config);
        if (config.packKey !== pack.key) {
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'Scenario version does not match the selected pack.',
          );
        }

        const tickIntervalSeconds = request.tickIntervalSeconds ?? config.tickIntervalSeconds ?? 15;
        const createdRun = await tx.simulationRun.create({
          data: {
            id: runId,
            organizationId: request.organizationId,
            scenarioVersionId: request.scenarioVersionId,
            createdById: request.createdById,
            createIdempotencyKey: request.idempotencyKey,
            seed: request.seed,
            tickIntervalSeconds,
          },
        });

        const input: CreateRunInput = {
          organizationId: request.organizationId,
          runId,
          seed: request.seed,
          config: jsonRecord(scenarioVersion.config),
          simulatedAt: request.simulatedAt,
        };
        const result = kernel.createRun(input, createKernelContext(recordedAt));
        await tx.runParticipant.createMany({
          data: pack.participants.map((participant) => ({
            runId,
            key: participant.key,
            displayName: participant.displayName,
            controller: participant.controller,
            capabilities: toInputJson(participant.capabilities),
            permissions: toInputJson(participant.permissions),
            objectives: toInputJson(participant.objectives),
            knowledgeScopes: toInputJson(participant.knowledgeScopes),
          })),
        });

        const participants = await tx.runParticipant.findMany({
          where: { runId },
          select: { id: true, key: true },
        });
        await tx.participantProjection.createMany({
          data: participants.map((participant) => {
            const runtimeParticipant = Object.values(result.state.participants).find(
              (candidate) => candidate.key === participant.key,
            );
            return {
              runParticipantId: participant.id,
              runId,
              status: runtimeParticipant?.status ?? 'inactive',
              data: toInputJson(runtimeParticipant ?? {}),
            };
          }),
        });

        // `run.created` 也是权威事件，Run 行必须在同一事务里同步到它的 sequence。
        const persistedRun = await tx.simulationRun.update({
          where: { id: createdRun.id },
          data: {
            latestSequence: result.state.run.latestSequence,
            virtualTime: result.state.run.virtualTimeMinutes,
          },
        });

        await this.writeEventsAndProjections(tx, persistedRun, result, {
          forceSnapshot: true,
          scheduler: undefined,
        });

        return toRunSummary(await this.requireRun(tx, runId, request.organizationId));
      });
    } catch (error) {
      // 并发的同一创建请求都可能在首次查询时尚未看到对方。唯一索引
      // 是最终裁决；命中后读取已提交的 Run 并返回同一结果。
      if (!isCreateIdempotencyConflict(error)) {
        throw error;
      }

      const existingRun = await this.client.simulationRun.findFirst({
        where: {
          organizationId: request.organizationId,
          createdById: request.createdById,
          createIdempotencyKey: request.idempotencyKey,
        },
        select: { id: true },
      });
      if (!existingRun) {
        throw error;
      }
      return toRunSummary(
        await this.requireRun(this.client, existingRun.id, request.organizationId),
      );
    }
  }

  async createBranchRun<TState>(
    request: CreateBranchRequest,
    pack: ScenarioPack<TState>,
  ): Promise<RunSummary> {
    const childRunId = randomUUID();
    const recordedAt = new Date().toISOString();
    const kernel = new SimulationKernel(pack);

    try {
      return await this.client.$transaction(async (tx) => {
        await lockRun(tx, request.parentRunId, request.organizationId);
        const parent = await this.requireRun(tx, request.parentRunId, request.organizationId);
        if (parent.version !== request.expectedParentRunVersion) {
          throw new ApplicationError(
            'RUN_VERSION_CONFLICT',
            'The parent run changed before the branch could be created.',
          );
        }
        if (
          !Number.isInteger(request.branchFromSequence) ||
          request.branchFromSequence < 1 ||
          request.branchFromSequence > parent.latestSequence
        ) {
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'Branch sequence must point to a persisted parent event.',
          );
        }

        const existingBranch = await tx.simulationRun.findFirst({
          where: {
            organizationId: request.organizationId,
            createdById: request.createdById,
            createIdempotencyKey: request.idempotencyKey,
          },
          select: { id: true },
        });
        if (existingBranch) {
          return toRunSummary(await this.requireRun(tx, existingBranch.id, request.organizationId));
        }

        const config = jsonRecord(parent.scenarioVersion.config);
        const parentState = await this.loadStateAtSequence(
          tx,
          parent,
          kernel,
          config,
          request.branchFromSequence,
        );
        await this.writeStateSnapshot(tx, parent.id, request.branchFromSequence, parentState);
        const child = await tx.simulationRun.create({
          data: {
            id: childRunId,
            organizationId: request.organizationId,
            scenarioVersionId: parent.scenarioVersionId,
            parentRunId: parent.id,
            branchFromSequence: request.branchFromSequence,
            createdById: request.createdById,
            createIdempotencyKey: request.idempotencyKey,
            seed: parent.seed,
            tickIntervalSeconds: parent.tickIntervalSeconds,
          },
        });
        const input: CreateRunInput = {
          organizationId: request.organizationId,
          runId: childRunId,
          seed: parent.seed,
          config,
          simulatedAt: parentState.run.simulatedAt,
        };
        const childResult = kernel.createBranchRun(
          input,
          parentState,
          createKernelContext(recordedAt),
        );
        await tx.runParticipant.createMany({
          data: pack.participants.map((participant) => ({
            runId: childRunId,
            key: participant.key,
            displayName: participant.displayName,
            controller: participant.controller,
            capabilities: toInputJson(participant.capabilities),
            permissions: toInputJson(participant.permissions),
            objectives: toInputJson(participant.objectives),
            knowledgeScopes: toInputJson(participant.knowledgeScopes),
          })),
        });
        const participants = await tx.runParticipant.findMany({
          where: { runId: childRunId },
          select: { id: true, key: true },
        });
        await tx.participantProjection.createMany({
          data: participants.map((participant) => {
            const runtimeParticipant = Object.values(childResult.state.participants).find(
              (candidate) => candidate.key === participant.key,
            );
            return {
              runParticipantId: participant.id,
              runId: childRunId,
              status: runtimeParticipant?.status ?? 'inactive',
              data: toInputJson(runtimeParticipant ?? {}),
            };
          }),
        });
        const persistedChild = await tx.simulationRun.update({
          where: { id: child.id },
          data: {
            latestSequence: childResult.state.run.latestSequence,
            virtualTime: childResult.state.run.virtualTimeMinutes,
          },
        });
        await this.writeEventsAndProjections(tx, persistedChild, childResult, {
          forceSnapshot: true,
          scheduler: undefined,
        });

        // 分支前写入父状态 Snapshot，确保审计事件与分支基线位于同一事务。
        const parentBranchResult = kernel.execute(
          await this.loadState(tx, parent, kernel, config),
          {
            commandId: randomUUID(),
            organizationId: request.organizationId,
            runId: parent.id,
            actor: {
              id: request.createdById,
              type: 'user',
              organizationId: request.organizationId,
            },
            expectedRunVersion: parent.version,
            idempotencyKey: `branch:${childRunId}`,
            issuedAt: recordedAt,
            payload: {
              type: 'create-branch',
              name: request.name,
              childRunId,
              branchFromSequence: request.branchFromSequence,
            },
          },
          createKernelContext(recordedAt),
        );
        if (parentBranchResult.status !== 'accepted') {
          throw new ApplicationError(
            'INTERNAL_ERROR',
            'The parent branch audit event was rejected.',
          );
        }
        const parentUpdate = await tx.simulationRun.updateMany({
          where: { id: parent.id, version: parent.version },
          data: createRunUpdateData(parent, parentBranchResult, undefined, undefined),
        });
        if (parentUpdate.count !== 1) {
          throw new ApplicationError(
            'RUN_VERSION_CONFLICT',
            'The parent run changed before the branch could be recorded.',
          );
        }
        await this.writeEventsAndProjections(
          tx,
          {
            ...parent,
            status: parentBranchResult.state.run.status,
            version: parentBranchResult.state.run.version,
            latestSequence: parentBranchResult.state.run.latestSequence,
            virtualTime: parentBranchResult.state.run.virtualTimeMinutes,
          },
          parentBranchResult,
          { forceSnapshot: true, scheduler: undefined },
        );

        return toRunSummary(await this.requireRun(tx, childRunId, request.organizationId));
      });
    } catch (error) {
      if (!isCreateIdempotencyConflict(error)) {
        throw error;
      }
      const existingBranch = await this.client.simulationRun.findFirst({
        where: {
          organizationId: request.organizationId,
          createdById: request.createdById,
          createIdempotencyKey: request.idempotencyKey,
        },
        select: { id: true },
      });
      if (!existingBranch) throw error;
      return toRunSummary(
        await this.requireRun(this.client, existingBranch.id, request.organizationId),
      );
    }
  }

  async execute<TState>(
    command: RunCommand,
    pack: ScenarioPack<TState>,
    scheduledTick?: ScheduledTick,
  ): Promise<CommandExecution<TState>> {
    return this.client.$transaction(async (tx) => {
      if (scheduledTick) {
        await lockRun(tx, command.runId, command.organizationId);
      }
      const run = await this.requireRun(tx, command.runId, command.organizationId);
      const kernel = new SimulationKernel(pack);

      if (scheduledTick) {
        if (
          run.status !== 'running' ||
          run.schedulerGeneration !== scheduledTick.generation ||
          run.nextTickIndex + 1 !== scheduledTick.tickIndex
        ) {
          return {
            result: createNoopKernelResult(
              await this.loadState(tx, run, kernel, jsonRecord(run.scenarioVersion.config)),
            ),
            scheduler: undefined,
          };
        }
      }

      if (scheduledTick) {
        const lease = await tx.runScheduleLease.findFirst({
          where: {
            runId: run.id,
            organizationId: run.organizationId,
            generation: scheduledTick.generation,
            holderId: scheduledTick.holderId,
            expiresAt: { gt: new Date() },
          },
          select: { runId: true },
        });
        if (!lease) {
          return {
            result: createNoopKernelResult(
              await this.loadState(tx, run, kernel, jsonRecord(run.scenarioVersion.config)),
            ),
            scheduler: undefined,
          };
        }
      }

      const alreadyApplied = await tx.runEvent.findUnique({
        where: {
          runId_idempotencyKey: {
            runId: command.runId,
            idempotencyKey: command.idempotencyKey,
          },
        },
        select: { id: true },
      });
      const state = await this.loadState(tx, run, kernel, jsonRecord(run.scenarioVersion.config));

      if (alreadyApplied) {
        return {
          result: createDuplicateKernelResult(state, kernel),
          scheduler: undefined,
        };
      }

      const result = kernel.execute(state, command, createKernelContext(new Date().toISOString()));
      if (result.events.length === 0) {
        return { result, scheduler: undefined };
      }

      const scheduler = deriveSchedulerInstruction(run, result, scheduledTick);
      const updateData = createRunUpdateData(run, result, scheduler, scheduledTick);
      const versionUpdate = await tx.simulationRun.updateMany({
        where: {
          id: run.id,
          version: command.expectedRunVersion,
        },
        data: updateData,
      });

      if (versionUpdate.count !== 1) {
        throw new ApplicationError(
          'RUN_VERSION_CONFLICT',
          'The run changed before this command could be committed.',
        );
      }

      // `updateMany` 的输入允许 Prisma 字段操作对象，不能反向当作已持久化实体展开。
      // 投影只依赖这些确定的标量字段，因此在这里显式构造提交后的 Run 视图。
      const updatedRun = {
        id: run.id,
        organizationId: run.organizationId,
        status: result.state.run.status,
        version: result.state.run.version,
        latestSequence: result.state.run.latestSequence,
        virtualTime: result.state.run.virtualTimeMinutes,
        schedulerGeneration:
          scheduler === undefined ? run.schedulerGeneration : scheduler.generation,
        nextTickIndex: scheduledTick?.tickIndex ?? run.nextTickIndex,
        tickIntervalSeconds: run.tickIntervalSeconds,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
      await this.writeEventsAndProjections(tx, updatedRun, result, {
        forceSnapshot: shouldForceSnapshot(result.events),
        scheduler,
      });

      return { result, scheduler };
    });
  }

  async getRun(runId: string, organizationId: string): Promise<RunSummary> {
    const run = await this.requireRun(this.client, runId, organizationId);
    const overview = await this.client.runOverviewProjection.findUnique({
      where: { runId },
      select: { data: true },
    });
    return {
      ...toRunSummary(run),
      data: overview ? jsonRecord(overview.data) : {},
    };
  }

  async getRunPackKey(runId: string, organizationId: string): Promise<string> {
    return (await this.getRunScenarioVersionConfig(runId, organizationId)).packKey;
  }

  async listApprovals(runId: string, organizationId: string): Promise<readonly ApprovalSummary[]> {
    await this.requireRun(this.client, runId, organizationId);
    const approvals = await this.client.approval.findMany({
      where: { runId },
      include: { evidences: { orderBy: { sequence: 'asc' } } },
      orderBy: { requestedSequence: 'desc' },
    });
    return approvals.map((approval) => ({
      id: approval.id,
      actionType: approval.actionType,
      participantId: approval.participantId,
      requestedSequence: approval.requestedSequence,
      parameters: jsonRecordOrEmpty(approval.parameters),
      status: approval.status,
      requestedAt: approval.requestedAt.toISOString(),
      expiresAt: approval.expiresAt.toISOString(),
      resolvedAt: approval.resolvedAt?.toISOString(),
      resolvedById: approval.resolvedById ?? undefined,
      resolutionSequence: approval.resolutionSequence ?? undefined,
      evidence: approval.evidences.map((evidence) => ({
        id: evidence.id,
        sequence: evidence.sequence,
        eventType: evidence.eventType,
        label: evidence.label,
        data: jsonRecordOrEmpty(evidence.data),
      })),
    }));
  }

  async getApproval(
    runId: string,
    organizationId: string,
    approvalId: string,
  ): Promise<ApprovalSummary> {
    const approval = (await this.listApprovals(runId, organizationId)).find(
      (candidate) => candidate.id === approvalId,
    );
    if (!approval) {
      throw new ApplicationError('NOT_FOUND', 'Approval was not found for this run.');
    }
    return approval;
  }

  async getReview(runId: string, organizationId: string): Promise<ReviewSummary> {
    const [
      run,
      overview,
      timeline,
      approvals,
      decisions,
      evaluations,
      remediationItems,
      checkpoints,
      branches,
    ] = await Promise.all([
      this.requireRun(this.client, runId, organizationId),
      this.client.runOverviewProjection.findUnique({ where: { runId }, select: { data: true } }),
      this.client.runEvent.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, type: true, source: true, simulatedAt: true, payload: true },
      }),
      this.listApprovals(runId, organizationId),
      this.client.decision.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
      }),
      this.client.evaluation.findMany({
        where: { runId },
        include: { evidences: { orderBy: { sequence: 'asc' } } },
        orderBy: [{ sequence: 'desc' }, { evaluatorKey: 'asc' }],
      }),
      this.client.remediationItem.findMany({
        where: { runId },
        orderBy: { updatedAt: 'desc' },
      }),
      this.client.checkpoint.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
      }),
      this.client.simulationRun.findMany({
        where: { parentRunId: runId },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const comparison =
      run.parentRunId === null || run.branchFromSequence === null
        ? undefined
        : await this.getBranchComparison(run, run.parentRunId, run.branchFromSequence);
    return {
      run: {
        ...toRunSummary(run),
        data: overview ? jsonRecordOrEmpty(overview.data) : {},
      },
      timeline: timeline.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        source: event.source,
        simulatedAt: event.simulatedAt.toISOString(),
        payload: jsonRecordOrEmpty(event.payload),
      })),
      approvals,
      decisions: decisions.map((decision) => ({
        id: decision.id,
        sequence: decision.sequence,
        decision: decision.decision,
        approvalId: decision.approvalId ?? undefined,
        actorName: decision.actorName ?? undefined,
        createdAt: decision.createdAt.toISOString(),
      })),
      evaluations: evaluations.map((evaluation) => ({
        id: evaluation.id,
        evaluatorKey: evaluation.evaluatorKey,
        sequence: evaluation.sequence,
        score: evaluation.score,
        summary: evaluation.summary,
        evidence: evaluation.evidences.map((evidence) => ({
          id: evidence.id,
          sequence: evidence.sequence,
          eventType: evidence.eventType,
          label: evidence.label,
        })),
      })),
      remediationItems: remediationItems.map((item) => ({
        id: item.id,
        evaluationId: item.evaluationId ?? undefined,
        title: item.title,
        description: item.description,
        status: item.status,
        dueAt: item.dueAt?.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      checkpoints: checkpoints.map((checkpoint) => ({
        sequence: checkpoint.sequence,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt.toISOString(),
      })),
      branch: {
        parentRunId: run.parentRunId ?? undefined,
        branchFromSequence: run.branchFromSequence ?? undefined,
        childRunIds: branches.map((branch) => branch.id),
        comparison,
      },
    };
  }

  async getReplay(
    runId: string,
    organizationId: string,
    targetSequence: number | undefined,
    pack: ScenarioPack<unknown>,
  ): Promise<ReplaySummary> {
    const run = await this.requireRun(this.client, runId, organizationId);
    const sequence = Math.min(
      Math.max(targetSequence ?? run.latestSequence, 0),
      run.latestSequence,
    );
    const snapshot = await this.client.stateSnapshot.findFirst({
      where: { runId, sequence: { lte: sequence } },
      orderBy: { sequence: 'desc' },
    });
    const persistedSnapshot = snapshot
      ? parsePersistedSimulationState(
          snapshot.state,
          snapshot.checksum,
          snapshot.schemaVersion,
          snapshot.sequence,
        )
      : undefined;
    const kernel = new SimulationKernel(pack);
    const initial = persistedSnapshot
      ? persistedSnapshot.state
      : kernel.initialize({
          organizationId: run.organizationId,
          runId: run.id,
          seed: run.seed,
          config: jsonRecord(run.scenarioVersion.config),
          simulatedAt: run.createdAt.toISOString(),
        });
    const events = await this.client.runEvent.findMany({
      where: {
        runId,
        sequence: { gt: persistedSnapshot?.sequence ?? 0, lte: sequence },
      },
      orderBy: { sequence: 'asc' },
    });
    const state = kernel.replay(initial, events.map(fromDatabaseEvent));
    return {
      sequence,
      source: persistedSnapshot ? 'snapshot' : 'full',
      state: toInputJson(state) as unknown as Record<string, unknown>,
    };
  }

  async createRemediationItem(input: {
    runId: string;
    organizationId: string;
    evaluationId?: string;
    title: string;
    description: string;
    dueAt?: Date;
  }) {
    await this.requireRun(this.client, input.runId, input.organizationId);
    if (input.evaluationId) {
      const evaluation = await this.client.evaluation.findFirst({
        where: { id: input.evaluationId, runId: input.runId },
        select: { id: true },
      });
      if (!evaluation) {
        throw new ApplicationError('NOT_FOUND', 'Evaluation was not found for this run.');
      }
    }
    return this.client.remediationItem.create({
      data: {
        runId: input.runId,
        evaluationId: input.evaluationId ?? null,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt ?? null,
      },
    });
  }

  async updateRemediationItem(
    runId: string,
    organizationId: string,
    itemId: string,
    status: 'open' | 'in_progress' | 'resolved',
  ) {
    await this.requireRun(this.client, runId, organizationId);
    const updated = await this.client.remediationItem.updateMany({
      where: { id: itemId, runId },
      data: { status },
    });
    if (updated.count !== 1) {
      throw new ApplicationError('NOT_FOUND', 'Remediation item was not found for this run.');
    }
  }

  async markApprovalStale(
    runId: string,
    organizationId: string,
    approvalId: string,
  ): Promise<void> {
    await this.client.approval.updateMany({
      where: {
        id: approvalId,
        runId,
        run: { organizationId },
        status: 'pending',
      },
      data: { status: 'stale', resolvedAt: new Date() },
    });
  }

  async getRunScenarioVersionConfig(
    runId: string,
    organizationId: string,
  ): Promise<ScenarioVersionRuntimeConfig> {
    const run = await this.requireRun(this.client, runId, organizationId);
    return parseScenarioVersionConfig(run.scenarioVersion.config);
  }

  async getScenarioVersionPackKey(
    scenarioVersionId: string,
    organizationId: string,
  ): Promise<string> {
    return (await this.getScenarioVersionConfig(scenarioVersionId, organizationId)).packKey;
  }

  async getScenarioVersionConfig(
    scenarioVersionId: string,
    organizationId: string,
  ): Promise<ScenarioVersionRuntimeConfig> {
    const scenarioVersion = await this.client.scenarioVersion.findFirst({
      where: {
        id: scenarioVersionId,
        scenario: {
          organizationId,
        },
      },
      select: {
        config: true,
      },
    });

    if (!scenarioVersion) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Scenario version was not found for this organization.',
      );
    }

    return parseScenarioVersionConfig(scenarioVersion.config);
  }

  async listEvents(
    runId: string,
    organizationId: string,
    after = 0,
    take = 200,
  ): Promise<readonly StreamEnvelope[]> {
    await this.requireRun(this.client, runId, organizationId);
    const events = await this.client.runEvent.findMany({
      where: {
        runId,
        sequence: {
          gt: after,
        },
      },
      orderBy: {
        sequence: 'asc',
      },
      take: Math.min(Math.max(take, 1), 1_000),
    });

    return events.map((event) => ({
      cursor: event.sequence,
      event: fromDatabaseEvent(event),
    }));
  }

  async claimRunSchedule(
    input: { runId: string; organizationId: string; generation: number },
    now = new Date(),
  ): Promise<RunScheduleClaimResult> {
    return this.client.$transaction(async (tx) => {
      await lockRun(tx, input.runId, input.organizationId);
      const run = await tx.simulationRun.findFirst({
        where: { id: input.runId, organizationId: input.organizationId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          schedulerGeneration: true,
          nextTickIndex: true,
          tickIntervalSeconds: true,
          scheduleLease: true,
        },
      });
      if (!run || run.status !== 'running' || run.schedulerGeneration !== input.generation) {
        return { status: 'ineligible' };
      }
      if (run.scheduleLease?.generation === input.generation && run.scheduleLease.expiresAt > now) {
        return { status: 'active' };
      }

      const holderId = randomUUID();
      const expiresAt = new Date(now.getTime() + runScheduleLeaseTtlMilliseconds);
      await tx.runScheduleLease.upsert({
        where: { runId: run.id },
        create: {
          runId: run.id,
          organizationId: run.organizationId,
          generation: input.generation,
          holderId,
          heartbeatAt: now,
          expiresAt,
        },
        update: {
          organizationId: run.organizationId,
          generation: input.generation,
          holderId,
          heartbeatAt: now,
          expiresAt,
        },
      });
      return {
        status: 'claimed',
        lease: {
          runId: run.id,
          organizationId: run.organizationId,
          generation: input.generation,
          intervalSeconds: run.tickIntervalSeconds,
          firstTickIndex: run.nextTickIndex + 1,
          holderId,
        },
      };
    });
  }

  async renewRunSchedule(
    input: { runId: string; organizationId: string; generation: number; holderId: string },
    now = new Date(),
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      await lockRun(tx, input.runId, input.organizationId);
      const run = await tx.simulationRun.findFirst({
        where: {
          id: input.runId,
          organizationId: input.organizationId,
          status: 'running',
          schedulerGeneration: input.generation,
        },
        select: { id: true },
      });
      if (!run) return false;
      const renewed = await tx.runScheduleLease.updateMany({
        where: {
          runId: input.runId,
          organizationId: input.organizationId,
          generation: input.generation,
          holderId: input.holderId,
          expiresAt: { gt: now },
        },
        data: {
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + runScheduleLeaseTtlMilliseconds),
        },
      });
      return renewed.count === 1;
    });
  }

  async releaseRunSchedule(
    input: { runId: string; organizationId: string; generation: number; holderId: string },
    now = new Date(),
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      await lockRun(tx, input.runId, input.organizationId);
      const released = await tx.runScheduleLease.deleteMany({
        where: {
          runId: input.runId,
          organizationId: input.organizationId,
          generation: input.generation,
          holderId: input.holderId,
          expiresAt: { gt: now },
        },
      });
      return released.count === 1;
    });
  }

  async releaseObsoleteRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<void> {
    await this.client.runScheduleLease.deleteMany({
      where: {
        runId: input.runId,
        organizationId: input.organizationId,
        generation: { lt: input.generation },
      },
    });
  }

  async getLatestRunningRuns(limit = 50): Promise<readonly RunSummary[]> {
    const runs = await this.client.simulationRun.findMany({
      where: { status: 'running' },
      orderBy: { updatedAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        scenarioVersion: {
          select: { config: true },
        },
      },
    });
    return runs.map((run) => toRunSummary(run));
  }

  async claimPendingOutbox(
    limit: number,
    now = new Date(),
  ): Promise<readonly ClaimedOutboxMessage[]> {
    const leaseExpiredAt = new Date(now.getTime() - 60_000);
    return this.client.$transaction(async (tx) => {
      const messages = await tx.$queryRaw<ClaimedOutboxMessage[]>(Prisma.sql`
        SELECT
          id,
          organization_id AS "organizationId",
          run_id AS "runId",
          topic,
          payload,
          attempts,
          created_at AS "createdAt"
        FROM outbox_messages
        WHERE published_at IS NULL
          AND next_attempt_at <= ${now}
          AND (locked_at IS NULL OR locked_at < ${leaseExpiredAt})
        ORDER BY created_at ASC
        LIMIT ${Math.min(Math.max(limit, 1), 100)}
        FOR UPDATE SKIP LOCKED
      `);

      if (messages.length === 0) {
        return [];
      }

      await tx.outboxMessage.updateMany({
        where: {
          id: {
            in: messages.map((message) => message.id),
          },
        },
        data: {
          lockedAt: now,
        },
      });
      return messages;
    });
  }

  async markOutboxPublished(id: string): Promise<void> {
    await this.client.outboxMessage.update({
      where: { id },
      data: {
        publishedAt: new Date(),
        lockedAt: null,
        lastError: null,
      },
    });
  }

  async markOutboxFailed(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const current = await this.client.outboxMessage.findUnique({
      where: { id },
      select: { attempts: true },
    });
    if (!current) {
      return;
    }

    const attempts = current.attempts + 1;
    await this.client.outboxMessage.update({
      where: { id },
      data: {
        attempts,
        lockedAt: null,
        lastError: message.slice(0, 1_000),
        nextAttemptAt: new Date(Date.now() + retryDelayMilliseconds(attempts)),
      },
    });
  }

  private async requireRun(
    client: PrismaClient | Prisma.TransactionClient,
    runId: string,
    organizationId: string,
  ) {
    const run = await client.simulationRun.findFirst({
      where: {
        id: runId,
        organizationId,
      },
      include: {
        scenarioVersion: {
          select: {
            config: true,
          },
        },
      },
    });

    if (!run) {
      throw new ApplicationError('NOT_FOUND', 'Run was not found for this organization.');
    }
    return run;
  }

  private async loadState<TState>(
    tx: Prisma.TransactionClient,
    run: Awaited<ReturnType<PrismaRunRepository['requireRun']>>,
    kernel: SimulationKernel<TState>,
    config: Record<string, unknown>,
  ): Promise<SimulationState<TState>> {
    return this.loadStateAtSequence(tx, run, kernel, config, run.latestSequence);
  }

  private async loadStateAtSequence<TState>(
    tx: Prisma.TransactionClient,
    run: Awaited<ReturnType<PrismaRunRepository['requireRun']>>,
    kernel: SimulationKernel<TState>,
    config: Record<string, unknown>,
    targetSequence: number,
  ): Promise<SimulationState<TState>> {
    const snapshot = await tx.stateSnapshot.findFirst({
      where: {
        runId: run.id,
        sequence: { lte: targetSequence },
      },
      orderBy: { sequence: 'desc' },
    });
    const persistedSnapshot = snapshot
      ? parsePersistedSimulationState<TState>(
          snapshot.state,
          snapshot.checksum,
          snapshot.schemaVersion,
          snapshot.sequence,
        )
      : undefined;
    const initialState = persistedSnapshot
      ? persistedSnapshot.state
      : kernel.initialize({
          organizationId: run.organizationId,
          runId: run.id,
          seed: run.seed,
          config,
          simulatedAt: run.createdAt.toISOString(),
        });
    const events = await tx.runEvent.findMany({
      where: {
        runId: run.id,
        sequence: {
          gt: persistedSnapshot?.sequence ?? 0,
          lte: targetSequence,
        },
      },
      orderBy: { sequence: 'asc' },
    });
    return kernel.replay(initialState, events.map(fromDatabaseEvent));
  }

  private async writeStateSnapshot<TState>(
    tx: Prisma.TransactionClient,
    runId: string,
    sequence: number,
    state: SimulationState<TState>,
  ): Promise<void> {
    const persistedState = toInputJson(state);
    await tx.stateSnapshot.upsert({
      where: {
        runId_sequence: { runId, sequence },
      },
      create: {
        runId,
        sequence,
        schemaVersion: stateSnapshotSchemaVersion,
        state: persistedState,
        checksum: checksumState(persistedState),
      },
      update: {
        schemaVersion: stateSnapshotSchemaVersion,
        state: persistedState,
        checksum: checksumState(persistedState),
      },
    });
  }

  private async getBranchComparison(
    branchRun: Awaited<ReturnType<PrismaRunRepository['requireRun']>>,
    parentRunId: string,
    branchFromSequence: number,
  ): Promise<NonNullable<ReviewSummary['branch']['comparison']>> {
    const [parent, parentEvents, branchEvents, parentEvaluations, branchEvaluations] =
      await Promise.all([
        this.client.simulationRun.findUniqueOrThrow({ where: { id: parentRunId } }),
        this.client.runEvent.findMany({
          where: { runId: parentRunId, sequence: { gt: branchFromSequence } },
          select: { type: true },
        }),
        this.client.runEvent.findMany({
          where: { runId: branchRun.id, sequence: { gt: 1 } },
          select: { type: true },
        }),
        this.client.evaluation.findMany({
          where: { runId: parentRunId },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
        }),
        this.client.evaluation.findMany({
          where: { runId: branchRun.id },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
        }),
      ]);
    const eventTypes = new Set([
      ...parentEvents.map((event) => event.type),
      ...branchEvents.map((event) => event.type),
    ]);
    const latestParentScores = latestEvaluationScores(parentEvaluations);
    const latestBranchScores = latestEvaluationScores(branchEvaluations);
    const evaluatorKeys = new Set([...latestParentScores.keys(), ...latestBranchScores.keys()]);

    return {
      parentRunId,
      branchRunId: branchRun.id,
      branchFromSequence,
      virtualTime: {
        parent: parent.virtualTime,
        branch: branchRun.virtualTime,
        delta: branchRun.virtualTime - parent.virtualTime,
      },
      eventCounts: {
        parentAfterBranch: parentEvents.length,
        branch: branchEvents.length,
      },
      significantEvents: [...eventTypes]
        .sort()
        .map((type) => ({
          type,
          parentCount: parentEvents.filter((event) => event.type === type).length,
          branchCount: branchEvents.filter((event) => event.type === type).length,
        }))
        .filter((event) => event.parentCount !== event.branchCount),
      evaluationChanges: [...evaluatorKeys].sort().map((evaluatorKey) => {
        const parentScore = latestParentScores.get(evaluatorKey);
        const branchScore = latestBranchScores.get(evaluatorKey);
        return {
          evaluatorKey,
          parentScore,
          branchScore,
          delta:
            parentScore === undefined || branchScore === undefined
              ? undefined
              : branchScore - parentScore,
        };
      }),
      status: { parent: parent.status, branch: branchRun.status },
    };
  }

  private async writeEventsAndProjections<TState>(
    tx: Prisma.TransactionClient,
    run: {
      id: string;
      organizationId: string;
      status: RunStatus;
      version: number;
      virtualTime: number;
      latestSequence: number;
      schedulerGeneration: number;
      nextTickIndex: number;
      tickIntervalSeconds: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
    result: KernelResult<TState>,
    options: {
      forceSnapshot: boolean;
      scheduler: SchedulerInstruction | undefined;
    },
  ): Promise<void> {
    await tx.runEvent.createMany({
      data: result.events.map((event) => ({
        id: event.id,
        organizationId: event.organizationId,
        runId: event.runId,
        sequence: event.sequence,
        type: event.type,
        version: event.version,
        source: event.source as EventSource,
        participantId: event.participantId ?? null,
        simulatedAt: new Date(event.simulatedAt),
        recordedAt: new Date(event.recordedAt),
        causationId: event.causationId ?? null,
        correlationId: event.correlationId ?? null,
        idempotencyKey: event.idempotencyKey,
        payload: toInputJson(event.payload),
      })),
    });

    const overviewData = {
      world: result.state.world,
      metrics: result.state.metrics,
      pendingApprovalIds: Object.keys(result.state.pendingApprovals),
      participantStatuses: Object.fromEntries(
        Object.values(result.state.participants).map((participant) => [
          participant.key,
          participant.status,
        ]),
      ),
    };
    await tx.runOverviewProjection.upsert({
      where: { runId: run.id },
      create: {
        runId: run.id,
        organizationId: run.organizationId,
        status: result.state.run.status,
        latestSequence: result.state.run.latestSequence,
        virtualTime: result.state.run.virtualTimeMinutes,
        data: toInputJson(overviewData),
      },
      update: {
        status: result.state.run.status,
        latestSequence: result.state.run.latestSequence,
        virtualTime: result.state.run.virtualTimeMinutes,
        data: toInputJson(overviewData),
      },
    });

    await tx.timelineProjection.createMany({
      data: result.events.map((event) => ({
        runId: event.runId,
        sequence: event.sequence,
        eventId: event.id,
        type: event.type,
        source: event.source as EventSource,
        data: toInputJson({
          participantId: event.participantId,
          simulatedAt: event.simulatedAt,
          payload: event.payload,
        }),
      })),
    });

    await this.materializeGovernance(tx, run.id, result);

    const participants = await tx.runParticipant.findMany({
      where: { runId: run.id },
      select: { id: true, key: true },
    });
    await Promise.all(
      participants.map((participant) => {
        const runtimeParticipant = Object.values(result.state.participants).find(
          (candidate) => candidate.key === participant.key,
        );
        return tx.participantProjection.upsert({
          where: { runParticipantId: participant.id },
          create: {
            runParticipantId: participant.id,
            runId: run.id,
            status: runtimeParticipant?.status ?? 'inactive',
            data: toInputJson(runtimeParticipant ?? {}),
          },
          update: {
            status: runtimeParticipant?.status ?? 'inactive',
            data: toInputJson(runtimeParticipant ?? {}),
          },
        });
      }),
    );

    const checkpoints = result.events.filter((event) => event.type === 'checkpoint.created');
    if (checkpoints.length > 0) {
      await tx.checkpoint.createMany({
        data: checkpoints.map((event) => ({
          runId: event.runId,
          sequence: event.sequence,
          label: readCheckpointLabel(event.payload),
        })),
      });
    }

    if (options.forceSnapshot || result.state.run.latestSequence % this.snapshotInterval === 0) {
      // `undefined` 会在 JSON 持久化时被移除；校验和必须对同一份规范化 JSON
      // 计算，否则下一次读取快照时会把合法数据误判为被篡改。
      const persistedState = toInputJson(result.state);
      await tx.stateSnapshot.upsert({
        where: {
          runId_sequence: {
            runId: run.id,
            sequence: result.state.run.latestSequence,
          },
        },
        create: {
          runId: run.id,
          sequence: result.state.run.latestSequence,
          schemaVersion: stateSnapshotSchemaVersion,
          state: persistedState,
          checksum: checksumState(persistedState),
        },
        update: {
          schemaVersion: stateSnapshotSchemaVersion,
          state: persistedState,
          checksum: checksumState(persistedState),
        },
      });
    }

    const eventMessages = result.events.map((event) => ({
      organizationId: event.organizationId,
      runId: event.runId,
      topic: 'run.event',
      payload: toInputJson({
        cursor: event.sequence,
        event,
      }),
    }));
    const schedulerMessage =
      options.scheduler === undefined
        ? []
        : [
            {
              organizationId: run.organizationId,
              runId: run.id,
              topic:
                options.scheduler.type === 'start' ? 'run.scheduler.start' : 'run.scheduler.cancel',
              payload: toInputJson(options.scheduler),
            },
          ];
    await tx.outboxMessage.createMany({
      data: [...eventMessages, ...schedulerMessage],
    });
  }

  private async materializeGovernance<TState>(
    tx: Prisma.TransactionClient,
    runId: string,
    result: KernelResult<TState>,
  ): Promise<void> {
    for (const event of result.events.filter(
      (candidate) => candidate.type === 'action.approval_requested',
    )) {
      const payload = jsonRecordOrEmpty(event.payload);
      const approvalId = readRequiredString(payload, 'approvalId');
      const requestedAt = new Date(event.recordedAt);
      await tx.approval.upsert({
        where: { id: approvalId },
        create: {
          id: approvalId,
          runId,
          actionType: readRequiredString(payload, 'actionType'),
          participantId: readRequiredString(payload, 'participantId'),
          requestedByCommandId: readRequiredString(payload, 'requestedByCommandId'),
          requestedSequence: event.sequence,
          parameters: toInputJson(jsonRecordOrEmpty(payload.parameters)),
          status: 'pending',
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + approvalTtlMilliseconds),
        },
        update: {},
      });
      await tx.evidence.upsert({
        where: {
          approvalId_sequence_eventType: {
            approvalId,
            sequence: event.sequence,
            eventType: event.type,
          },
        },
        create: {
          runId,
          approvalId,
          sequence: event.sequence,
          eventType: event.type,
          label: '高风险动作等待审批',
          data: toInputJson({
            actionType: payload.actionType,
            parameters: payload.parameters,
          }),
        },
        update: {},
      });
    }

    for (const event of result.events.filter((candidate) =>
      ['action.approved', 'action.denied', 'action.approval_expired'].includes(candidate.type),
    )) {
      const approvalId = readRequiredString(jsonRecordOrEmpty(event.payload), 'approvalId');
      const status: ApprovalStatus =
        event.type === 'action.approved'
          ? 'approved'
          : event.type === 'action.denied'
            ? 'denied'
            : 'expired';
      await tx.approval.updateMany({
        where: { id: approvalId, runId, status: 'pending' },
        data: {
          status,
          resolvedAt: new Date(event.recordedAt),
          resolutionSequence: event.sequence,
        },
      });
      await tx.decision.upsert({
        where: { approvalId },
        create: {
          runId,
          approvalId,
          sequence: event.sequence,
          decision: status,
        },
        update: {},
      });
    }

    if (result.evaluations.length === 0 || result.events.length === 0) {
      return;
    }
    for (const evaluation of result.evaluations) {
      const persisted = await tx.evaluation.upsert({
        where: {
          runId_evaluatorKey_sequence: {
            runId,
            evaluatorKey: evaluation.evaluatorKey,
            sequence: result.state.run.latestSequence,
          },
        },
        create: {
          runId,
          evaluatorKey: evaluation.evaluatorKey,
          sequence: result.state.run.latestSequence,
          score: evaluation.score,
          summary: evaluation.summary,
        },
        update: {
          score: evaluation.score,
          summary: evaluation.summary,
        },
      });
      const matching = result.events.filter((event) =>
        evaluation.evidenceEventTypes.includes(event.type),
      );
      // 评分没有产生对应类型事件时，绑定本次变更的最后一个事件作为最小证据，
      // 使每个评分维度在 Review 页面都可以回到不可变时间线。
      const evidenceEvents = matching.length > 0 ? matching : result.events.slice(-1);
      for (const event of evidenceEvents) {
        await tx.evidence.upsert({
          where: {
            evaluationId_sequence_eventType: {
              evaluationId: persisted.id,
              sequence: event.sequence,
              eventType: event.type,
            },
          },
          create: {
            runId,
            evaluationId: persisted.id,
            sequence: event.sequence,
            eventType: event.type,
            label: `评分证据：${event.type}`,
            data: toInputJson(event.payload),
          },
          update: {},
        });
      }
    }
  }
}

export interface OutboxMessageHandler {
  handle(message: ClaimedOutboxMessage): Promise<void>;
}

/**
 * Outbox 处理器在事务提交后运行。失败只影响消息重试，不回滚已经确认的领域事实。
 */
export class RuntimeOutboxPublisher {
  constructor(
    private readonly repository: PrismaRunRepository,
    private readonly hub: RunEventHub,
    private readonly handlers: Readonly<Record<string, OutboxMessageHandler>> = {},
  ) {}

  async publishPending(limit = 100): Promise<number> {
    const messages = await this.repository.claimPendingOutbox(limit);
    for (const message of messages) {
      try {
        if (message.topic === 'run.event') {
          this.hub.publish(outboxEventPayloadSchema.parse(message.payload));
        } else {
          const handler = this.handlers[message.topic];
          if (!handler) {
            throw new Error(`No Outbox handler is registered for topic "${message.topic}".`);
          }
          await handler.handle(message);
        }
        await this.repository.markOutboxPublished(message.id);
      } catch (error) {
        await this.repository.markOutboxFailed(message.id, error);
      }
    }
    return messages.length;
  }
}

export class RunApplicationService {
  constructor(
    private readonly repository: PrismaRunRepository,
    private readonly registry: ScenarioPackRegistry,
  ) {}

  async createRun(request: CreateRunRequest): Promise<RunSummary> {
    const config = await this.getScenarioVersionConfig(
      request.scenarioVersionId,
      request.organizationId,
    );
    return this.repository.createRun(request, this.specializePack(config));
  }

  async createBranchRun(request: CreateBranchRequest): Promise<RunSummary> {
    return this.repository.createBranchRun(
      request,
      this.specializePack(
        await this.getRunScenarioVersionConfig({
          runId: request.parentRunId,
          organizationId: request.organizationId,
        }),
      ),
    );
  }

  async execute(command: RunCommand): Promise<CommandExecution> {
    return this.repository.execute(
      command,
      this.specializePack(await this.getRunScenarioVersionConfig(command)),
    );
  }

  async resolveApproval(
    command: Omit<RunCommand, 'payload'>,
    approvalId: string,
    decision: 'approved' | 'denied',
  ): Promise<CommandExecution> {
    const run = await this.repository.getRun(command.runId, command.organizationId);
    const approval = await this.repository.getApproval(
      command.runId,
      command.organizationId,
      approvalId,
    );
    if (approval.status !== 'pending') {
      throw new ApplicationError('APPROVAL_STALE', 'The approval has already been resolved.');
    }
    const expired = new Date(approval.expiresAt) <= new Date();
    const execution = await this.repository.execute(
      {
        ...command,
        expectedRunVersion: command.expectedRunVersion ?? run.version,
        // 过期同样必须经过 Kernel 产生事件，才会从 Snapshot 的 pending
        // 集合中移除，避免审批投影与权威状态出现分叉。
        payload: {
          type: 'resolve-approval',
          approvalId,
          decision: expired ? 'expired' : decision,
        },
      },
      this.specializePack(await this.getRunScenarioVersionConfig(command)),
    );
    if (expired) {
      throw new ApplicationError('APPROVAL_STALE', 'The approval has expired.');
    }
    if (execution.result.rejection?.code === 'APPROVAL_STALE') {
      await this.repository.markApprovalStale(command.runId, command.organizationId, approvalId);
    }
    return execution;
  }

  async executeScheduledTick(input: {
    runId: string;
    organizationId: string;
    generation: number;
    tickIndex: number;
    holderId: string;
    minutes: number;
    issuedAt: string;
  }): Promise<CommandExecution | undefined> {
    const run = await this.repository.getRun(input.runId, input.organizationId);
    if (
      run.status !== 'running' ||
      run.schedulerGeneration !== input.generation ||
      run.nextTickIndex + 1 !== input.tickIndex
    ) {
      return undefined;
    }

    const command: RunCommand = {
      commandId: randomUUID(),
      organizationId: input.organizationId,
      runId: input.runId,
      actor: systemActor(input.organizationId),
      expectedRunVersion: run.version,
      idempotencyKey: createScheduledTickIdempotencyKey(input),
      issuedAt: input.issuedAt,
      payload: {
        type: 'advance-clock',
        minutes: input.minutes,
      },
    };
    return this.repository.execute(
      command,
      this.specializePack(await this.getRunScenarioVersionConfig(command)),
      {
        generation: input.generation,
        tickIndex: input.tickIndex,
        holderId: input.holderId,
      },
    );
  }

  async getRun(runId: string, organizationId: string): Promise<RunSummary> {
    return this.repository.getRun(runId, organizationId);
  }

  async listApprovals(runId: string, organizationId: string): Promise<readonly ApprovalSummary[]> {
    return this.repository.listApprovals(runId, organizationId);
  }

  async getReview(runId: string, organizationId: string): Promise<ReviewSummary> {
    return this.repository.getReview(runId, organizationId);
  }

  async getReplay(
    runId: string,
    organizationId: string,
    targetSequence?: number,
  ): Promise<ReplaySummary> {
    return this.repository.getReplay(
      runId,
      organizationId,
      targetSequence,
      this.specializePack(await this.getRunScenarioVersionConfig({ runId, organizationId })),
    );
  }

  async createRemediationItem(input: {
    runId: string;
    organizationId: string;
    evaluationId?: string;
    title: string;
    description: string;
    dueAt?: Date;
  }) {
    return this.repository.createRemediationItem(input);
  }

  async updateRemediationItem(
    runId: string,
    organizationId: string,
    itemId: string,
    status: 'open' | 'in_progress' | 'resolved',
  ) {
    return this.repository.updateRemediationItem(runId, organizationId, itemId, status);
  }

  /**
   * Web 层只需要消费已按 ScenarioVersion 收敛后的 Pack，不应自行读取
   * 版本配置再套用覆盖规则，避免 UI 与命令执行出现两套参与方语义。
   */
  async getRunScenarioPack(runId: string, organizationId: string): Promise<ScenarioPack<unknown>> {
    return this.specializePack(await this.getRunScenarioVersionConfig({ runId, organizationId }));
  }

  async getLatestRunningRuns(limit = 50): Promise<readonly RunSummary[]> {
    return this.repository.getLatestRunningRuns(limit);
  }

  async claimRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<RunScheduleClaimResult> {
    return this.repository.claimRunSchedule(input);
  }

  async renewRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
    holderId: string;
  }): Promise<boolean> {
    return this.repository.renewRunSchedule(input);
  }

  async releaseRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
    holderId: string;
  }): Promise<boolean> {
    return this.repository.releaseRunSchedule(input);
  }

  async releaseObsoleteRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<void> {
    return this.repository.releaseObsoleteRunSchedule(input);
  }

  /**
   * 对账先原子领取缺失或过期租约；有效租约存在时绝不创建新的长生命周期 Workflow。
   */
  async reconcileRunningRuns(scheduler: RunScheduler, limit = 50): Promise<number> {
    const runs = await this.getLatestRunningRuns(limit);
    let started = 0;
    for (const run of runs) {
      const claim = await this.claimRunSchedule({
        runId: run.id,
        organizationId: run.organizationId,
        generation: run.schedulerGeneration,
      });
      if (claim.status !== 'claimed') {
        continue;
      }
      try {
        await scheduler.start(claim.lease);
        started += 1;
      } catch (error) {
        await this.releaseRunSchedule(claim.lease);
        throw error;
      }
    }
    return started;
  }

  async listEvents(
    runId: string,
    organizationId: string,
    after?: number,
    take?: number,
  ): Promise<readonly StreamEnvelope[]> {
    return this.repository.listEvents(runId, organizationId, after, take);
  }

  async *streamEvents(
    runId: string,
    organizationId: string,
    after: number,
    hub: RunEventHub,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEnvelope> {
    let cursor = after;
    const queued: StreamEnvelope[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = hub.subscribe(runId, (envelope) => {
      queued.push(envelope);
      wake?.();
    });

    try {
      while (!signal?.aborted) {
        const backfill = await this.listEvents(runId, organizationId, cursor);
        for (const envelope of backfill) {
          if (envelope.cursor > cursor) {
            cursor = envelope.cursor;
            yield envelope;
          }
        }

        if (queued.length > 0) {
          // Hub 事件只负责唤醒。下一轮始终由 PostgreSQL 按 Cursor 回补，
          // 因此同一事件即使被 Hub 重复投递也不会造成客户端重复。
          queued.splice(0);
          continue;
        }

        await waitForEvent(signal, (notify) => {
          wake = notify;
          // 订阅回调可能恰好发生在上面的 queued 检查之后。设置 wake 后
          // 再检查一次，避免丢失通知而永久等待下一次事件。
          if (queued.length > 0) {
            notify();
          }
        });
        wake = undefined;
      }
    } finally {
      unsubscribe();
    }
  }

  private requirePack(key: string): ScenarioPack<unknown> {
    const pack = this.registry.get(key);
    if (!pack) {
      throw new ApplicationError('NOT_FOUND', `Scenario pack ${key} is not registered.`);
    }
    return pack;
  }

  private specializePack(config: ScenarioVersionRuntimeConfig): ScenarioPack<unknown> {
    return specializeScenarioPack(this.requirePack(config.packKey), config);
  }

  private async getRunScenarioVersionConfig(
    command: Pick<CommandEnvelope, 'runId' | 'organizationId'>,
  ) {
    return this.repository.getRunScenarioVersionConfig(command.runId, command.organizationId);
  }

  private async getScenarioVersionConfig(scenarioVersionId: string, organizationId: string) {
    return this.repository.getScenarioVersionConfig(scenarioVersionId, organizationId);
  }
}

function filterParticipantEffects(
  effects: readonly Effect[],
  enabledParticipantIds: ReadonlySet<string>,
): readonly Effect[] {
  const filtered: Effect[] = [];
  for (const effect of effects) {
    if (effect.kind === 'emit-signal') {
      filtered.push({
        ...effect,
        recipients: effect.recipients.filter((recipientId) =>
          enabledParticipantIds.has(recipientId),
        ),
      });
      continue;
    }
    if (
      effect.kind === 'change-participant-status' &&
      !enabledParticipantIds.has(effect.participantId)
    ) {
      continue;
    }
    filtered.push(effect);
  }
  return filtered;
}

function triggerReferencesDisabledParticipant<TState>(
  trigger: Trigger<TState> | undefined,
  enabledParticipantIds: ReadonlySet<string>,
): boolean {
  if (!trigger) return false;
  switch (trigger.kind) {
    case 'all':
    case 'any':
      return trigger.conditions.some((condition) =>
        triggerReferencesDisabledParticipant(condition, enabledParticipantIds),
      );
    case 'not':
      return triggerReferencesDisabledParticipant(trigger.condition, enabledParticipantIds);
    case 'participant-action-count-gte':
      return !enabledParticipantIds.has(trigger.participantId);
    default:
      return false;
  }
}

async function lockRun(
  tx: Prisma.TransactionClient,
  runId: string,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM simulation_runs
    WHERE id = ${runId}::uuid AND organization_id = ${organizationId}::uuid
    FOR UPDATE
  `);
}

function createKernelContext(recordedAt: string) {
  return {
    recordedAt,
    nextEventId: randomUUID,
  };
}

function createRunUpdateData<TState>(
  run: {
    schedulerGeneration: number;
    nextTickIndex: number;
    startedAt: Date | null;
    completedAt: Date | null;
  },
  result: KernelResult<TState>,
  scheduler: SchedulerInstruction | undefined,
  scheduledTick: ScheduledTick | undefined,
): Prisma.SimulationRunUpdateManyMutationInput {
  const now = new Date();
  const terminal = result.state.run.status === 'completed' || result.state.run.status === 'failed';
  return {
    status: result.state.run.status,
    version: result.state.run.version,
    latestSequence: result.state.run.latestSequence,
    virtualTime: result.state.run.virtualTimeMinutes,
    schedulerGeneration: scheduler === undefined ? run.schedulerGeneration : scheduler.generation,
    nextTickIndex: scheduledTick?.tickIndex ?? run.nextTickIndex,
    ...(result.events.some((event) => event.type === 'run.started') && run.startedAt === null
      ? { startedAt: now }
      : {}),
    ...(terminal && run.completedAt === null ? { completedAt: now } : {}),
  };
}

function deriveSchedulerInstruction<TState>(
  run: {
    id: string;
    schedulerGeneration: number;
    nextTickIndex: number;
    tickIntervalSeconds: number;
  },
  result: KernelResult<TState>,
  scheduledTick: ScheduledTick | undefined,
): SchedulerInstruction | undefined {
  const hasStart = result.events.some(
    (event) => event.type === 'run.started' || event.type === 'run.resumed',
  );
  const hasStop = result.events.some(
    (event) =>
      event.type === 'run.paused' || event.type === 'run.completed' || event.type === 'run.failed',
  );
  if (hasStart) {
    return {
      type: 'start',
      runId: run.id,
      generation: run.schedulerGeneration + 1,
      intervalSeconds: run.tickIntervalSeconds,
      firstTickIndex: run.nextTickIndex + 1,
    };
  }
  if (hasStop) {
    return {
      type: 'cancel',
      runId: run.id,
      generation: run.schedulerGeneration + 1,
    };
  }
  if (scheduledTick && result.state.run.status !== 'running') {
    return {
      type: 'cancel',
      runId: run.id,
      generation: run.schedulerGeneration + 1,
    };
  }
  return undefined;
}

/**
 * Tick 的重试、Workflow 重放和重复启动都必须复用这把键。它只由持久化的
 * Run 标识、调度代次和离散序号组成，不依赖墙上时间或随机值。
 */
export function createScheduledTickIdempotencyKey(input: {
  runId: string;
  generation: number;
  tickIndex: number;
}): string {
  return `tick:${input.runId}:${input.generation}:${input.tickIndex}`;
}

function shouldForceSnapshot(events: readonly DomainEvent[]): boolean {
  return events.some((event) =>
    ['run.paused', 'run.completed', 'run.failed', 'checkpoint.created', 'branch.created'].includes(
      event.type,
    ),
  );
}

function createNoopKernelResult<TState>(state: SimulationState<TState>): KernelResult<TState> {
  return {
    state,
    events: [],
    sideEffects: [],
    evaluations: [],
    status: 'duplicate',
  };
}

function createDuplicateKernelResult<TState>(
  state: SimulationState<TState>,
  kernel: SimulationKernel<TState>,
): KernelResult<TState> {
  return {
    state,
    events: [],
    sideEffects: [],
    evaluations: kernel.evaluate(state),
    status: 'duplicate',
  };
}

function fromDatabaseEvent(event: {
  id: string;
  organizationId: string;
  runId: string;
  sequence: number;
  type: string;
  version: number;
  source: EventSource;
  participantId: string | null;
  simulatedAt: Date;
  recordedAt: Date;
  causationId: string | null;
  correlationId: string | null;
  idempotencyKey: string;
  payload: Prisma.JsonValue;
}): DomainEvent {
  const candidate = {
    id: event.id,
    organizationId: event.organizationId,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    version: event.version,
    source: event.source,
    simulatedAt: event.simulatedAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    idempotencyKey: event.idempotencyKey,
    payload: event.payload,
    ...(event.participantId === null ? {} : { participantId: event.participantId }),
    ...(event.causationId === null ? {} : { causationId: event.causationId }),
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
  };
  return domainEventSchema.parse(candidate);
}

function toRunSummary(run: {
  id: string;
  organizationId: string;
  scenarioVersionId: string;
  status: RunStatus;
  version: number;
  seed: number;
  virtualTime: number;
  latestSequence: number;
  schedulerGeneration: number;
  nextTickIndex: number;
  tickIntervalSeconds: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): RunSummary {
  return {
    id: run.id,
    organizationId: run.organizationId,
    scenarioVersionId: run.scenarioVersionId,
    status: run.status,
    version: run.version,
    seed: run.seed,
    virtualTime: run.virtualTime,
    latestSequence: run.latestSequence,
    schedulerGeneration: run.schedulerGeneration,
    nextTickIndex: run.nextTickIndex,
    tickIntervalSeconds: run.tickIntervalSeconds,
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    data: {},
  };
}

function parseScenarioVersionConfig(config: Prisma.JsonValue) {
  return scenarioVersionConfigSchema.parse(config);
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ApplicationError('VALIDATION_ERROR', 'Scenario configuration must be a JSON object.');
}

function jsonRecordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ApplicationError('INTERNAL_ERROR', `Expected ${key} in a persisted event payload.`);
  }
  return candidate;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  // Prisma 用 JsonNull 区分 JSON null 与 SQL NULL，但它没有落在 InputJsonValue 的公开联合中。
  return serialized === null
    ? (Prisma.JsonNull as unknown as Prisma.InputJsonValue)
    : (serialized as Prisma.InputJsonValue);
}

function checksumState(state: unknown): string {
  return createHash('sha256').update(stableJson(state)).digest('hex');
}

function parsePersistedSimulationState<TState>(
  value: Prisma.JsonValue,
  expectedChecksum: string,
  schemaVersion: number,
  sequence: number,
): { sequence: number; state: SimulationState<TState> } | undefined {
  const parsed = persistedSimulationStateSchema.parse(value);
  const actualChecksum = checksumState(parsed);
  if (actualChecksum !== expectedChecksum) {
    if (schemaVersion < stateSnapshotSchemaVersion) {
      // v1 在持久化前计算校验和，含 `undefined` 的状态会产生无效摘要。Snapshot
      // 只是重放加速缓存，忽略它并从权威 Event Log 重建即可恢复历史 Run。
      return undefined;
    }
    throw new ApplicationError(
      'INTERNAL_ERROR',
      'State snapshot checksum does not match its content.',
    );
  }
  return {
    sequence,
    state: parsed as SimulationState<TState>,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function readCheckpointLabel(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'label' in payload &&
    typeof payload.label === 'string'
  ) {
    return payload.label;
  }
  return 'Checkpoint';
}

function latestEvaluationScores(
  evaluations: readonly { evaluatorKey: string; score: number }[],
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  for (const evaluation of evaluations) {
    if (!scores.has(evaluation.evaluatorKey)) {
      scores.set(evaluation.evaluatorKey, evaluation.score);
    }
  }
  return scores;
}

function retryDelayMilliseconds(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
}

function isCreateIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  return (
    Array.isArray(target) &&
    target.includes('organization_id') &&
    target.includes('created_by') &&
    target.includes('create_idempotency_key')
  );
}

function systemActor(organizationId: string): ActorRef {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'system',
    organizationId,
    displayName: 'Run Scheduler',
  };
}

function waitForEvent(
  signal: AbortSignal | undefined,
  setWake: (wake: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    setWake(finish);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
