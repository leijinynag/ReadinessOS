import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import type { ScenarioPack } from '@readinessos/scenario-sdk';
import { recoverStaleAgentDispatches } from './agent-dispatch-queue';
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

  it('Run 版本推进后主动淘汰 pending/deferred 建议，但保留已采纳因果链', async () => {
    const fixture = await createFixture();
    const service = new AgentRecommendationService(prisma);
    const [pending, deferred, adopted] = await Promise.all([
      createPendingRecommendation(fixture, { expiresAtVirtualTime: 8 }),
      createPendingRecommendation(fixture, { expiresAtVirtualTime: 8 }),
      createPendingRecommendation(fixture, { expiresAtVirtualTime: 8 }),
    ]);
    await prisma.agentRecommendation.update({
      where: { id: deferred.id },
      data: { status: 'deferred' },
    });
    await prisma.agentRecommendation.update({
      where: { id: adopted.id },
      data: { status: 'adopted' },
    });
    await prisma.simulationRun.update({
      where: { id: fixture.runId },
      data: { version: 2 },
    });

    await expect(
      service.supersedeStaleRecommendations(fixture.runId, fixture.organizationId),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: pending.id, advisorParticipantId: fixture.advisorId },
        { id: deferred.id, advisorParticipantId: fixture.advisorId },
      ]),
    );

    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: pending.id } }),
    ).resolves.toMatchObject({ status: 'superseded' });
    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: deferred.id } }),
    ).resolves.toMatchObject({ status: 'superseded' });
    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: adopted.id } }),
    ).resolves.toMatchObject({ status: 'adopted' });
    await expect(
      prisma.agentActivity.count({
        where: {
          runId: fixture.runId,
          type: 'agent.recommendation_superseded',
        },
      }),
    ).resolves.toBe(2);
  });

  it('拒绝和延后建议只写入 Agent 审计，不产生权威领域事件', async () => {
    const fixture = await createFixture({ virtualTime: 4 });
    const service = new AgentRecommendationService(prisma);
    const [rejected, deferred] = await Promise.all([
      createPendingRecommendation(fixture, { expiresAtVirtualTime: 9 }),
      createPendingRecommendation(fixture, { expiresAtVirtualTime: 9 }),
    ]);

    await service.decide({
      runId: fixture.runId,
      organizationId: fixture.organizationId,
      recommendationId: rejected.id,
      actor: actor(fixture),
      decision: 'reject',
      rationale: '先确认故障来源。',
      pack: {} as ScenarioPack<unknown>,
    });
    await service.decide({
      runId: fixture.runId,
      organizationId: fixture.organizationId,
      recommendationId: deferred.id,
      actor: actor(fixture),
      decision: 'defer',
      deferMinutes: 3,
      rationale: '等待 provider 更新。',
      pack: {} as ScenarioPack<unknown>,
    });

    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: rejected.id } }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: deferred.id } }),
    ).resolves.toMatchObject({ status: 'deferred', expiresAtVirtualTime: 7 });
    await expect(prisma.decision.count({ where: { runId: fixture.runId } })).resolves.toBe(2);
    await expect(prisma.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
  });

  it('Kernel 拒绝已采纳建议时保留 IC 裁决，并使建议失效', async () => {
    const fixture = await createFixture();
    const service = new AgentRecommendationService(prisma);
    const recommendation = await createPendingRecommendation(fixture, {
      expiresAtVirtualTime: 5,
    });
    const commandId = randomUUID();

    await expect(
      service.decide({
        runId: fixture.runId,
        organizationId: fixture.organizationId,
        recommendationId: recommendation.id,
        actor: actor(fixture),
        decision: 'adopt',
        pack: packForFixture(fixture),
        executeAction: async () => ({
          commandId,
          latestSequence: 0,
          rejected: true,
        }),
      }),
    ).resolves.toEqual({ executionSequence: 0 });

    await expect(
      prisma.agentRecommendation.findUniqueOrThrow({ where: { id: recommendation.id } }),
    ).resolves.toMatchObject({ status: 'superseded' });
    await expect(
      prisma.decision.findFirstOrThrow({ where: { recommendationId: recommendation.id } }),
    ).resolves.toMatchObject({
      agentDecisionType: 'adopt',
      kernelCommandId: commandId,
      executionSequence: 0,
    });
    await expect(
      prisma.agentActivity.findFirstOrThrow({
        where: {
          runId: fixture.runId,
          recommendationId: recommendation.id,
          type: 'agent.recommendation_kernel_rejected',
        },
      }),
    ).resolves.toMatchObject({
      data: expect.objectContaining({ commandId, executionSequence: 0 }),
    });
    await expect(prisma.runEvent.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
  });

  it('只恢复超时的 running Dispatch，并通过 Outbox 重新投递', async () => {
    const fixture = await createFixture();
    const now = new Date('2026-07-19T12:00:00.000Z');
    const [staleDispatch, activeDispatch] = await Promise.all([
      prisma.agentDispatch.create({
        data: {
          organizationId: fixture.organizationId,
          runId: fixture.runId,
          advisorParticipantId: fixture.advisorId,
          status: 'running',
          activeKey: `${fixture.runId}:${fixture.advisorId}`,
          baseRunVersion: 1,
          lockedAt: new Date(now.getTime() - 5 * 60 * 1_000 - 1),
        },
      }),
      prisma.agentDispatch.create({
        data: {
          organizationId: fixture.organizationId,
          runId: fixture.runId,
          advisorParticipantId: fixture.secondAdvisorId,
          status: 'running',
          activeKey: `${fixture.runId}:${fixture.secondAdvisorId}`,
          baseRunVersion: 1,
          lockedAt: new Date(now.getTime() - 5 * 60 * 1_000 + 1),
        },
      }),
    ]);

    await expect(
      recoverStaleAgentDispatches({
        now,
        lockTimeoutMs: 5 * 60 * 1_000,
        organizationId: fixture.organizationId,
        runId: fixture.runId,
      }),
    ).resolves.toBe(1);

    await expect(
      prisma.agentDispatch.findUniqueOrThrow({ where: { id: staleDispatch.id } }),
    ).resolves.toMatchObject({
      status: 'pending',
      lockedAt: null,
      nextAttemptAt: now,
    });
    await expect(
      prisma.agentDispatch.findUniqueOrThrow({ where: { id: activeDispatch.id } }),
    ).resolves.toMatchObject({
      status: 'running',
      lockedAt: new Date(now.getTime() - 5 * 60 * 1_000 + 1),
    });
    await expect(
      prisma.agentActivity.findFirstOrThrow({
        where: { runId: fixture.runId, dispatchId: staleDispatch.id, type: 'agent.dispatch_recovered' },
      }),
    ).resolves.toMatchObject({
      data: expect.objectContaining({
        recoveredAt: now.toISOString(),
      }),
    });
    await expect(
      prisma.outboxMessage.findFirstOrThrow({
        where: { runId: fixture.runId, topic: 'agent.dispatch', payload: { path: ['dispatchId'], equals: staleDispatch.id } },
      }),
    ).resolves.toMatchObject({
      organizationId: fixture.organizationId,
    });
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
  const [advisor, secondAdvisor, target] = await Promise.all([
    prisma.runParticipant.create({
      data: { runId: run.id, key: 'advisor', displayName: 'Advisor', controller: 'agent' },
    }),
    prisma.runParticipant.create({
      data: {
        runId: run.id,
        key: 'second-advisor',
        displayName: 'Second advisor',
        controller: 'agent',
      },
    }),
    prisma.runParticipant.create({
      data: { runId: run.id, key: 'target', displayName: 'Target', controller: 'human' },
    }),
  ]);
  return {
    organizationId: organization.id,
    runId: run.id,
    advisorId: advisor.id,
    secondAdvisorId: secondAdvisor.id,
    targetId: target.id,
    userId: user.id,
  };
}

function createPendingRecommendation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: { expiresAtVirtualTime: number },
) {
  return prisma.agentRecommendation.create({
    data: {
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      advisorParticipantId: fixture.advisorId,
      targetParticipantId: fixture.targetId,
      actionType: 'respond',
      parameters: {},
      rationale: '请采取处置动作。',
      evidenceRefs: [],
      confidence: 0.8,
      triggerEventTypes: ['signal.emitted'],
      triggerSequences: [1],
      observationHash: 'observation',
      baseRunVersion: 1,
      baseVirtualTime: 4,
      expiresAtVirtualTime: input.expiresAtVirtualTime,
    },
  });
}

function actor(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    id: fixture.userId,
    type: 'user' as const,
    organizationId: fixture.organizationId,
    displayName: 'operator@example.com',
  };
}

function packForFixture(fixture: Awaited<ReturnType<typeof createFixture>>): ScenarioPack<unknown> {
  return {
    participants: [
      {
        id: fixture.targetId,
        key: 'target',
      },
    ],
    agentPolicy: {
      advisors: [
        {
          advisorParticipantKey: 'advisor',
          triggerEventTypes: ['run.started'],
          recommendationPermissions: [
            { targetParticipantKey: 'target', actionType: 'respond' },
          ],
        },
      ],
    },
  } as unknown as ScenarioPack<unknown>;
}
