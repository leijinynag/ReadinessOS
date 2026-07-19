import { registerOTel } from '@vercel/otel';
import type { OutboxMessageHandler } from '@readinessos/application';

export async function register() {
  // 请求级 Trace 由 Vercel 注入；命令、Agent、Workflow 与 Outbox 会在各自边界补充子 Span。
  registerOTel({
    serviceName: 'readinessos-web',
  });

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [runtime, scheduler, agentOutbox] = await Promise.all([
      import('@/lib/run-runtime'),
      import('@/lib/workflow-run-scheduler'),
      import('@/lib/agent-outbox'),
    ]);
    runtime.configureRuntimeOutboxHandlers(
      combineOutboxHandlers(
        scheduler.createRunSchedulerOutboxHandlers(
          scheduler.workflowRunScheduler,
          runtime.runService,
        ),
        agentOutbox.createAgentRecommendationOutboxHandlers(),
      ),
    );
  }
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
