import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import {
  EveAgentRuntime,
  PrismaAgentRuntimeStore,
  type EveSessionFactory,
} from './eve-agent-runtime';

const organizations: string[] = [];

beforeEach(async () => {
  if (organizations.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizations.splice(0) } } });
  }
});
afterAll(async () => prisma.$disconnect());

describe('EveAgentRuntime contract', () => {
  it('持久化 session/trace 并只返回校验后的 ProposedAction', async () => {
    const fixture = await createAgentFixture();
    const proposal = {
      participantId: fixture.participantId,
      actionType: 'publish_status',
      parameters: {},
      rationale: 'Update customers.',
      evidenceRefs: [],
      confidence: 0.9,
      clientRequestId: 'request-1',
    };
    const runtime = new EveAgentRuntime(
      fakeSessions({ status: 'completed', data: proposal }),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });
    const result = await runtime.sendObservation(handle, observation(fixture));

    expect(result.proposedAction).toEqual(proposal);
    expect(result.handle).toMatchObject({ sessionId: 'session-1', streamIndex: 1 });
    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(1);
    await expect(prisma.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
  });

  it('记录 Agent Turn、延迟和 Eve 返回的 Token 与费用', async () => {
    const fixture = await createAgentFixture();
    const proposal = {
      participantId: fixture.participantId,
      actionType: 'publish_status',
      parameters: {},
      rationale: 'Update customers.',
      evidenceRefs: [],
      confidence: 0.9,
      clientRequestId: 'request-usage',
    };
    const runtime = new EveAgentRuntime(
      fakeSessions({
        status: 'completed',
        data: proposal,
        events: [
          {
            type: 'step.completed',
            data: {
              usage: {
                inputTokens: 120,
                outputTokens: 45,
                cacheReadTokens: 20,
                cacheWriteTokens: 10,
                costUsd: 0.0012,
              },
            },
          },
          {
            type: 'step.completed',
            data: { usage: { inputTokens: 30, outputTokens: 5, costUsd: 0.0003 } },
          },
          { type: 'tool.completed', data: { name: 'read_run_state' } },
          { type: 'subagent.completed', data: { name: 'risk_analyst' } },
        ],
      }),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });

    await runtime.sendObservation(handle, observation(fixture));

    const ledger = await prisma.usageLedger.findMany({
      where: { runId: fixture.runId },
      select: { category: true, quantity: true, unit: true, metadata: true },
    });
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'agent_turns', quantity: 1, unit: 'turn' }),
        expect.objectContaining({ category: 'agent_input_tokens', quantity: 150, unit: 'token' }),
        expect.objectContaining({ category: 'agent_output_tokens', quantity: 50, unit: 'token' }),
        expect.objectContaining({
          category: 'agent_cache_read_tokens',
          quantity: 20,
          unit: 'token',
        }),
        expect.objectContaining({
          category: 'agent_cache_write_tokens',
          quantity: 10,
          unit: 'token',
        }),
        expect.objectContaining({
          category: 'agent_cost_micro_usd',
          quantity: 1500,
          unit: 'micro_usd',
        }),
        expect.objectContaining({ category: 'agent_tool_steps', quantity: 1, unit: 'step' }),
        expect.objectContaining({ category: 'agent_subagent_steps', quantity: 1, unit: 'step' }),
        expect.objectContaining({ category: 'agent_latency_ms', unit: 'ms' }),
      ]),
    );
    const latency = ledger.find((entry) => entry.category === 'agent_latency_ms');
    expect(latency?.quantity).toBeGreaterThanOrEqual(0);
    const turn = ledger.find((entry) => entry.category === 'agent_turns');
    expect(turn?.metadata).toMatchObject({
      provider: 'eve',
      agentKey: 'director',
      completedSteps: 2,
    });
  });

  it('缺少 Provider 用量时仍记录 Agent Turn 和延迟，且不伪造 Token 或费用', async () => {
    const fixture = await createAgentFixture();
    const runtime = new EveAgentRuntime(
      fakeSessions({
        status: 'completed',
        data: {
          participantId: fixture.participantId,
          actionType: 'publish_status',
          parameters: {},
          rationale: 'Update customers.',
          evidenceRefs: [],
          confidence: 0.9,
          clientRequestId: 'request-no-usage',
        },
      }),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });

    await runtime.sendObservation(handle, observation(fixture));

    const categories = (
      await prisma.usageLedger.findMany({
        where: { runId: fixture.runId },
        select: { category: true },
      })
    ).map((entry) => entry.category);
    expect(categories).toEqual(expect.arrayContaining(['agent_turns', 'agent_latency_ms']));
    expect(categories).not.toEqual(
      expect.arrayContaining(['agent_input_tokens', 'agent_output_tokens', 'agent_cost_micro_usd']),
    );
  });

  it('重放同一 Turn 时不会重复累计用量账本', async () => {
    const fixture = await createAgentFixture();
    const store = new PrismaAgentRuntimeStore(prisma);
    const handle = await store.loadOrCreate(fixture.participantId, 'director');
    const telemetry = {
      elapsedMilliseconds: 12,
      usage: {
        completedSteps: 1,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.001,
      },
    };

    await store.persist(
      handle,
      { sessionId: 'session-1', streamIndex: 1 },
      'completed',
      [{ type: 'step.completed', data: {} }],
      undefined,
      telemetry,
    );
    await store.persist(
      handle,
      { sessionId: 'session-1', streamIndex: 1 },
      'completed',
      [{ type: 'step.completed', data: {} }],
      undefined,
      telemetry,
    );

    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(1);
    await expect(prisma.usageLedger.count({ where: { runId: fixture.runId } })).resolves.toBe(5);
  });

  it('Provider 未返回流事件时仍通过 Turn 锚点记录遥测', async () => {
    const fixture = await createAgentFixture();
    const store = new PrismaAgentRuntimeStore(prisma);
    const handle = await store.loadOrCreate(fixture.participantId, 'director');

    await store.persist(
      handle,
      { sessionId: 'session-1', streamIndex: 1 },
      'completed',
      [],
      undefined,
      {
        elapsedMilliseconds: 12,
        usage: { completedSteps: 0 },
      },
    );

    await expect(
      prisma.agentTrace.findFirstOrThrow({ where: { runId: fixture.runId } }),
    ).resolves.toMatchObject({ eventType: 'adapter.turn_completed' });
    await expect(prisma.usageLedger.count({ where: { runId: fixture.runId } })).resolves.toBe(2);
  });

  it('send exception 会持久化 failed trace 且不改变 Run', async () => {
    const fixture = await createAgentFixture();
    const before = await readWorldPersistence(fixture.runId);
    const runtime = new EveAgentRuntime(
      throwingSessions('send'),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });

    await expect(runtime.sendObservation(handle, observation(fixture))).rejects.toThrow(
      'send failed',
    );
    await expect(runtime.getStatus(handle)).resolves.toBe('failed');
    await expect(
      prisma.agentTrace.findFirstOrThrow({ where: { runId: fixture.runId } }),
    ).resolves.toMatchObject({ eventType: 'adapter.send_failed' });
    await expect(prisma.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
    expect(await readWorldPersistence(fixture.runId)).toEqual(before);
  });

  it('result exception 会持久化 failed trace 且保留原异常', async () => {
    const fixture = await createAgentFixture();
    const before = await readWorldPersistence(fixture.runId);
    const runtime = new EveAgentRuntime(
      throwingSessions('result'),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });

    await expect(runtime.sendObservation(handle, observation(fixture))).rejects.toThrow(
      'result failed',
    );
    await expect(runtime.getStatus(handle)).resolves.toBe('failed');
    await expect(
      prisma.agentTrace.findFirstOrThrow({ where: { runId: fixture.runId } }),
    ).resolves.toMatchObject({ eventType: 'adapter.result_failed' });
    expect(await readWorldPersistence(fixture.runId)).toEqual(before);
  });

  it('answerInput 继续使用首次 Observation 的 participant/action allowlist', async () => {
    const fixture = await createAgentFixture();
    const sessions = queuedSessions([
      { status: 'waiting', data: undefined },
      {
        status: 'completed',
        data: {
          participantId: fixture.participantId,
          actionType: 'delete_run',
          parameters: {},
          rationale: 'invalid',
          evidenceRefs: [],
          confidence: 1,
          clientRequestId: 'request-2',
        },
      },
    ]);
    const runtime = new EveAgentRuntime(sessions, new PrismaAgentRuntimeStore(prisma));
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });
    const waiting = await runtime.sendObservation(handle, observation(fixture));

    await expect(
      runtime.answerInput(waiting.handle, { requestId: 'approval', optionId: 'approve' }),
    ).rejects.toThrow('not available');
    await expect(runtime.getStatus(waiting.handle)).resolves.toBe('failed');
  });

  it('answerInput 拒绝与首次 Observation 不同的 participant', async () => {
    const fixture = await createAgentFixture();
    const sessions = queuedSessions([
      { status: 'waiting', data: undefined },
      {
        status: 'completed',
        data: {
          participantId: randomUUID(),
          actionType: 'publish_status',
          parameters: {},
          rationale: 'wrong participant',
          evidenceRefs: [],
          confidence: 1,
          clientRequestId: 'request-3',
        },
      },
    ]);
    const runtime = new EveAgentRuntime(sessions, new PrismaAgentRuntimeStore(prisma));
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });
    const waiting = await runtime.sendObservation(handle, observation(fixture));

    await expect(
      runtime.answerInput(waiting.handle, { requestId: 'approval', optionId: 'approve' }),
    ).rejects.toThrow('does not match');
    await expect(runtime.getStatus(waiting.handle)).resolves.toBe('failed');
  });

  it('并发 replay 与 null session 使用确定性 identity 去重', async () => {
    const fixture = await createAgentFixture();
    const store = new PrismaAgentRuntimeStore(prisma);
    const handle = await store.loadOrCreate(fixture.participantId, 'director');
    await Promise.all([
      store.persist(handle, { streamIndex: 1 }, 'failed', [
        { type: 'adapter.send_failed', data: {} },
      ]),
      store.persist(handle, { streamIndex: 1 }, 'failed', [
        { type: 'adapter.send_failed', data: {} },
      ]),
    ]);
    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(1);

    const observerHandle = await store.loadOrCreate(fixture.participantId, 'observer');
    await store.persist(observerHandle, { streamIndex: 1 }, 'failed', [
      { type: 'adapter.send_failed', data: {} },
    ]);
    const sameParticipantTraces = await prisma.agentTrace.findMany({
      where: { runId: fixture.runId, runParticipantId: fixture.participantId },
      select: { traceIdentity: true, sessionId: true },
    });
    expect(sameParticipantTraces).toHaveLength(2);
    expect(sameParticipantTraces.every((trace) => trace.sessionId === null)).toBe(true);
    expect(new Set(sameParticipantTraces.map((trace) => trace.traceIdentity)).size).toBe(2);

    const second = await prisma.runParticipant.create({
      data: { runId: fixture.runId, key: 'second', displayName: 'Second', controller: 'agent' },
    });
    const secondHandle = await store.loadOrCreate(second.id, 'director');
    await store.persist(secondHandle, { streamIndex: 1 }, 'failed', [
      { type: 'adapter.send_failed', data: {} },
    ]);
    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(3);
  });
});

