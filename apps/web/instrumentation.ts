import { registerOTel } from '@vercel/otel';

export async function register() {
  // 请求级 Trace 由 Vercel 注入；命令、Agent、Workflow 与 Outbox 会在各自边界补充子 Span。
  registerOTel({
    serviceName: 'readinessos-web',
  });

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [runtime, scheduler] = await Promise.all([
      import('@/lib/run-runtime'),
      import('@/lib/workflow-run-scheduler'),
    ]);
    runtime.configureRuntimeOutboxHandlers(
      scheduler.createRunSchedulerOutboxHandlers(
        scheduler.workflowRunScheduler,
        runtime.runService,
      ),
    );
  }
}
