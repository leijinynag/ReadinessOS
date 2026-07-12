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
  type KernelResult,
  type RunCommand,
  type SimulationState,
} from '@readinessos/simulation-kernel';
import { EventSource, Prisma, PrismaClient, RunStatus } from '@prisma/client';
import { z } from 'zod';

export const streamEnvelopeSchema = z.object({
  cursor: z.number().int().positive(),
  event: domainEventSchema,
});
export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

const scenarioVersionConfigSchema = z.object({
  packKey: z.string().min(1),
  tickIntervalSeconds: z.number().int().min(1).max(3_600).optional(),
});

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

export type CreateRunRequest = {
  organizationId: string;
  scenarioVersionId: string;
  createdById: string;
  idempotencyKey: string;
  seed: number;
  simulatedAt: string;
  tickIntervalSeconds?: number;
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
    }
  | {
      type: 'cancel';
      runId: string;
      generation: number;
    };

export type ScheduledTick = {
  generation: number;
  tickIndex: number;
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

  async execute<TState>(
    command: RunCommand,
    pack: ScenarioPack<TState>,
    scheduledTick?: ScheduledTick,
  ): Promise<CommandExecution<TState>> {
    return this.client.$transaction(async (tx) => {
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
    const run = await this.requireRun(this.client, runId, organizationId);
    return parseScenarioVersionConfig(run.scenarioVersion.config).packKey;
  }

  async getScenarioVersionPackKey(
    scenarioVersionId: string,
    organizationId: string,
  ): Promise<string> {
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

    return parseScenarioVersionConfig(scenarioVersion.config).packKey;
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

  async getLatestRunningRuns(limit = 50): Promise<readonly RunSummary[]> {
    const runs = await this.client.simulationRun.findMany({
      where: { status: 'running' },
      orderBy: { updatedAt: 'asc' },
      take: limit,
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
    const snapshot = await tx.stateSnapshot.findFirst({
      where: { runId: run.id },
      orderBy: { sequence: 'desc' },
    });
    const initialState = snapshot
      ? parsePersistedSimulationState<TState>(snapshot.state, snapshot.checksum)
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
          gt: snapshot?.sequence ?? 0,
        },
      },
      orderBy: { sequence: 'asc' },
    });
    return kernel.replay(initialState, events.map(fromDatabaseEvent));
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
          state: toInputJson(result.state),
          checksum: checksumState(result.state),
        },
        update: {
          state: toInputJson(result.state),
          checksum: checksumState(result.state),
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
    const packKey = await this.getScenarioVersionPackKey(
      request.scenarioVersionId,
      request.organizationId,
    );
    return this.repository.createRun(request, this.requirePack(packKey));
  }

  async execute(command: RunCommand): Promise<CommandExecution> {
    return this.repository.execute(command, this.requirePack(await this.getRunPackKey(command)));
  }

  async executeScheduledTick(input: {
    runId: string;
    organizationId: string;
    generation: number;
    tickIndex: number;
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
      idempotencyKey: `tick:${input.runId}:${input.generation}:${input.tickIndex}`,
      issuedAt: input.issuedAt,
      payload: {
        type: 'advance-clock',
        minutes: input.minutes,
      },
    };
    return this.repository.execute(command, this.requirePack(await this.getRunPackKey(command)), {
      generation: input.generation,
      tickIndex: input.tickIndex,
    });
  }

  async getRun(runId: string, organizationId: string): Promise<RunSummary> {
    return this.repository.getRun(runId, organizationId);
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

  private async getRunPackKey(command: Pick<CommandEnvelope, 'runId' | 'organizationId'>) {
    return this.repository.getRunPackKey(command.runId, command.organizationId);
  }

  private async getScenarioVersionPackKey(scenarioVersionId: string, organizationId: string) {
    return this.repository.getScenarioVersionPackKey(scenarioVersionId, organizationId);
  }
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
): SimulationState<TState> {
  const parsed = persistedSimulationStateSchema.parse(value);
  const actualChecksum = checksumState(parsed);
  if (actualChecksum !== expectedChecksum) {
    throw new ApplicationError(
      'INTERNAL_ERROR',
      'State snapshot checksum does not match its content.',
    );
  }
  return parsed as SimulationState<TState>;
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