function queuedSessions(
  turns: Array<{ status: 'completed' | 'failed' | 'waiting'; data: unknown }>,
): EveSessionFactory {
  let index = 0;
  return {
    session() {
      const turn = turns[index++]!;
      return {
        state: { sessionId: 'session-1', continuationToken: 'token-1', streamIndex: index },
        async send<T>() {
          return {
            async result() {
              return {
                data: turn.data as T,
                message: undefined,
                events: [{ type: `session.${turn.status}`, data: {} }] as never[],
                inputRequests:
                  turn.status === 'waiting'
                    ? ([{ requestId: 'approval', prompt: 'Approve?' }] as never[])
                    : [],
                sessionId: 'session-1',
                status: turn.status,
              };
            },
          };
        },
      };
    },
  };
}

function throwingSessions(stage: 'send' | 'result'): EveSessionFactory {
  return {
    session() {
      return {
        state: { streamIndex: 0 },
        async send<T>(): Promise<{ result(): Promise<T> }> {
          if (stage === 'send') throw new Error('send failed');
          return {
            async result(): Promise<T> {
              throw new Error('result failed');
            },
          };
        },
      };
    },
  };
}
function fakeSessions(input: {
  status: 'completed' | 'failed';
  data: unknown;
  eventType?: string;
  events?: Array<{ type: string; data?: unknown }>;
}): EveSessionFactory {
  return {
    session() {
      return {
        state: { sessionId: 'session-1', continuationToken: 'token-1', streamIndex: 1 },
        async send<T>() {
          return {
            async result() {
              return {
                data: input.data as T,
                message: undefined,
                events: (input.events ?? [
                  { type: input.eventType ?? 'session.completed', data: {} },
                ]) as never[],
                inputRequests: [],
                sessionId: 'session-1',
                status: input.status,
              };
            },
          };
        },
      };
    },
  };
}

