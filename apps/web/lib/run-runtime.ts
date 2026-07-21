import {
  PrismaRunRepository,
  RunApplicationService,
  RunEventHub,
  RuntimeOutboxPublisher,
  type OutboxMessageHandler,
} from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { scenarioPackRegistry } from '@/lib/scenario-pack-registry';
import { withSpan } from './observability';

/**
 * Runtime 组合根只存在于 Web 层：Application 保持对 Next、Workflow、Eve
 * 与具体场景包无感，因而内核可在测试或其他宿主中复用。
 */
const repository = new PrismaRunRepository(prisma);
const hub = new RunEventHub();

let configuredOutboxHandlers: Readonly<Record<string, OutboxMessageHandler>> = {};
let publisher: RuntimeOutboxPublisher | undefined;
let outboxHandlerInitialization: Promise<void> | undefined;
let activeOutboxDrain: Promise<void> | undefined;

export const runService = new RunApplicationService(repository, scenarioPackRegistry);
export { hub as runEventHub, repository as runRepository };

export function configureRuntimeOutboxHandlers(
  handlers: Readonly<Record<string, OutboxMessageHandler>>,
) {
  configuredOutboxHandlers = handlers;
  publisher = new RuntimeOutboxPublisher(repository, hub, configuredOutboxHandlers);
}

/**
 * Next instrumentation 在不同运行模式下不一定会带上 NEXT_RUNTIME。Outbox 是
 * 命令成功后必须可用的运行时能力，不能只依赖 instrumentation 的一次性初始化。
 * 这里按需、幂等地装配所有宿主级 handler，供 API、Workflow 与 instrumentation
 * 共同调用。
 */
export async function ensureRuntimeOutboxHandlers(): Promise<void> {
  if (!outboxHandlerInitialization) {
    outboxHandlerInitialization = (async () => {
      const [scheduler, agentOutbox] = await Promise.all([
        import('@/lib/workflow-run-scheduler'),
        import('@/lib/agent-outbox'),
      ]);
      configureRuntimeOutboxHandlers(
        combineOutboxHandlers(
          scheduler.createRunSchedulerOutboxHandlers(scheduler.workflowRunScheduler, runService),
          agentOutbox.createAgentRecommendationOutboxHandlers(),
        ),
      );
    })().catch((error: unknown) => {
      // 初始化失败不能永久缓存一个 rejected Promise；后续请求与对账任务应能
      // 在临时依赖恢复后再次尝试装配。
      outboxHandlerInitialization = undefined;
      throw error;
    });
  }
  await outboxHandlerInitialization;
}

/**
 * Command 成功后立即尝试投递 Outbox。未投递完的消息仍由后续请求或对账任务
 * 接管，因此进程重启不会损失事件。
 */
export async function drainRuntimeOutbox(): Promise<void> {
  // 多个 HTTP 请求可能在同一时刻提交命令。共享一个 drain 能避免两个请求同时
  // claim 同一批 Outbox，也避免同一角色被并发地派发两次 Agent 分析。
  if (!activeOutboxDrain) {
    activeOutboxDrain = withSpan(
      'readinessos.outbox.drain',
      { 'outbox.max_batches': 10 },
      async () => {
        await ensureRuntimeOutboxHandlers();
        const activePublisher =
          publisher ?? new RuntimeOutboxPublisher(repository, hub, configuredOutboxHandlers);

        for (let batch = 0; batch < 10; batch += 1) {
          const count = await activePublisher.publishPending(100);
          if (count === 0) {
            return;
          }
        }
      },
    ).finally(() => {
      activeOutboxDrain = undefined;
    });
  }
  return activeOutboxDrain;
}

/**
 * Outbox topic 是全局消息契约。显式拒绝重名可以避免对象展开覆盖已有 handler，
 * 否则领域事件或 Agent 调度都会在运行时悄悄丢失。
 */
function combineOutboxHandlers(
  ...groups: readonly Readonly<Record<string, OutboxMessageHandler>>[]
): Readonly<Record<string, OutboxMessageHandler>> {
  const combined: Record<string, OutboxMessageHandler> = {};
  for (const group of groups) {
    for (const [topic, handler] of Object.entries(group)) {
      if (combined[topic] !== undefined) {
        throw new Error(`Duplicate Runtime Outbox handler for topic "${topic}".`);
      }
      combined[topic] = handler;
    }
  }
  return combined;
}
