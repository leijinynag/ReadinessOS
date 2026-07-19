import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import { AgentRecommendationService } from './agent-recommendation-service';

const organizationIds: string[] = [];

afterEach(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: organizationIds.splice(0) } },
  });
});
afterAll(async () => prisma.$disconnect());

describe('AgentRecommendationService', () => {
  it('合并同一顾问的并发触发，不创建并行 Dispatch', async () => {
    const fixture = await createFixture();
    const service = new AgentRecommendationService(prisma);

    const [first, second] = await Promise.all([
      service.enqueueDispatch({
        ...fixture,
        advisorParticipantId: fixture.advisorId,
        requestKind: 'automatic',
        triggerEventTypes: ['inject.triggered'],
        triggerSequences: [1],
      }),
      service.enqueueDispatch({
        ...fixture,
        advisorParticipantId: fixture.advisorId,
        requestKind: 'compare',
        triggerEventTypes: ['signal.emitted'],
        triggerSequences: [2],
      }),
    ]);

    expect(first.dispatchId).toBeDefined();
    expect(second.dispatchId).toBe(first.dispatchId);
    const dispatches = await prisma.agentDispatch.findMany({ where: { runId: fixture.runId } });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      requestKind: 'compare',
      triggerEventTypes: expect.arrayContaining(['inject.triggered', 'signal.emitted']),
      triggerSequences: expect.arrayContaining([1, 2]),
    });
  });

  it('虚拟时间到期会失效 deferred 建议并返回需要重新分析的顾问', async () => {
    const fixture = await createFixture({ virtualTime: 5 });
    const recommendation = await prisma.agentRecommendation.create({
      data: {
        organizationId: fixture.organizationId,
        runId: fixture.runId,
        advisorParticipantId: fixture.advisorId,
        targetParticipantId: fixture.targetId,
        actionType: 'respond',
        parameters: {},
        rationale: '需要重评。',
        evidenceRefs: [],
        confidence: 0.9,
        triggerEventTypes: ['run.started'],
        triggerSequences: [1],
        observationHash: 'observation',
        baseRunVersion: 1,
        baseVirtualTime: 1,
        expiresAtVirtualTime: 5,
        status: 'deferred',
      },
    });
    const service = new AgentRecommendationService(prisma);

    await expect(service.expireDueRecommendations(fixture.runId, fixture.organizationId)).resolves.toEqual([
      { advisorParticipantId: fixture.advisorId, previousStatus: 'deferred' },
    ]);
    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } }),
    ).resolves.toMatchObject({ status: 'expired' });
    await expect(
      prisma.runEvent.count({ where: { runId: fixture.runId } }),
    ).resolves.toBe(0);
  });
});

async function createFixture(input: { virtualTime?: number } = {}) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: { slug: `agent-recommendation-${suffix}`, name: 'Agent recommendation' },
  });
  organizationIds.push(organization.id);
  const user = await prisma.user.create({
    data: { email: `agent-recommendation-${suffix}@example.com` },
  });
  const scenario = await prisma.scenario.create({
    data: {
      organizationId: organization.id,
      key: `agent-recommendation-${suffix}`,
      name: 'Agent recommendation',
      description: 'Agent recommendation',
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
      status: 'running',
      version: 1,
      virtualTime: input.virtualTime ?? 0,
    },
  });
  const [advisor, target] = await Promise.all([
    prisma.runParticipant.create({
      data: { runId: run.id, key: 'advisor', displayName: 'Advisor', controller: 'agent' },
    }),
    prisma.runParticipant.create({
      data: { runId: run.id, key: 'target', displayName: 'Target', controller: 'human' },
    }),
  ]);
  return {
    organizationId: organization.id,
    runId: run.id,
    advisorId: advisor.id,
    targetId: target.id,
  };
}
