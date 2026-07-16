import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  createBranchRun: vi.fn(),
  drainOutbox: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: { simulationRun: { findUnique: mocks.findRun } },
}));
vi.mock('@/lib/run-api', () => ({ requireRunSession: mocks.requireSession }));
vi.mock('@/lib/run-runtime', () => ({
  runService: { createBranchRun: mocks.createBranchRun },
  drainRuntimeOutbox: mocks.drainOutbox,
}));
vi.mock('@/lib/api-response', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-response')>('@/lib/api-response');
  return { ...actual, apiError: (error: unknown) => Response.json({ error }, { status: 400 }) };
});

const { POST } = await import('./route');
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const branchId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId, expiresAt: null });
  mocks.requireSession.mockResolvedValue({
    userId,
    email: 'operator@example.com',
    isGuest: false,
    guestExpiresAt: undefined,
  });
  mocks.createBranchRun.mockResolvedValue({ id: branchId, version: 0 });
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Branch route', () => {
  it('用 ETag 和幂等键创建指定 sequence 的 Run 分支', async () => {
    const response = await POST(
      new Request(`http://localhost/api/runs/${runId}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"4"',
          'Idempotency-Key': 'branch-request-1',
        },
        body: JSON.stringify({ sequence: 7, name: '替代处置方案' }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"0"');
    expect(mocks.createBranchRun).toHaveBeenCalledWith({
      parentRunId: runId,
      organizationId,
      createdById: userId,
      idempotencyKey: 'branch-request-1',
      expectedParentRunVersion: 4,
      branchFromSequence: 7,
      name: '替代处置方案',
    });
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('拒绝没有成员权限的分支请求', async () => {
    mocks.requireSession.mockRejectedValue(new ApplicationError('FORBIDDEN', 'denied'));
    const response = await POST(
      new Request(`http://localhost/api/runs/${runId}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"4"',
          'Idempotency-Key': 'branch-request-2',
        },
        body: JSON.stringify({ sequence: 7, name: '替代处置方案' }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.createBranchRun).not.toHaveBeenCalled();
  });

  it('拒绝访客创建 Run 分支', async () => {
    mocks.requireSession.mockResolvedValue({
      userId,
      email: 'guest@readinessos.local',
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(
      new Request(`http://localhost/api/runs/${runId}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"4"',
          'Idempotency-Key': 'branch-guest-request',
        },
        body: JSON.stringify({ sequence: 7, name: '不应创建' }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.createBranchRun).not.toHaveBeenCalled();
  });
});
