import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  requireSession: vi.fn(),
  getPack: vi.fn(),
  execute: vi.fn(),
  drainOutbox: vi.fn(),
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
  },
  drainRuntimeOutbox: mocks.drainOutbox,
}));
const { POST } = await import('./route');
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId });
  mocks.requireSession.mockResolvedValue({ userId, email: 'operator@example.com' });
  mocks.getPack.mockResolvedValue({ injects: [{ key: 'payment-service-outage' }] });
  mocks.execute.mockResolvedValue({
    result: { state: { run: { version: 8 } } },
  });
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Director inject route', () => {
  it('只转发当前 Pack 已声明的 inject，并使用并发控制与幂等键', async () => {
    const response = await call({ injectKey: 'payment-service-outage' });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"8"');
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        runId,
        expectedRunVersion: 7,
        idempotencyKey: 'inject-request-1',
        payload: { type: 'trigger-inject', injectKey: 'payment-service-outage' },
      }),
    );
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
  });

  it('拒绝不属于当前场景包的 inject', async () => {
    const response = await call({ injectKey: 'unsafe-inject' });
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('拒绝没有成员权限的请求', async () => {
    mocks.requireSession.mockRejectedValue(new ApplicationError('FORBIDDEN', 'denied'));
    const response = await call({ injectKey: 'payment-service-outage' });
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function call(body: unknown) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"7"',
        'Idempotency-Key': 'inject-request-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}
