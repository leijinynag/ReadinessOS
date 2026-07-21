import { prisma } from '@readinessos/database';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';

const dispatchLockTimeoutMs = 5 * 60 * 1_000;
const recommendationService = new AgentRecommendationService(prisma);

/**
 * 自动时钟不能在 IC 正在阅读建议、补充关键事实，或首次 Agent 分析尚未完成时
 * 继续推进，否则 Recommendation 会因为无关的 clock.advanced 立即失去事实
 * 基线。deferred 不在这里阻塞，它必须随虚拟时间到期，才能触发新的分析。
 *
 * 已经发生过错误的 pending Dispatch 是退避重试，不应无限暂停 Kernel 的自动时钟；
 * 只有首次投递（lastError 为 null）才提供短暂的分析窗口。
 */
export async function hasAgentDecisionBlocker(input: {
  runId: string;
  organizationId: string;
}): Promise<boolean> {
  const blocker = await prisma.simulationRun.findFirst({
    where: { id: input.runId, organizationId: input.organizationId },
    select: {
      _count: {
        select: {
          agentRecommendations: { where: { status: 'pending' } },
          agentDispatches: {
            where: {
              OR: [
                { status: 'waiting_for_input' },
                {
                  status: { in: ['pending', 'running'] },
                  lastError: null,
                },
              ],
            },
          },
        },
      },
    },
  });
  if (!blocker) return false;
  return (
    blocker._count.agentRecommendations > 0 ||
    blocker._count.agentDispatches > 0
  );
}

/**
 * Dispatch 重试和基于新事实的重新分析都回到同一条 Outbox 通道，确保任意宿主
 * 都能继续投递，而不是依赖发起 HTTP 请求的进程仍然存活。
 */
export async function queueAgentDispatch(input: {
  organizationId: string;
  runId: string;
  dispatchId: string;
  nextAttemptAt?: Date;
}): Promise<void> {
  await prisma.outboxMessage.create({
    data: {
      organizationId: input.organizationId,
      runId: input.runId,
      topic: 'agent.dispatch',
      payload: { dispatchId: input.dispatchId },
      ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
    },
  });
}

/**
 * 对账只恢复失去宿主的锁，并重新持久化一条 Outbox 消息。它不在 Cron 进程中
 * 直接执行 Eve，因此仍然复用 Dispatch 的 claim、退避和每角色串行边界。
 */
export async function recoverStaleAgentDispatches(input: {
  now?: Date;
  lockTimeoutMs?: number;
  take?: number;
  organizationId?: string;
  runId?: string;
} = {}): Promise<number> {
  const now = input.now ?? new Date();
  const lockTimeoutMs = input.lockTimeoutMs ?? dispatchLockTimeoutMs;
  const lockedBefore = new Date(now.getTime() - lockTimeoutMs);
  const recovered = await recommendationService.recoverStaleDispatches({
    lockedBefore,
    now,
    ...(input.take === undefined ? {} : { take: input.take }),
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
  for (const dispatch of recovered) {
    await queueAgentDispatch({
      organizationId: dispatch.organizationId,
      runId: dispatch.runId,
      dispatchId: dispatch.id,
    });
  }
  return recovered.length;
}
