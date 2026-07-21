import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimDispatch: vi.fn(),
  recordDispatchObservation: vi.fn(),
  markDispatchWaiting: vi.fn(),
  createRecommendation: vi.fn(),
  requeueFromDispatch: vi.fn(),
  markDispatchCompleted: vi.fn(),
  markDispatchRetry: vi.fn(),
  markDispatchFailed: vi.fn(),
  buildObservation: vi.fn(),
  turn: vi.fn(),
  findRun: vi.fn(),
  queueAgentDispatch: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: { findFirst: mocks.findRun },
  },
}));
vi.mock('@/lib/env', () => ({ env: { EVE_RUNTIME_URL: 'http://eve.test' } }));
vi.mock('@/lib/agent-turn-runtime', () => ({
  getProductionAgentTurnService: () => ({
    buildObservation: mocks.buildObservation,
    turn: mocks.turn,
  }),
}));
vi.mock('@/lib/agent-dispatch-queue', () => ({
  queueAgentDispatch: mocks.queueAgentDispatch,
}));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {
    claimDispatch = mocks.claimDispatch;
    recordDispatchObservation = mocks.recordDispatchObservation;
    markDispatchWaiting = mocks.markDispatchWaiting;
    createRecommendation = mocks.createRecommendation;
    requeueFromDispatch = mocks.requeueFromDispatch;
    markDispatchCompleted = mocks.markDispatchCompleted;
    markDispatchRetry = mocks.markDispatchRetry;
    markDispatchFailed = mocks.markDispatchFailed;
  },
}));

const { executeAgentDispatch } = await import('./agent-dispatch-execution');

const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const advisorParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const dispatchId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';
const successorDispatchId = '018f4c8b-9ae2-7a72-86bd-4f867befef05';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimDispatch.mockResolvedValue(dispatchClaim());
  mocks.findRun.mockResolvedValue({ status: 'running' });
  mocks.recordDispatchObservation.mockResolvedValue(undefined);
  mocks.markDispatchWaiting.mockResolvedValue(undefined);
  mocks.markDispatchCompleted.mockResolvedValue(undefined);
  mocks.markDispatchRetry.mockResolvedValue({
    nextAttemptAt: new Date('2026-07-19T05:30:00.000Z'),
  });
  mocks.markDispatchFailed.mockResolvedValue(undefined);
  mocks.buildObservation.mockResolvedValue(observation());
  mocks.queueAgentDispatch.mockResolvedValue(undefined);
  mocks.requeueFromDispatch.mockResolvedValue({ dispatchId: undefined, merged: false });
});