function observation(fixture: { organizationId: string; runId: string; participantId: string }) {
  return {
    organizationId: fixture.organizationId,
    runId: fixture.runId,
    participant: {
      id: fixture.participantId,
      key: 'support',
      displayName: 'Support',
      objectives: ['communicate'],
    },
    virtualTimeMinutes: 0,
    visibleState: {},
    visibleSignals: [],
    recentEvents: [],
    availableActions: [{ type: 'publish_status', label: 'Publish', parameterSchema: {} }],
    budget: { remainingTurns: 1, remainingTokens: 1000 },
  };
}

async function createAgentFixture() {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: { slug: `eve-${suffix}`, name: 'Eve' },
  });
  organizations.push(organization.id);
  const user = await prisma.user.create({ data: { email: `eve-${suffix}@example.com` } });
  const scenario = await prisma.scenario.create({
    data: {
      organizationId: organization.id,
      key: `eve-${suffix}`,
      name: 'Eve',
      description: 'Eve',
    },
  });
  const version = await prisma.scenarioVersion.create({
    data: { scenarioId: scenario.id, version: 1, config: { packKey: 'test' } },
  });
  const run = await prisma.simulationRun.create({
    data: {
      organizationId: organization.id,
      scenarioVersionId: version.id,
      createdById: user.id,
      seed: 1,
    },
  });
  const participant = await prisma.runParticipant.create({
    data: {
      runId: run.id,
      key: 'support',
      displayName: 'Support',
      controller: 'agent',
      capabilities: ['publish_status'],
    },
  });
  await prisma.participantProjection.create({
    data: {
      runParticipantId: participant.id,
      runId: run.id,
      status: 'active',
      data: { marker: 'participant-world' },
    },
  });
  await prisma.stateSnapshot.create({
    data: {
      runId: run.id,
      sequence: 0,
      state: { marker: 'snapshot-world' },
      checksum: 'stable-checksum',
    },
  });
  return { organizationId: organization.id, runId: run.id, participantId: participant.id };
}

async function readWorldPersistence(runId: string) {
  const [run, events, snapshots, participants] = await Promise.all([
    prisma.simulationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { version: true, latestSequence: true, virtualTime: true },
    }),
    prisma.runEvent.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
    prisma.stateSnapshot.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
    prisma.participantProjection.findMany({
      where: { runId },
      orderBy: { runParticipantId: 'asc' },
    }),
  ]);
  return { run, events, snapshots, participants };
}
