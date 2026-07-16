import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  turn: vi.fn(),
}));
vi.mock('@readinessos/database', () => ({
  prisma: { simulationRun: { findUnique: mocks.findRun } },
}));
vi.mock('@/lib/run-api', () => ({ requireRunSession: mocks.requireSession }));
vi.mock('@/lib/agent-turn-runtime', () => ({ getProductionAgentTurnService: vi.fn() }));

const { createPostHandler } = await import('./route');
const POST = createPostHandler(() => ({ turn: mocks.turn }));
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const participantId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId, status: 'running', expiresAt: null });
  mocks.requireSession.mockResolvedValue({
    isGuest: false,
    guestExpiresAt: undefined,
  });
  mocks.turn.mockResolvedValue({
    handle: {
      runParticipantId: participantId,
      agentKey: 'director',
      sessionId: 'session-1',
      continuationToken: 'server-secret',
      streamIndex: 1,
    },
    status: 'completed',
    proposedAction: {
      participantId,
      actionType: 'publish_status',
      parameters: {},
      rationale: 'update',
      evidenceRefs: [],
      confidence: 1,
      clientRequestId: 'proposal-1',
    },
    inputRequests: [],
  });
});

describe('participant agent turn route', () => {
  it('鉴权后执行 observe，并只返回安全 turn DTO', async () => {
    const response = await call({ type: 'observe' });
    const body = await response.json();

    expect(mocks.requireSession).toHaveBeenCalledWith(organizationId, 'member');
    expect(mocks.turn).toHaveBeenCalledWith({
      runId,
      participantId,
      organizationId,
      input: { type: 'observe' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.agentTurn.continuationToken).toBeUndefined();
    expect(body.agentTurn.proposedAction.actionType).toBe('publish_status');
  });

  it('转发经过校验的 HITL input response', async () => {
    const input = {
      type: 'input-response',
      response: { requestId: 'approval', optionId: 'approve' },
    };
    await call(input);
    expect(mocks.turn).toHaveBeenCalledWith(expect.objectContaining({ input }));
  });

  it('拒绝客户端注入 observation 或 agentKey', async () => {
    const response = await call({ type: 'observe', agentKey: 'attacker', observation: {} });
    expect(response.status).toBe(400);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it.each([
    ['UNAUTHENTICATED', 401],
    ['FORBIDDEN', 403],
  ] as const)('鉴权错误 %s 返回对应状态且不调用 turn', async (code, status) => {
    mocks.requireSession.mockRejectedValue(new ApplicationError(code, 'denied'));
    const response = await call({ type: 'observe' });
    expect(response.status).toBe(status);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('拒绝缺少 optionId 和 text 的 input response', async () => {
    const response = await call({
      type: 'input-response',
      response: { requestId: 'approval' },
    });
    expect(response.status).toBe(400);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it.each(['paused', 'completed'] as const)('%s Run 拒绝 Agent turn', async (status) => {
    mocks.findRun.mockResolvedValue({ organizationId, status });
    const response = await call({ type: 'observe' });
    expect(response.status).toBe(400);
    expect(mocks.requireSession).toHaveBeenCalledWith(organizationId, 'member');
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('Run 不存在时不鉴权也不调用 Eve service', async () => {
    mocks.findRun.mockResolvedValue(null);
    const response = await call({ type: 'observe' });
    expect(response.status).toBe(404);
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('拒绝访客触发 Agent turn', async () => {
    mocks.requireSession.mockResolvedValue({
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await call({ type: 'observe' });

    expect(response.status).toBe(403);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('拒绝已过期的访客 Run', async () => {
    mocks.findRun.mockResolvedValue({
      organizationId,
      status: 'running',
      expiresAt: new Date(Date.now() - 60_000),
    });
    mocks.requireSession.mockResolvedValue({
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await call({ type: 'observe' });

    expect(response.status).toBe(400);
    expect(mocks.turn).not.toHaveBeenCalled();
  });
});

function call(body: unknown) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/participants/${participantId}/agent-turn`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ runId, participantId }) },
  );
}
