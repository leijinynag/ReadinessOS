import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  getPack: vi.fn(),
  execute: vi.fn(),
  getRun: vi.fn(),
  drainOutbox: vi.fn(),
  decide: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: { simulationRun: { findUnique: mocks.findRun } },
}));
vi.mock('@/lib/run-api', () => ({
  requireRunSession: mocks.requireSession,
  userActor: () => ({
    id: userId,
    type: 'user',
    organizationId,
    displayName: 'operator@example.com',
  }),
}));
vi.mock('@/lib/run-runtime', () => ({
  runService: {
    getRunScenarioPack: mocks.getPack,
    execute: mocks.execute,
    getRun: mocks.getRun,
  },
}));
vi.mock('@/lib/outbox-after-response', () => ({
  drainOutboxAfterResponse: mocks.drainOutbox,
}));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {
    decide = mocks.decide;
  },
}));

const { POST } = await import('./route');

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const recommendationId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';
const runtimeTargetParticipantId = '018f4c8b-9ae2-7a72-86bd-4f867befef05';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId, version: 7, expiresAt: null });
  mocks.requireSession.mockResolvedValue({
    userId,
    email: 'operator@example.com',
    isGuest: false,
  });
  mocks.getPack.mockResolvedValue({ agentPolicy: { advisors: [] } });
  mocks.getRun.mockResolvedValue({ version: 8 });
  mocks.execute.mockResolvedValue({
    result: {
      status: 'accepted',
      state: { run: { latestSequence: 12 } },
    },
  });
  mocks.drainOutbox.mockResolvedValue(undefined);
  mocks.decide.mockResolvedValue({ executionSequence: undefined });
});

describe('Agent recommendation decision route', () => {
  it('拒绝建议只记录 IC 裁决，不创建 Kernel 命令', async () => {
    const response = await call({ decision: 'reject', rationale: '先确认 provider 状态。' });

    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendationId,
        decision: 'reject',
        rationale: '先确认 provider 状态。',
      }),
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('采纳建议时只能通过当前 Human actor 调用 Kernel submit-action', async () => {
    mocks.decide.mockImplementation(async (input) => {
      const execution = await input.executeAction({
        participantId: runtimeTargetParticipantId,
        actionType: 'disable-payment-writes',
        parameters: { reason: 'protect-ledger' },
        expectedRunVersion: 7,
      });
      return { executionSequence: execution.latestSequence };
    });

    const response = await call({ decision: 'adopt' });

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        runId,
        actor: {
          id: userId,
          type: 'user',
          organizationId,
          displayName: 'operator@example.com',
        },
        expectedRunVersion: 7,
        idempotencyKey: 'recommendation-decision-1',
        payload: {
          type: 'submit-action',
          participantId: runtimeTargetParticipantId,
          actionType: 'disable-payment-writes',
          parameters: { reason: 'protect-ledger' },
        },
      }),
    );
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('修改建议时将修改后的目标、动作和参数交给 Kernel 二次校验', async () => {
    mocks.decide.mockImplementation(async (input) => {
      const execution = await input.executeAction({
        participantId: runtimeTargetParticipantId,
        actionType: 'freeze-payment-retries',
        parameters: { durationMinutes: 3 },
        expectedRunVersion: 7,
      });
      return { executionSequence: execution.latestSequence };
    });

    const response = await call({
      decision: 'modify',
      rationale: '先降低重试压力。',
      modifiedAction: {
        targetParticipantId: '018f4c8b-9ae2-7a72-86bd-4f867befef06',
        actionType: 'freeze-payment-retries',
        parameters: { durationMinutes: 3 },
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'submit-action',
          actionType: 'freeze-payment-retries',
          parameters: { durationMinutes: 3 },
        }),
      }),
    );
  });

  it('页面版本已过期时不读取 Pack、不裁决也不提交 Kernel 命令', async () => {
    const response = await call({ decision: 'adopt' }, { version: 6 });

    expect(response.status).toBe(409);
    expect(mocks.getPack).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function call(body: unknown, input: { version?: number } = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/recommendations/${recommendationId}/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${input.version ?? 7}"`,
        'Idempotency-Key': 'recommendation-decision-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId, recommendationId }) },
  );
}
