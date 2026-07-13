import { registerOTel } from '@vercel/otel';

export async function register() {
  // 仅注册基础请求 Trace；命令级 Span 将随 W3 的 Command Handler 一起补充。
  registerOTel({
    serviceName: 'readinessos-web',
  });

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [workflowApi, runtime, scheduler, reconciliation] = await Promise.all([
      import('workflow/api'),
      import('@/lib/run-runtime'),
      import('@/lib/workflow-run-scheduler'),
      import('@/workflows/reconcile-runs'),
    ]);
    runtime.configureRuntimeOutboxHandlers(scheduler.runSchedulerOutboxHandlers);
    // 多实例可能各自启动对账 Workflow；它们只会重复发起受 generation 保护的 start。
    await workflowApi.start(reconciliation.reconcileRunsWorkflow, []);
  }
}
