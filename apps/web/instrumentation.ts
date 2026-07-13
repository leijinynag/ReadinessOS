import { registerOTel } from '@vercel/otel';

export async function register() {
  // 仅注册基础请求 Trace；命令级 Span 将随 W3 的 Command Handler 一起补充。
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
