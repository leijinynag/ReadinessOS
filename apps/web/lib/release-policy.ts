import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import type { AuthSession } from '@readinessos/application';
import { env } from './env';

type LedgerCategory =
  | 'agent_turns'
  | 'agent_input_tokens'
  | 'agent_output_tokens'
  | 'agent_cache_read_tokens'
  | 'agent_cache_write_tokens'
  | 'agent_tool_steps'
  | 'agent_subagent_steps'
  | 'agent_cost_micro_usd';

const ledgerCategories: readonly LedgerCategory[] = [
  'agent_turns',
  'agent_input_tokens',
  'agent_output_tokens',
  'agent_cache_read_tokens',
  'agent_cache_write_tokens',
  'agent_tool_steps',
  'agent_subagent_steps',
  'agent_cost_micro_usd',
];

export type AgentRunBudget = {
  remainingTurns: number;
  remainingTokens: number;
  remainingToolSteps: number;
  remainingSubagentSteps: number;
  remainingCostMicroUsd: number;
};

/**
 * 预算读数始终来自不可变 UsageLedger，而不是浏览器或 Eve Session 的临时状态。
 * 这使进程重启、请求重放以及多实例部署时仍能共享同一条成本边界。
 */
export async function getAgentRunBudget(
  client: PrismaClient,
  runId: string,
): Promise<AgentRunBudget> {
  const totals = new Map<LedgerCategory, number>();
  const rows = await client.usageLedger.groupBy({
    by: ['category'],
    where: { runId, category: { in: [...ledgerCategories] } },
    _sum: { quantity: true },
  });
  for (const row of rows) {
    if (isLedgerCategory(row.category)) {
      totals.set(row.category, row._sum.quantity ?? 0);
    }
  }

  const usedTokens =
    value(totals, 'agent_input_tokens') +
    value(totals, 'agent_output_tokens') +
    value(totals, 'agent_cache_read_tokens') +
    value(totals, 'agent_cache_write_tokens');
  return {
    remainingTurns: remaining(env.AGENT_MAX_TURNS_PER_RUN, value(totals, 'agent_turns')),
    remainingTokens: remaining(env.AGENT_MAX_TOKENS_PER_RUN, usedTokens),
    remainingToolSteps: remaining(
      env.AGENT_MAX_TOOL_STEPS_PER_RUN,
      value(totals, 'agent_tool_steps'),
    ),
    remainingSubagentSteps: remaining(
      env.AGENT_MAX_SUBAGENT_STEPS_PER_RUN,
      value(totals, 'agent_subagent_steps'),
    ),
    remainingCostMicroUsd: remaining(
      env.AGENT_MAX_COST_MICRO_USD_PER_RUN,
      value(totals, 'agent_cost_micro_usd'),
    ),
  };
}

export async function requireAgentRunBudget(
  client: PrismaClient,
  runId: string,
): Promise<AgentRunBudget> {
  const budget = await getAgentRunBudget(client, runId);
  if (
    budget.remainingTurns <= 0 ||
    budget.remainingTokens <= 0 ||
    budget.remainingToolSteps <= 0 ||
    budget.remainingCostMicroUsd <= 0
  ) {
    throw new ApplicationError('BUDGET_EXCEEDED', 'The Agent budget for this Run is exhausted.', {
      ...budget,
    });
  }
  return budget;
}

export function guestRunExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + env.GUEST_DEMO_RUN_MINUTES * 60_000);
}

export function assertGuestFeature(
  session: AuthSession,
  feature: 'branch' | 'director-inject' | 'agent-turn',
): void {
  if (!session.isGuest) return;
  throw new ApplicationError(
    'FORBIDDEN',
    `Guest demo access does not allow ${feature.replaceAll('-', ' ')}.`,
  );
}

export function assertRunIsActiveForSession(
  session: AuthSession,
  run: { expiresAt: Date | null },
): void {
  if (!session.isGuest || !run.expiresAt || run.expiresAt > new Date()) return;
  throw new ApplicationError('BUDGET_EXCEEDED', 'This guest demo Run has expired.');
}

/**
 * IP 和浏览器标识从不直接落库。HMAC 既用于限流 key，也避免跨环境对来源做可逆关联。
 */
export function hashPrivacySafeKey(value: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(value).digest('hex');
}

function value(totals: ReadonlyMap<LedgerCategory, number>, category: LedgerCategory): number {
  return totals.get(category) ?? 0;
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

function isLedgerCategory(value: string): value is LedgerCategory {
  return ledgerCategories.includes(value as LedgerCategory);
}
