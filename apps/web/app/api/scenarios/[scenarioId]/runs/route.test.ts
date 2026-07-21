import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findOrganization: vi.fn(),
  createAndStart: vi.fn(),
  drainOutbox: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({ prisma: { organization: { findUnique: vi.fn() } } }));
vi.mock('@/lib/auth-session', () => ({
  getAuthSession: vi.fn(),
  getPrimaryOrganizationId: (session: { memberships: { organizationId: string }[] }) =>
    session.memberships[0]?.organizationId,
}));
vi.mock('@/lib/run-runtime', () => ({ runService: {} }));
vi.mock('@/lib/outbox-after-response', () => ({
  drainOutboxAfterResponse: mocks.drainOutbox,
}));

const { createPostHandler } = await import('./route');
const POST = createPostHandler({
  getSession: mocks.getSession,
  createAndStart: mocks.createAndStart,
  drainOutbox: mocks.drainOutbox,
});

const scenarioId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const userId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const participantId = '018f4c8b-9ae2-7a72-86bd-4f867befef04';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({
    userId,
    email: 'operator@example.com',
    isGuest: false,
    guestExpiresAt: undefined,
    memberships: [{ organizationId, role: 'member' }],
  });
  mocks.createAndStart.mockResolvedValue({
    run: { id: '018f4c8b-9ae2-7a72-86bd-4f867befef05', version: 1 },
    scenarioVersionId: '018f4c8b-9ae2-7a72-86bd-4f867befef06',
    scenarioVersion: 4,
  });
  mocks.drainOutbox.mockResolvedValue(undefined);
});

describe('Studio create run route', () => {
  it('鉴权后只转发受限 Studio DTO，并启动 Run', async () => {
    const response = await call(validPayload());
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(mocks.createAndStart).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        scenarioId,
        createdById: userId,
        idempotencyKey: 'studio-request-1',
        draft: validPayload(),
        actor: {
          id: userId,
          type: 'user',
          organizationId,
          displayName: 'operator@example.com',
        },
      }),
    );
    expect(mocks.drainOutbox).toHaveBeenCalledOnce();
    expect(body.scenarioVersion.version).toBe(4);
  });

  it('拒绝客户端附带的权限或 Pack 字段', async () => {
    const response = await call({ ...validPayload(), packKey: 'attacker-pack' });
    expect(response.status).toBe(400);
    expect(mocks.createAndStart).not.toHaveBeenCalled();
  });

  it('要求 Idempotency-Key', async () => {
    const response = await POST(
      new Request(`http://localhost/api/scenarios/${scenarioId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload()),
      }),
      { params: Promise.resolve({ scenarioId }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.createAndStart).not.toHaveBeenCalled();
  });

  it('未登录时拒绝创建 Run', async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await call(validPayload());
    expect(response.status).toBe(401);
    expect(mocks.createAndStart).not.toHaveBeenCalled();
  });

  it('为访客 Studio Run 写入时效', async () => {
    mocks.getSession.mockResolvedValue({
      userId,
      email: 'guest@readinessos.local',
      isGuest: true,
      guestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      memberships: [{ organizationId, role: 'owner' }],
    });

    const response = await call(validPayload());

    expect(response.status).toBe(201);
    expect(mocks.createAndStart).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: expect.any(String),
      }),
    );
  });
});

function validPayload() {
  return {
    difficulty: 'intermediate' as const,
    seed: 42,
    selectedObjectiveKeys: ['availability'],
    participants: [{ id: participantId, enabled: true, controller: 'human' as const }],
  };
}

function call(body: unknown) {
  return POST(
    new Request(`http://localhost/api/scenarios/${scenarioId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'studio-request-1',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ scenarioId }) },
  );
}
