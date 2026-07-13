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

  it('Eve failure 只写 Trace，不改变 WorldState 或 DomainEvent', async () => {
    const fixture = await createAgentFixture();
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const runtime = new EveAgentRuntime(
      fakeSessions({ status: 'failed', data: undefined, eventType: 'session.failed' }),
      new PrismaAgentRuntimeStore(prisma),
    );
    const handle = await runtime.start({
      runParticipantId: fixture.participantId,
      agentKey: 'director',
    });
    const result = await runtime.sendObservation(handle, observation(fixture));
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id: fixture.runId } });

    expect(result).toMatchObject({ status: 'failed', proposedAction: undefined });
    expect(after).toMatchObject({ version: before.version, latestSequence: before.latestSequence });
    await expect(prisma.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
    await expect(prisma.agentTrace.count({ where: { runId: fixture.runId } })).resolves.toBe(1);
  });
});

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
