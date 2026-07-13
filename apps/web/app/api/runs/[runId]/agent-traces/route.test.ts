import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/run-api', () => ({ requireRunSession: vi.fn() }));
vi.mock('@/lib/api-response', () => ({ apiError: (error: unknown) => error }));

const { decodeCursor, encodeCursor } = await import('./route');

const firstId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';

describe('agent trace cursor', () => {
  it('以 recordedAt 和 id 编码稳定的 Run 级 cursor', () => {
    const cursor = encodeCursor({
      version: 1,
      recordedAt: '2026-07-13T00:00:00.000Z',
      id: firstId,
    });

    expect(cursor).not.toContain('2026-07-13');
    expect(decodeCursor(cursor)).toEqual({
      version: 1,
      recordedAt: '2026-07-13T00:00:00.000Z',
      id: firstId,
    });
  });

  it('拒绝畸形 cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow('cursor is invalid');
  });
});
