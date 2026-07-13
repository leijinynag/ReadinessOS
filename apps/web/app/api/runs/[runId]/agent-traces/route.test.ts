import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findTraces: vi.fn(),
  requireSession: vi.fn(),
}));
vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: { findUnique: mocks.findRun },
    agentTrace: { findMany: mocks.findTraces },
  },
}));
vi.mock('@/lib/run-api', () => ({ requireRunSession: mocks.requireSession }));
vi.mock('@/lib/api-response', () => ({
  apiError: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    ),
}));

const { GET, decodeCursor, encodeCursor } = await import('./route');
const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef00';
const firstId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const secondId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';
const thirdId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const recordedAt = new Date('2026-07-13T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef09' });
});

describe('agent trace cursor', () => {
  it('真实 GET 使用 Run 级 keyset，跨 session 重复 streamIndex 无漏无重', async () => {
    mocks.findTraces
      .mockResolvedValueOnce([trace(firstId, 'session-a', 1), trace(secondId, null, 1)])
      .mockResolvedValueOnce([trace(thirdId, 'session-b', 1)]);

    const firstResponse = await GET(
      new Request(`http://localhost/api/runs/${runId}/agent-traces?take=2`),
      {
        params: Promise.resolve({ runId }),
      },
    );
    const firstPage = await firstResponse.json();
    const secondResponse = await GET(
      new Request(
        `http://localhost/api/runs/${runId}/agent-traces?take=2&after=${firstPage.nextTraceCursor}`,
      ),
      { params: Promise.resolve({ runId }) },
    );
    const secondPage = await secondResponse.json();

    expect([...firstPage.agentTraces, ...secondPage.agentTraces].map((row) => row.id)).toEqual([
      firstId,
      secondId,
      thirdId,
    ]);
    expect(mocks.findTraces).toHaveBeenNthCalledWith(2, {
      where: {
        runId,
        OR: [{ recordedAt: { gt: recordedAt } }, { recordedAt, id: { gt: secondId } }],
      },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      take: 2,
      select: expect.any(Object),
    });
    expect(mocks.requireSession).toHaveBeenCalledTimes(2);
  });

  it('以 recordedAt 和 id 编码稳定 cursor', () => {
    const cursor = encodeCursor({ version: 1, recordedAt: recordedAt.toISOString(), id: firstId });
    expect(decodeCursor(cursor)).toEqual({
      version: 1,
      recordedAt: recordedAt.toISOString(),
      id: firstId,
    });
  });

  it('GET 拒绝畸形 cursor', async () => {
    const response = await GET(
      new Request(`http://localhost/api/runs/${runId}/agent-traces?after=not-a-cursor`),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.findTraces).not.toHaveBeenCalled();
  });
});

function trace(id: string, sessionId: string | null, streamIndex: number) {
  return {
    id,
    runParticipantId: null,
    sessionId,
    streamIndex,
    eventType: 'test',
    recordedAt,
  };
}
