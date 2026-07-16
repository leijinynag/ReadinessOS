import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import { ApplicationError, type ActorRef } from '@readinessos/domain-events';
import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import type { RunCommand } from '@readinessos/simulation-kernel';
import { z } from 'zod';
import {
  InMemoryScenarioPackRegistry,
  ManualRunScheduler,
  PrismaRunRepository,
  RunApplicationService,
  RunEventHub,
  RuntimeOutboxPublisher,
  createScheduledTickIdempotencyKey,
  type ClaimedOutboxMessage,
  type OutboxMessageHandler,
  type SchedulerInstruction,
} from '../src/index.js';

const testParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';

const runtimeTestPack: ScenarioPack<{
  phase: 'created' | 'running' | 'paused';
  deferredOwnerId?: string;
}> = assertScenarioPack({
  key: 'runtime-integration-test',
  manifest: {
    key: 'runtime-integration-test',
    name: 'Runtime integration test',
    description: '用于验证运行时事务边界的最小场景。',
    version: 1,
    estimatedDurationMinutes: 5,
  },
  stateSchema: z.object({
    phase: z.enum(['created', 'running', 'paused']),
    deferredOwnerId: z.string().uuid().optional(),
  }),
  // 真实场景也会有这类延迟赋值字段。JSON 持久化会移除 undefined，因此它能
  // 覆盖「写入快照后再读取并启动 Run」的校验和回归。
  initialState: () => ({ phase: 'created', deferredOwnerId: undefined }),
  participants: [
    {
      id: testParticipantId,
      key: 'operator',
      displayName: 'Operator',
      controller: 'human',
      capabilities: ['acknowledge'],
      permissions: ['write:run'],
      knowledgeScopes: ['run'],
      objectives: ['complete'],
    },
  ],
  actions: [
    {
      key: 'acknowledge',
      label: 'Acknowledge',
      risk: 'low',
      approval: 'none',
      effects: [],
    },
  ],
  signals: [],
  injects: [],
  evaluators: [],
  uiContributions: [],
});

const organizationIds: string[] = [];
const userIds: string[] = [];
const registry = new InMemoryScenarioPackRegistry([runtimeTestPack]);

