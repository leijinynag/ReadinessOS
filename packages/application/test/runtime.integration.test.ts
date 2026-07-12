import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import { ApplicationError, type ActorRef } from '@readinessos/domain-events';
import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import type { RunCommand } from '@readinessos/simulation-kernel';
import { z } from 'zod';
import {
  InMemoryScenarioPackRegistry,
  PrismaRunRepository,
  RunApplicationService,
  RunEventHub,
  RuntimeOutboxPublisher,
} from '../src/index.js';

const testParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';

const runtimeTestPack: ScenarioPack<{ phase: 'created' | 'running' | 'paused' }> =
  assertScenarioPack({
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
    }),
    initialState: () => ({ phase: 'created' }),
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

    await expect(publisher.publishPending()).resolves.toBe(1);

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

function startCommand(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runId: string,
  expectedRunVersion: number,
  idempotencyKey: string,
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
    payload: {
      type: 'start-run',
    },
  };
}
