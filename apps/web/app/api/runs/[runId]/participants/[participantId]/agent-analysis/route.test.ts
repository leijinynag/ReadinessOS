import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findAdvisor: vi.fn(),
  requireSession: vi.fn(),
  getPack: vi.fn(),
  enqueueDispatch: vi.fn(),
  queueDispatch: vi.fn(),
  drainOutbox: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: {
      findUnique: mocks.findRun,
      findUniqueOrThrow: mocks.findRun,
    },
    runParticipant: { findFirst: mocks.findAdvisor },
  },
}));
vi.mock('@/lib/run-api', () => ({ requireRunSession: mocks.requireSession }));
vi.mock('@/lib/run-runtime', () => ({
  runService: { getRunScenarioPack: mocks.getPack },
}));
vi.mock('@/lib/outbox-after-response', () => ({
  drainOutboxAfterResponse: mocks.drainOutbox,
}));
vi.mock('@/lib/agent-outbox', () => ({ queueAgentDispatch: mocks.queueDispatch }));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {
    enqueueDispatch = mocks.enqueueDispatch;
  },
}));

const { POST } = await import('./route');

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const participantId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const dispatchId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({
    organizationId,
    status: 'running',
    version: 7,
    expiresAt: null,
  });
  mocks.requireSession.mockResolvedValue({
    userId: '018f4c8b-9ae2-7a72-86bd-4f867befef05',
    email: 'operator@example.com',
    isGuest: false,
  });
  mocks.findAdvisor.mockResolvedValue({ id: participantId, key: 'on-call-engineer' });
  mocks.getPack.mockResolvedValue(packWithAdvisor('on-call-engineer'));
  mocks.enqueueDispatch.mockResolvedValue({ dispatchId, merged: false });
  mocks.queueDispatch.mockResolvedValue(undefined);
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Agent analysis request route', () => {
  it('仅为当前场景 policy 中的顾问持久化并投递重新分析', async () => {
    const response = await call({ requestKind: 'reanalyze' });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"7"');
    expect(mocks.enqueueDispatch).toHaveBeenCalledWith({
      runId,
      organizationId,
      advisorParticipantId: participantId,
      requestKind: 'reanalyze',
      triggerEventTypes: ['ic.reanalyze_requested'],
      triggerSequences: [],
      force: true,
    });
    expect(mocks.queueDispatch).toHaveBeenCalledWith({ organizationId, runId, dispatchId });
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('拒绝不属于当前 Scenario Pack agentPolicy 的 Agent 参与方', async () => {
    mocks.getPack.mockResolvedValue(packWithAdvisor('customer-support-lead'));

    const response = await call({ requestKind: 'compare' });

    expect(response.status).toBe(400);
    expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
    expect(mocks.queueDispatch).not.toHaveBeenCalled();
  });

  it('在事实版本已变化时拒绝请求，不创建 Dispatch', async () => {
    const response = await call({ requestKind: 'reanalyze' }, { version: 6 });

    expect(response.status).toBe(409);
    expect(mocks.findAdvisor).not.toHaveBeenCalled();
    expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
  });

  it('拒绝访客请求 Agent 分析', async () => {
    mocks.requireSession.mockResolvedValue({
      userId: '018f4c8b-9ae2-7a72-86bd-4f867befef05',
      email: 'guest@example.com',
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await call({ requestKind: 'reanalyze' });

    expect(response.status).toBe(403);
    expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
  });

  it('只允许 running Run 请求分析', async () => {
    mocks.findRun.mockResolvedValue({
      organizationId,
      status: 'paused',
      version: 7,
      expiresAt: null,
    });

    const response = await call({ requestKind: 'reanalyze' });

    expect(response.status).toBe(400);
    expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
  });
});

function call(body: unknown, input: { version?: number } = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/participants/${participantId}/agent-analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${input.version ?? 7}"`,
        'Idempotency-Key': 'agent-analysis-request-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId, participantId }) },
  );
}

function packWithAdvisor(advisorParticipantKey: string) {
  return {
    agentPolicy: {
      advisors: [{ advisorParticipantKey, triggerEventTypes: [], recommendationPermissions: [] }],
    },
  };
}