afterEach(async () => {
  const organizationIdBatch = organizationIds.splice(0);
  const userIdBatch = userIds.splice(0);

  if (organizationIdBatch.length > 0) {
    await prisma.organization.deleteMany({
      where: {
        id: {
          in: organizationIdBatch,
        },
      },
    });
  }
  if (userIdBatch.length > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIdBatch,
        },
      },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaRunRepository', () => {
  it('在同一事务中写入事件、投影、快照和 Outbox', async () => {
    const fixture = await createFixture();
    const service = createRunService();

    const run = await service.createRun({
      organizationId: fixture.organizationId,
      scenarioVersionId: fixture.scenarioVersionId,
      createdById: fixture.userId,
      idempotencyKey: 'create-transaction',
      seed: 7,
      simulatedAt: '2026-07-12T00:00:00.000Z',
    });

    const [persistedRun, events, snapshot, overview, timeline, outbox, participantProjection] =
      await Promise.all([
        prisma.simulationRun.findUniqueOrThrow({ where: { id: run.id } }),
        prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } }),
        prisma.stateSnapshot.findUnique({
          where: {
            runId_sequence: {
              runId: run.id,
              sequence: 1,
            },
          },
        }),
        prisma.runOverviewProjection.findUnique({ where: { runId: run.id } }),
        prisma.timelineProjection.findMany({ where: { runId: run.id } }),
        prisma.outboxMessage.findMany({ where: { runId: run.id } }),
        prisma.participantProjection.findMany({ where: { runId: run.id } }),
      ]);

    expect(persistedRun.latestSequence).toBe(1);
    expect(persistedRun.version).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      type: 'run.created',
      idempotencyKey: `create:${run.id}`,
    });
    expect(snapshot?.sequence).toBe(1);
    expect(overview).toMatchObject({
      status: 'created',
      latestSequence: 1,
      virtualTime: 0,
    });
    expect(timeline).toHaveLength(1);
    expect(participantProjection).toHaveLength(1);
    expect(outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: 'run.event',
          publishedAt: null,
        }),
      ]),
    );
  });

  it('为同一创建请求稳定复用已有 Run', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const request = {
      organizationId: fixture.organizationId,
      scenarioVersionId: fixture.scenarioVersionId,
      createdById: fixture.userId,
      idempotencyKey: 'create-idempotent',
      seed: 11,
      simulatedAt: '2026-07-12T00:00:00.000Z',
    };

    const [first, second] = await Promise.all([
      service.createRun(request),
      service.createRun(request),
    ]);
    const events = await prisma.runEvent.findMany({ where: { runId: first.id } });

    expect(second.id).toBe(first.id);
    expect(events).toHaveLength(1);
    await expect(
      prisma.simulationRun.count({
        where: {
          organizationId: fixture.organizationId,
          createdById: fixture.userId,
          createIdempotencyKey: request.idempotencyKey,
        },
      }),
    ).resolves.toBe(1);
  });

  it('在创建事务中途失败时不会留下 Run 或事件', async () => {
    const failingPack = {
      ...runtimeTestPack,
      key: 'runtime-transaction-rollback-test',
      manifest: {
        ...runtimeTestPack.manifest,
        key: 'runtime-transaction-rollback-test',
      },
      initialState: () => {
        throw new Error('Simulated state initialization failure');
      },
    };
    const fixture = await createFixture(failingPack.key);
    const repository = new PrismaRunRepository(prisma);

    await expect(
      repository.createRun(
        {
          organizationId: fixture.organizationId,
          scenarioVersionId: fixture.scenarioVersionId,
          createdById: fixture.userId,
          idempotencyKey: 'create-rollback',
          seed: 17,
          simulatedAt: '2026-07-12T00:00:00.000Z',
        },
        failingPack,
      ),
    ).rejects.toThrow('Simulated state initialization failure');

    await expect(
      prisma.simulationRun.count({
        where: {
          organizationId: fixture.organizationId,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.runEvent.count({
        where: {
          organizationId: fixture.organizationId,
        },
      }),
    ).resolves.toBe(0);
  });

  it('用 Run version 拒绝并发写入', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const run = await createRun(service, fixture, 'concurrent-create');

    const results = await Promise.allSettled([
      service.execute(startCommand(fixture, run.id, 0, 'start-a')),
      service.execute(startCommand(fixture, run.id, 0, 'start-b')),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject<ApplicationError>({
      code: 'RUN_VERSION_CONFLICT',
    });
    await expect(
      prisma.simulationRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({
      status: 'running',
      version: 1,
      latestSequence: 2,
    });
  });

  it('快照含 undefined 状态字段时，创建后仍可读取并启动 Run', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const run = await createRun(service, fixture, 'snapshot-json-normalization');

    await expect(
      service.execute(startCommand(fixture, run.id, 0, 'snapshot-json-normalization-start')),
    ).resolves.toMatchObject({
      result: {
        status: 'accepted',
        events: [expect.objectContaining({ type: 'run.started' })],
      },
    });
  });

  it('v1 快照摘要不匹配时从事件流重建状态并启动 Run', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const run = await createRun(service, fixture, 'legacy-snapshot-rebuild');

    await prisma.stateSnapshot.update({
      where: {
        runId_sequence: {
          runId: run.id,
          sequence: 1,
        },
      },
      data: {
        schemaVersion: 1,
        checksum: 'legacy-checksum-generated-before-json-normalization',
      },
    });

    await expect(
      service.execute(startCommand(fixture, run.id, 0, 'legacy-snapshot-rebuild-start')),
    ).resolves.toMatchObject({
      result: {
        status: 'accepted',
        events: [expect.objectContaining({ type: 'run.started' })],
      },
    });
  });

  it('对同一 Command 幂等键只追加一次事件', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const run = await createRun(service, fixture, 'duplicate-command-create');
    const firstCommand = startCommand(fixture, run.id, 0, 'duplicate-command-start');

    const first = await service.execute(firstCommand);
    const second = await service.execute({
      ...firstCommand,
      commandId: randomUUID(),
      expectedRunVersion: 1,
    });
    const events = await prisma.runEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequence: 'asc' },
    });

    expect(first.result.status).toBe('accepted');
    expect(second.result.status).toBe('duplicate');
    expect(events.map((event) => event.type)).toEqual(['run.created', 'run.started']);
  });

  it('分支从目标 sequence 继承状态，但不复制或改写父 Run 事件', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const parent = await createRun(service, fixture, 'branch-parent-create');
    await service.execute(startCommand(fixture, parent.id, 0, 'branch-parent-start'));
    await service.execute(
      runCommand(fixture, parent.id, 1, 'branch-parent-clock', {
        type: 'advance-clock',
        minutes: 5,
      }),
    );
    const parentBeforeBranch = await prisma.runEvent.findMany({
      where: { runId: parent.id },
      orderBy: { sequence: 'asc' },
    });

    const branch = await service.createBranchRun({
      parentRunId: parent.id,
      organizationId: fixture.organizationId,
      createdById: fixture.userId,
      idempotencyKey: 'branch-create',
      expectedParentRunVersion: 2,
      branchFromSequence: 3,
      name: '五分钟处置备选方案',
    });
    const [persistedBranch, branchEvents, parentAfterBranch, replay] = await Promise.all([
      prisma.simulationRun.findUniqueOrThrow({ where: { id: branch.id } }),
      prisma.runEvent.findMany({ where: { runId: branch.id }, orderBy: { sequence: 'asc' } }),
      prisma.runEvent.findMany({ where: { runId: parent.id }, orderBy: { sequence: 'asc' } }),
      service.getReplay(branch.id, fixture.organizationId),
    ]);

    expect(persistedBranch).toMatchObject({
      parentRunId: parent.id,
      branchFromSequence: 3,
      latestSequence: 1,
      virtualTime: 5,
    });
    expect(branchEvents).toHaveLength(1);
    expect(branchEvents[0]).toMatchObject({ sequence: 1, type: 'run.created' });
    expect(parentAfterBranch.slice(0, parentBeforeBranch.length)).toEqual(parentBeforeBranch);
    expect(parentAfterBranch.at(-1)).toMatchObject({
      type: 'branch.created',
      payload: expect.objectContaining({
        childRunId: branch.id,
        branchFromSequence: 3,
      }),
    });
    expect(replay.state).toMatchObject({
      run: {
        runId: branch.id,
        status: 'created',
        latestSequence: 1,
        virtualTimeMinutes: 5,
      },
    });
  });

  it('Snapshot 回放与完整事件重放得到一致的 Run 状态', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const run = await createRun(service, fixture, 'replay-consistency-create');
    await service.execute(startCommand(fixture, run.id, 0, 'replay-consistency-start'));
    await service.execute(
      runCommand(fixture, run.id, 1, 'replay-consistency-clock', {
        type: 'advance-clock',
        minutes: 3,
      }),
    );
    await service.execute(
      runCommand(fixture, run.id, 2, 'replay-consistency-checkpoint', {
        type: 'create-checkpoint',
        label: '三分钟检查点',
      }),
    );

    const snapshotReplay = await service.getReplay(run.id, fixture.organizationId);
    await prisma.stateSnapshot.deleteMany({ where: { runId: run.id } });
    const fullReplay = await service.getReplay(run.id, fixture.organizationId);

    expect(snapshotReplay.source).toBe('snapshot');
    expect(fullReplay.source).toBe('full');
    expect(fullReplay.state).toEqual(snapshotReplay.state);
  });

  it('在没有处理器时保持 Outbox 消息待重试', async () => {
    const fixture = await createFixture();
    const repository = new PrismaRunRepository(prisma);
    const outbox = await prisma.outboxMessage.create({
      data: {
        organizationId: fixture.organizationId,
        topic: 'unknown.topic',
        payload: { value: 'test' },
      },
    });
    const publisher = new RuntimeOutboxPublisher(repository, new RunEventHub());

    // Outbox 是跨 Run 的全局队列；开发库中可能同时存在其他待处理消息。
    // 这里验证目标消息的最终状态，不把批次大小当作测试前提。
    await expect(publisher.publishPending()).resolves.toBeGreaterThanOrEqual(1);

    await expect(
      prisma.outboxMessage.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({
      attempts: 1,
      publishedAt: null,
      lockedAt: null,
      lastError: expect.stringContaining('No Outbox handler'),
    });
  });

  it('以数据库 Cursor 回补事件，并忽略 Hub 中的重复通知', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const hub = new RunEventHub();
    const run = await createRun(service, fixture, 'stream-create');
    const controller = new AbortController();
    const stream = service.streamEvents(run.id, fixture.organizationId, 1, hub, controller.signal);

    const nextEvent = stream.next();
    await service.execute(startCommand(fixture, run.id, 0, 'stream-start'));
    const persistedEvent = await prisma.runEvent.findUniqueOrThrow({
      where: {
        runId_sequence: {
          runId: run.id,
          sequence: 2,
        },
      },
    });
    const envelope = {
      cursor: persistedEvent.sequence,
      event: {
        id: persistedEvent.id,
        organizationId: persistedEvent.organizationId,
        runId: persistedEvent.runId,
        sequence: persistedEvent.sequence,
        type: persistedEvent.type,
        version: persistedEvent.version,
        source: persistedEvent.source,
        simulatedAt: persistedEvent.simulatedAt.toISOString(),
        recordedAt: persistedEvent.recordedAt.toISOString(),
        idempotencyKey: persistedEvent.idempotencyKey,
        payload: persistedEvent.payload,
      },
    };

    hub.publish(envelope);
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        cursor: 2,
        event: {
          type: 'run.started',
        },
      },
    });

    const duplicateWait = stream.next();
    hub.publish(envelope);
    await expect(
      Promise.race([
        duplicateWait.then(() => 'yielded'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 25)),
      ]),
    ).resolves.toBe('waiting');

    controller.abort();
    await expect(duplicateWait).resolves.toMatchObject({ done: true });
  });

  it('持久化调度指令并以 generation 防止 Pause 后的旧 tick 推进', async () => {
    const fixture = await createFixture();
    const repository = new PrismaRunRepository(prisma);
    const service = new RunApplicationService(repository, registry);
    const scheduler = new ManualRunScheduler();
    const publisher = new RuntimeOutboxPublisher(
      repository,
      new RunEventHub(),
      schedulerHandlers(scheduler, service),
    );
    const run = await createRun(service, fixture, 'scheduler-lifecycle-create');

    await service.execute(startCommand(fixture, run.id, 0, 'scheduler-start'));
    await publisher.publishPending(100);

    expect(scheduler.started).toEqual([
      expect.objectContaining({
        runId: run.id,
        organizationId: fixture.organizationId,
        generation: 1,
        intervalSeconds: 1,
        firstTickIndex: 1,
      }),
    ]);

    const firstTick = scheduler.takeNextTick(run.id);
    expect(firstTick).toMatchObject({ generation: 1, tickIndex: 1 });
    const tickExecution = await service.executeScheduledTick({
      ...firstTick!,
      minutes: 1,
      issuedAt: '2026-07-12T00:01:00.000Z',
    });
    expect(tickExecution?.result.status).toBe('accepted');
    await expect(service.getRun(run.id, fixture.organizationId)).resolves.toMatchObject({
      virtualTime: 1,
      nextTickIndex: 1,
      schedulerGeneration: 1,
    });
    await expect(
      prisma.runEvent.findUnique({
        where: {
          runId_idempotencyKey: {
            runId: run.id,
            idempotencyKey: createScheduledTickIdempotencyKey({
              runId: run.id,
              generation: 1,
              tickIndex: 1,
            }),
          },
        },
      }),
    ).resolves.toMatchObject({ type: 'clock.advanced' });

    const staleTick = scheduler.takeNextTick(run.id);
    await service.execute(runCommand(fixture, run.id, 2, 'scheduler-pause', { type: 'pause-run' }));
    await publisher.publishPending(100);
    expect(scheduler.cancelled).toEqual([
      {
        runId: run.id,
        organizationId: fixture.organizationId,
        generation: 2,
      },
    ]);
    expect(scheduler.takeNextTick(run.id)).toBeUndefined();
    await expect(
      service.executeScheduledTick({
        ...staleTick!,
        minutes: 1,
        issuedAt: '2026-07-12T00:02:00.000Z',
      }),
    ).resolves.toBeUndefined();

    await service.execute(
      runCommand(fixture, run.id, 3, 'scheduler-resume', { type: 'resume-run' }),
    );
    await publisher.publishPending(100);
    expect(scheduler.started.at(-1)).toMatchObject({
      generation: 3,
      firstTickIndex: 2,
    });
    await expect(
      service.executeScheduledTick({
        ...staleTick!,
        minutes: 1,
        issuedAt: '2026-07-12T00:03:00.000Z',
      }),
    ).resolves.toBeUndefined();

    const resumedTick = scheduler.takeNextTick(run.id);
    await expect(
      service.executeScheduledTick({
        ...resumedTick!,
        minutes: 1,
        issuedAt: '2026-07-12T00:04:00.000Z',
      }),
    ).resolves.toMatchObject({ result: { status: 'accepted' } });
    await expect(service.getRun(run.id, fixture.organizationId)).resolves.toMatchObject({
      virtualTime: 2,
      nextTickIndex: 2,
      schedulerGeneration: 3,
    });
  });

  it('有效租约阻止重复 start，过期后从已持久化 tick 的下一序号恢复', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const firstScheduler = new ManualRunScheduler();
    const run = await createRun(service, fixture, 'scheduler-reconcile-create');
    await service.execute(startCommand(fixture, run.id, 0, 'scheduler-reconcile-start'));

    await expect(service.reconcileRunningRuns(firstScheduler)).resolves.toBe(1);
    const firstTick = firstScheduler.takeNextTick(run.id);
    expect(firstTick).toMatchObject({ generation: 1, tickIndex: 1 });
    await expect(
      service.executeScheduledTick({
        ...firstTick!,
        minutes: 1,
        issuedAt: '2026-07-12T00:01:00.000Z',
      }),
    ).resolves.toMatchObject({ result: { status: 'accepted' } });

    const duplicateScheduler = new ManualRunScheduler();
    await expect(service.reconcileRunningRuns(duplicateScheduler)).resolves.toBe(0);
    expect(duplicateScheduler.started).toEqual([]);

    await prisma.runScheduleLease.update({
      where: { runId: run.id },
      data: {
        heartbeatAt: new Date('2026-07-11T23:59:00.000Z'),
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      },
    });
    const recoveredScheduler = new ManualRunScheduler();
    await expect(service.reconcileRunningRuns(recoveredScheduler)).resolves.toBe(1);
    expect(recoveredScheduler.started).toEqual([
      expect.objectContaining({ generation: 1, firstTickIndex: 2 }),
    ]);
    expect(recoveredScheduler.takeNextTick(run.id)).toMatchObject({
      generation: 1,
      tickIndex: 2,
    });

    await service.execute(
      runCommand(fixture, run.id, 2, 'scheduler-reconcile-pause', {
        type: 'pause-run',
      }),
    );
    await expect(service.getLatestRunningRuns()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: run.id })]),
    );
    await expect(service.reconcileRunningRuns(recoveredScheduler)).resolves.toBe(0);
  });

  it('并发 claim 只有一个 winner，takeover 后旧 holder 无法续租、tick 或 release', async () => {
    const fixture = await createFixture();
    const repository = new PrismaRunRepository(prisma);
    const service = new RunApplicationService(repository, registry);
    const run = await createRun(service, fixture, 'scheduler-fencing-create');
    await service.execute(startCommand(fixture, run.id, 0, 'scheduler-fencing-start'));

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.claimRunSchedule({
          runId: run.id,
          organizationId: fixture.organizationId,
          generation: 1,
        }),
      ),
    );
    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'active')).toHaveLength(7);
    const first = claims.find((claim) => claim.status === 'claimed');
    if (!first || first.status !== 'claimed') throw new Error('Expected claimed lease.');

    const expiredAt = new Date('2026-07-12T00:00:00.000Z');
    await prisma.runScheduleLease.update({
      where: { runId: run.id },
      data: { heartbeatAt: new Date('2026-07-11T23:59:00.000Z'), expiresAt: expiredAt },
    });
    await expect(repository.renewRunSchedule(first.lease, expiredAt)).resolves.toBe(false);
    await expect(repository.releaseRunSchedule(first.lease, expiredAt)).resolves.toBe(false);

    const takeoverNow = new Date();
    const takeover = await repository.claimRunSchedule(
      { runId: run.id, organizationId: fixture.organizationId, generation: 1 },
      takeoverNow,
    );
    expect(takeover.status).toBe('claimed');
    if (takeover.status !== 'claimed') throw new Error('Expected takeover.');
    expect(takeover.lease.holderId).not.toBe(first.lease.holderId);

    await expect(
      service.executeScheduledTick({
        runId: run.id,
        organizationId: fixture.organizationId,
        generation: 1,
        tickIndex: 1,
        holderId: first.lease.holderId,
        minutes: 1,
        issuedAt: '2026-07-12T00:01:00.000Z',
      }),
    ).resolves.toMatchObject({ result: { status: 'duplicate', events: [] } });
    await expect(repository.releaseRunSchedule(first.lease)).resolves.toBe(false);
    await expect(repository.renewRunSchedule(takeover.lease)).resolves.toBe(true);
    await expect(
      service.executeScheduledTick({
        ...takeover.lease,
        tickIndex: 1,
        minutes: 1,
        issuedAt: '2026-07-12T00:01:01.000Z',
      }),
    ).resolves.toMatchObject({ result: { status: 'accepted' } });
  });

  it('running run 查询限制批量并按最旧更新时间排序', async () => {
    const fixture = await createFixture();
    const service = createRunService();
    const first = await createRun(service, fixture, 'running-query-first');
    const second = await createRun(service, fixture, 'running-query-second');
    await service.execute(startCommand(fixture, first.id, 0, 'running-query-first-start'));
    await service.execute(startCommand(fixture, second.id, 0, 'running-query-second-start'));
    await prisma.simulationRun.update({
      where: { id: first.id },
      data: { updatedAt: new Date('2026-07-12T00:00:00.000Z') },
    });
    await prisma.simulationRun.update({
      where: { id: second.id },
      data: { updatedAt: new Date('2026-07-12T00:01:00.000Z') },
    });

    const running = await service.getLatestRunningRuns(1);
    expect(running.map((item) => item.id)).toEqual([first.id]);
  });
});