describe('Agent Dispatch execution', () => {
  it('Eve 完成且返回合法建议时创建 Recommendation，不进入重试', async () => {
    const action = proposedAction();
    mocks.turn.mockResolvedValue({
      status: 'completed',
      proposedAction: action,
      observationHash: 'observation-hash',
      eveSessionId: 'eve-session',
      eveTraceIdentity: 'eve-trace',
      inputRequests: [],
    });
    mocks.createRecommendation.mockResolvedValue({ status: 'pending' });

    await execute();

    expect(mocks.recordDispatchObservation).toHaveBeenCalledWith({
      dispatchId,
      runId,
      observationHash: 'observation-hash',
    });
    expect(mocks.createRecommendation).toHaveBeenCalledWith({
      dispatchId,
      runId,
      organizationId,
      action,
      observationHash: 'observation-hash',
      eveSessionId: 'eve-session',
      eveTraceIdentity: 'eve-trace',
    });
    expect(mocks.markDispatchRetry).not.toHaveBeenCalled();
    expect(mocks.markDispatchFailed).not.toHaveBeenCalled();
    expect(mocks.queueAgentDispatch).not.toHaveBeenCalled();
  });

  it('Eve 调用失败时持久化退避并将原 Dispatch 重新投递', async () => {
    const retryAt = new Date('2026-07-19T05:30:00.000Z');
    mocks.turn.mockRejectedValue(new Error('DeepSeek upstream timed out.'));
    mocks.markDispatchRetry.mockResolvedValue({ nextAttemptAt: retryAt });

    await execute();

    expect(mocks.markDispatchRetry).toHaveBeenCalledWith({
      dispatchId,
      runId,
      error: expect.objectContaining({ message: 'DeepSeek upstream timed out.' }),
    });
    expect(mocks.queueAgentDispatch).toHaveBeenCalledWith({
      organizationId,
      runId,
      dispatchId,
      nextAttemptAt: retryAt,
    });
    expect(mocks.createRecommendation).not.toHaveBeenCalled();
  });

  it('Agent 预算耗尽时记录失败并退避重试，不能阻断后续分析', async () => {
    const error = Object.assign(new Error('The Agent budget for this Run is exhausted.'), {
      code: 'BUDGET_EXCEEDED',
    });
    const retryAt = new Date('2026-07-19T05:30:00.000Z');
    mocks.turn.mockRejectedValue(error);
    mocks.markDispatchRetry.mockResolvedValue({ nextAttemptAt: retryAt });

    await execute();

    expect(mocks.markDispatchRetry).toHaveBeenCalledWith({
      dispatchId,
      runId,
      error,
    });
    expect(mocks.queueAgentDispatch).toHaveBeenCalledWith({
      organizationId,
      runId,
      dispatchId,
      nextAttemptAt: retryAt,
    });
    expect(mocks.markDispatchFailed).not.toHaveBeenCalled();
  });

  it('模型返回时建议因事实版本失效，会基于当前版本重新派发', async () => {
    mocks.turn.mockResolvedValue({
      status: 'completed',
      proposedAction: proposedAction(),
      observationHash: 'observation-hash',
      inputRequests: [],
    });
    mocks.createRecommendation.mockResolvedValue({ status: 'superseded' });
    mocks.requeueFromDispatch.mockResolvedValue({
      dispatchId: successorDispatchId,
      merged: false,
    });

    await execute();

    expect(mocks.requeueFromDispatch).toHaveBeenCalledWith({
      dispatchId,
      runId,
      organizationId,
    });
    expect(mocks.queueAgentDispatch).toHaveBeenCalledWith({
      organizationId,
      runId,
      dispatchId: successorDispatchId,
    });
    expect(mocks.markDispatchRetry).not.toHaveBeenCalled();
    expect(mocks.markDispatchFailed).not.toHaveBeenCalled();
  });

  it('重复启动时由 claimDispatch 拒绝，绝不重复调用 Eve', async () => {
    mocks.claimDispatch.mockResolvedValue(undefined);

    await execute();

    expect(mocks.turn).not.toHaveBeenCalled();
    expect(mocks.markDispatchRetry).not.toHaveBeenCalled();
  });

  it('当前没有满足 Kernel 策略的授权动作时跳过分析，不调用 Eve 或创建问题', async () => {
    mocks.buildObservation.mockResolvedValue({
      ...observation(),
      availableActions: [],
    });

    await execute();

    expect(mocks.turn).not.toHaveBeenCalled();
    expect(mocks.markDispatchCompleted).toHaveBeenCalledWith({
      dispatchId,
      runId,
      type: 'agent.analysis_skipped',
      data: {
        reason: 'No authorized action currently satisfies Kernel policy.',
      },
    });
    expect(mocks.markDispatchWaiting).not.toHaveBeenCalled();
    expect(mocks.createRecommendation).not.toHaveBeenCalled();
  });
});

async function execute() {
  await executeAgentDispatch({ dispatchId, runId, organizationId });
}

function dispatchClaim() {
  return {
    id: dispatchId,
    runId,
    organizationId,
    advisorParticipantId,
    requestKind: 'automatic' as const,
    triggerEventTypes: ['run.started'],
    triggerSequences: [1],
    baseRunVersion: 1,
    observationHash: undefined,
    attempts: 1,
    answeredQuestion: undefined,
  };
}

function proposedAction() {
  return {
    advisorParticipantId,
    targetParticipantId: advisorParticipantId,
    actionType: 'publish_status',
    parameters: { message: '支付异常正在处置。' },
    rationale: '先对外同步事故状态，降低支持渠道重复咨询。',
    evidenceRefs: ['event:1'],
    confidence: 0.88,
  };
}

function observation() {
  return {
    availableActions: [
      {
        targetParticipantId: advisorParticipantId,
        type: 'publish_status',
        label: 'Publish status',
        parameterSchema: {},
      },
    ],
  };
}
