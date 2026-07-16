import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import {
  assertGuestFeature,
  assertRunIsActiveForSession,
  getAgentRunBudget,
  hashPrivacySafeKey,
  requireAgentRunBudget,
} from './release-policy';

const guestSession = {
  userId: 'guest-user',
  email: 'guest@readinessos.local',
  isGuest: true,
  guestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  memberships: [],
};

describe('release policy', () => {
  it('将来源标识转换为不可逆限流键', () => {
    const key = hashPrivacySafeKey('203.0.113.9');

    expect(key).not.toContain('203.0.113.9');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(hashPrivacySafeKey('203.0.113.9'));
  });

  it('限制访客使用高风险功能', () => {
    expect(() => assertGuestFeature(guestSession, 'branch')).toThrow(ApplicationError);
    expect(() => assertGuestFeature({ ...guestSession, isGuest: false }, 'branch')).not.toThrow();
  });

  it('拒绝继续推进已到期的访客 Run', () => {
    expect(() =>
      assertRunIsActiveForSession(guestSession, {
        expiresAt: new Date(Date.now() - 60_000),
      }),
    ).toThrow('expired');
    expect(() =>
      assertRunIsActiveForSession(
        { ...guestSession, isGuest: false },
        { expiresAt: new Date(Date.now() - 60_000) },
      ),
    ).not.toThrow();
  });

  it('从不可变账本计算预算并拒绝已耗尽的 Run', async () => {
    const client = {
      usageLedger: {
        groupBy: async () => [
          { category: 'agent_turns', _sum: { quantity: 20 } },
          { category: 'agent_input_tokens', _sum: { quantity: 40_000 } },
        ],
      },
    } as unknown as PrismaClient;

    await expect(getAgentRunBudget(client, 'run-1')).resolves.toMatchObject({
      remainingTurns: 0,
      remainingTokens: 0,
    });
    await expect(requireAgentRunBudget(client, 'run-1')).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
  });
});