function createRunService() {
  return new RunApplicationService(new PrismaRunRepository(prisma), registry);
}

async function createFixture(packKey = runtimeTestPack.key) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      slug: `runtime-${suffix}`,
      name: 'Runtime integration organization',
    },
  });
  organizationIds.push(organization.id);

  const user = await prisma.user.create({
    data: {
      email: `runtime-${suffix}@example.com`,
    },
  });
  userIds.push(user.id);

  const scenario = await prisma.scenario.create({
    data: {
      organizationId: organization.id,
      key: `runtime-${suffix}`,
      name: 'Runtime integration scenario',
      description: 'Runtime integration scenario',
      status: 'published',
    },
  });
  const scenarioVersion = await prisma.scenarioVersion.create({
    data: {
      scenarioId: scenario.id,
      version: 1,
      config: {
        packKey,
        tickIntervalSeconds: 1,
      },
      publishedAt: new Date(),
    },
  });

  return {
    organizationId: organization.id,
    scenarioVersionId: scenarioVersion.id,
    userId: user.id,
  };
}

async function createRun(
  service: RunApplicationService,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  idempotencyKey: string,
) {
  return service.createRun({
    organizationId: fixture.organizationId,
    scenarioVersionId: fixture.scenarioVersionId,
    createdById: fixture.userId,
    idempotencyKey,
    seed: 13,
    simulatedAt: '2026-07-12T00:00:00.000Z',
  });
}

