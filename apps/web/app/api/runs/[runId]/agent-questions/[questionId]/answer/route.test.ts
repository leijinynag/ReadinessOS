import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  answerQuestion: vi.fn(),
  queueDispatch: vi.fn(),
  drainOutbox: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: {
      findUnique: mocks.findRun,
      findUniqueOrThrow: mocks.findRun,
    },
  },
}));
vi.mock('@/lib/run-api', () => ({ requireRunSession: mocks.requireSession }));
vi.mock('@/lib/agent-outbox', () => ({ queueAgentDispatch: mocks.queueDispatch }));
vi.mock('@/lib/outbox-after-response', () => ({
  drainOutboxAfterResponse: mocks.drainOutbox,
}));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {
    answerQuestion = mocks.answerQuestion;
  },
}));

const { POST } = await import('./route');

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const questionId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';
const dispatchId = '018f4c8b-9ae2-7a72-86bd-4f867befef05';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId, version: 7, expiresAt: null });
  mocks.requireSession.mockResolvedValue({
    userId,
    email: 'operator@example.com',
    isGuest: false,
  });
  mocks.answerQuestion.mockResolvedValue({ dispatchId });
  mocks.queueDispatch.mockResolvedValue(undefined);
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Agent question answer route', () => {
  it('持久化 IC 的事实补充后重新投递原 Dispatch', async () => {
    const response = await call({ optionId: 'freeze-retries', text: '监控确认重试流量持续上升。' });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"7"');
    expect(mocks.answerQuestion).toHaveBeenCalledWith({
      runId,
      organizationId,
      questionId,
      actorId: userId,
      optionId: 'freeze-retries',
      text: '监控确认重试流量持续上升。',
    });
    expect(mocks.queueDispatch).toHaveBeenCalledWith({ organizationId, runId, dispatchId });
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('事实版本冲突时不写入回答也不重新投递', async () => {
    const response = await call({ optionId: 'freeze-retries' }, { version: 6 });

    expect(response.status).toBe(409);
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(mocks.queueDispatch).not.toHaveBeenCalled();
  });

  it('拒绝访客回答 Agent 问题', async () => {
    mocks.requireSession.mockResolvedValue({
      userId,
      email: 'guest@example.com',
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await call({ optionId: 'freeze-retries' });

    expect(response.status).toBe(403);
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });
});

function call(body: unknown, input: { version?: number } = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/agent-questions/${questionId}/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${input.version ?? 7}"`,
        'Idempotency-Key': 'agent-question-answer-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId, questionId }) },
  );
}
