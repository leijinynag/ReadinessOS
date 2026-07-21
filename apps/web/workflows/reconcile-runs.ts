import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { recoverStaleAgentDispatches } from '@/lib/agent-dispatch-queue';
import { workflowRunScheduler } from '@/lib/workflow-run-scheduler';
import { withSpan } from '@/lib/observability';

const reconciliationBatchSize = 50;

/** 每次 Cron 只执行一个有界批次；活跃租约存在时 Application 不会重复 start。 */
export async function reconcileRunsWorkflow(): Promise<number> {
  'use workflow';

  return reconcileRunsStep();
}

async function reconcileRunsStep(): Promise<number> {
  'use step';

  const reconciled = await withSpan(
    'readinessos.workflow.reconcile_runs',
    { 'workflow.batch_size': reconciliationBatchSize },
    () => runService.reconcileRunningRuns(workflowRunScheduler, reconciliationBatchSize),
  );
  const recoveredDispatches = await recoverStaleAgentDispatches({
    take: reconciliationBatchSize,
  });
  // Agent Dispatch 的退避重试同样通过 Outbox 驱动。Cron 不直接调用 Eve，
  // 只唤醒到期消息，避免维护任务绕过既有的幂等和重试边界。
  await drainRuntimeOutbox();
  return reconciled + recoveredDispatches;
}