function schedulerHandlers(
  scheduler: ManualRunScheduler,
  service?: RunApplicationService,
): Readonly<Record<string, OutboxMessageHandler>> {
  return {
    'run.scheduler.start': {
      async handle(message: ClaimedOutboxMessage) {
        const instruction = message.payload as Extract<SchedulerInstruction, { type: 'start' }>;
        const claim = service
          ? await service.claimRunSchedule({
              runId: instruction.runId,
              organizationId: message.organizationId,
              generation: instruction.generation,
            })
          : undefined;
        await scheduler.start(
          claim?.status === 'claimed'
            ? claim.lease
            : {
                runId: instruction.runId,
                organizationId: message.organizationId,
                generation: instruction.generation,
                intervalSeconds: instruction.intervalSeconds,
                firstTickIndex: instruction.firstTickIndex,
                holderId: randomUUID(),
              },
        );
      },
    },
    'run.scheduler.cancel': {
      async handle(message: ClaimedOutboxMessage) {
        const instruction = message.payload as Extract<SchedulerInstruction, { type: 'cancel' }>;
        await scheduler.cancel({
          runId: instruction.runId,
          organizationId: message.organizationId,
          generation: instruction.generation,
        });
      },
    },
  };
}

function runCommand(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runId: string,
  expectedRunVersion: number,
  idempotencyKey: string,
  payload: RunCommand['payload'],
): RunCommand {
  const actor: ActorRef = {
    id: fixture.userId,
    type: 'user',
    organizationId: fixture.organizationId,
    displayName: 'Runtime integration operator',
  };
  return {
    commandId: randomUUID(),
    organizationId: fixture.organizationId,
    runId,
    actor,
    expectedRunVersion,
    idempotencyKey,
    issuedAt: '2026-07-12T00:00:01.000Z',
    payload,
  };
}

function startCommand(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runId: string,
  expectedRunVersion: number,
  idempotencyKey: string,
): RunCommand {
  return runCommand(fixture, runId, expectedRunVersion, idempotencyKey, {
    type: 'start-run',
  });
}
