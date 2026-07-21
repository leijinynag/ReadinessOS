import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  supersedeStaleRecommendations: vi.fn(),
  expireDueRecommendations: vi.fn(),
  enqueueDispatch: vi.fn(),
  getRunScenarioPack: vi.fn(),
  findParticipant: vi.fn(),
  findRun: vi.fn(),
  persistDispatch: vi.fn(),
}));

vi.mock('workflow/api', () => ({ start: mocks.start }));
vi.mock('@/lib/run-runtime', () => ({
  runService: { getRunScenarioPack: mocks.getRunScenarioPack },
}));
vi.mock('@/workflows/agent-dispatch', () => ({
  agentDispatchWorkflow: 'agent-dispatch-workflow',
}));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {
    supersedeStaleRecommendations = mocks.supersedeStaleRecommendations;
    expireDueRecommendations = mocks.expireDueRecommendations;
    enqueueDispatch = mocks.enqueueDispatch;
  },
}));
vi.mock('@/lib/agent-dispatch-queue', () => ({
  queueAgentDispatch: mocks.persistDispatch,
}));
vi.mock('@readinessos/database', () => ({
  prisma: {
    outboxMessage: { create: vi.fn(), createMany: vi.fn() },
    runParticipant: { findFirst: mocks.findParticipant },
    simulationRun: { findFirst: mocks.findRun },
  },
}));

const {
  createAgentRecommendationOutboxHandlers,
  matchesAgentAdvisorPolicyEvent,
} = await import('./agent-outbox');

const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const dispatchId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({ runId: 'workflow-run-id' });
  mocks.supersedeStaleRecommendations.mockResolvedValue([]);
  mocks.expireDueRecommendations.mockResolvedValue([]);
  mocks.enqueueDispatch.mockResolvedValue({ dispatchId, merged: false });
  mocks.persistDispatch.mockResolvedValue(undefined);
  mocks.getRunScenarioPack.mockResolvedValue({ agentPolicy: { advisors: [] } });
  mocks.findParticipant.mockResolvedValue({ id: dispatchId });
  mocks.findRun.mockResolvedValue({ status: 'running' });
});

describe('Agent recommendation Outbox', () => {
  it('agent.dispatch 只启动 Durable Workflow，不在 Outbox 生命周期内等待模型', async () => {
    const handler = createAgentRecommendationOutboxHandlers()['agent.dispatch'];
    if (!handler) throw new Error('Agent dispatch Outbox handler is not configured.');

    await handler.handle({
      id: '018f4c8b-9ae2-7a72-86bd-4f867befef06',
      organizationId,
      runId,
      topic: 'agent.dispatch',
      payload: { dispatchId },
    } as never);

    expect(mocks.start).toHaveBeenCalledWith('agent-dispatch-workflow', [
      { dispatchId, runId, organizationId },
    ]);
  });

  it('没有 Run 上下文时不启动 Workflow', async () => {
    const handler = createAgentRecommendationOutboxHandlers()['agent.dispatch'];
    if (!handler) throw new Error('Agent dispatch Outbox handler is not configured.');

    await handler.handle({
      id: '018f4c8b-9ae2-7a72-86bd-4f867befef07',
      organizationId,
      runId: undefined,
      topic: 'agent.dispatch',
      payload: { dispatchId },
    } as never);

    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('领域事件到达时先主动淘汰旧建议，再仅为匹配 payload 的顾问创建调度', async () => {
    mocks.getRunScenarioPack.mockResolvedValue({
      agentPolicy: {
        advisors: [
          {
            advisorParticipantKey: 'payment-provider',
            triggerEventTypes: ['signal.emitted', 'inject.triggered'],
            triggerInjectKeys: ['provider-status-update'],
            triggerSignalKeys: ['provider-contacted', 'provider-recovery-update'],
            recommendationPermissions: [],
          },
        ],
      },
    });
    const handler = createAgentRecommendationOutboxHandlers()['run.event'];
    if (!handler) throw new Error('Run event handler is not configured.');

    await handler.handle({
      id: '018f4c8b-9ae2-7a72-86bd-4f867befef08',
      organizationId,
      runId,
      topic: 'run.event',
      payload: {
        cursor: 3,
        event: {
          runId,
          sequence: 3,
          type: 'inject.triggered',
          payload: { injectKey: 'payment-service-outage' },
        },
      },
    } as never);

    expect(mocks.supersedeStaleRecommendations).toHaveBeenCalledWith(runId, organizationId);
    expect(
      (await import('@readinessos/database')).prisma.outboxMessage.createMany,
    ).not.toHaveBeenCalled();
  });

  it('准确匹配 Provider 的 signal 和 Inject 触发条件', () => {
    const policy = {
      advisorParticipantKey: 'payment-provider',
      triggerEventTypes: ['signal.emitted', 'inject.triggered'],
      triggerInjectKeys: ['provider-status-update'],
      triggerSignalKeys: ['provider-contacted', 'provider-recovery-update'],
      recommendationPermissions: [],
    };

    expect(
      matchesAgentAdvisorPolicyEvent(policy, {
        type: 'signal.emitted',
        payload: { signalKey: 'provider-contacted' },
      }),
    ).toBe(true);
    expect(
      matchesAgentAdvisorPolicyEvent(policy, {
        type: 'inject.triggered',
        payload: { injectKey: 'provider-status-update' },
      }),
    ).toBe(true);
    expect(
      matchesAgentAdvisorPolicyEvent(policy, {
        type: 'signal.emitted',
        payload: { signalKey: 'payment-service-outage' },
      }),
    ).toBe(false);
    expect(
      matchesAgentAdvisorPolicyEvent(policy, {
        type: 'inject.triggered',
        payload: { injectKey: 'payment-service-outage' },
      }),
    ).toBe(false);
  });
});
