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

  it('send exception 会持久化 failed trace 且不改变 Run', async () => {
    const fixture = await createAgentFixture();
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
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
    await expect(
      prisma.simulationRun.findUniqueOrThrow({ where: { id: fixture.runId } }),
    ).resolves.toMatchObject({
      version: before.version,
      latestSequence: before.latestSequence,
      virtualTime: before.virtualTime,
    });
  });

  it('result exception 会持久化 failed trace 且保留原异常', async () => {
    const fixture = await createAgentFixture();
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

    const second = await prisma.runParticipant.create({
      data: { runId: fixture.runId, key: 'second', displayName: 'Second', controller: 'agent' },
    });
    const secondHandle = await store.loadOrCreate(second.id, 'director');
    await store.persist(secondHandle, { streamIndex: 1 }, 'failed', [
      { type: 'adapter.send_failed', data: {} },
    ]);
    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(2);
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
        async send<T>() {
          if (stage === 'send') throw new Error('send failed');
          return {
            async result() {
              throw new Error('result failed');
            },
          } as { result(): Promise<never> };
        },
      };
    },
  };
}
function fakeSessions(input: {
  status: 'completed' | 'failed';
  data: unknown;
  eventType?: string;
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
                events: [{ type: input.eventType ?? 'session.completed', data: {} }] as never[],
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
  return { organizationId: organization.id, runId: run.id, participantId: participant.id };
}
