import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  resolveApproval: vi.fn(),
  drainOutbox: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: { simulationRun: { findUnique: mocks.findRun } },
}));
vi.mock('@/lib/run-api', () => ({
  requireRunSession: mocks.requireSession,
  userActor: () => ({ id: userId, type: 'user', organizationId, displayName: 'operator@example.com' }),
}));
vi.mock('@/lib/run-runtime', () => ({
  runService: { resolveApproval: mocks.resolveApproval },
  drainRuntimeOutbox: mocks.drainOutbox,
}));

const { POST } = await import('./route');
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const approvalId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId });
  mocks.requireSession.mockResolvedValue({ userId, email: 'operator@example.com' });
  mocks.resolveApproval.mockResolvedValue({
    result: { state: { run: { version: 9 } } },
  });
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Approval resolution route', () => {
  it('批准动作时使用 ETag 和幂等键执行受治理命令', async () => {
    const response = await call({ decision: 'approved' });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"9"');
    expect(mocks.resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        runId,
        expectedRunVersion: 8,
        idempotencyKey: 'approval-request-1',
      }),
      approvalId,
      'approved',
    );
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('拒绝没有成员权限的审批', async () => {
    mocks.requireSession.mockRejectedValue(new ApplicationError('FORBIDDEN', 'denied'));
    const response = await call({ decision: 'denied' });
    expect(response.status).toBe(403);
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });
});

function call(body: unknown) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"8"',
        'Idempotency-Key': 'approval-request-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId, approvalId }) },
  );
}
