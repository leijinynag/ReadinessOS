import { runService } from '@/lib/run-runtime';
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

  return withSpan(
    'readinessos.workflow.reconcile_runs',
    { 'workflow.batch_size': reconciliationBatchSize },
    () => runService.reconcileRunningRuns(workflowRunScheduler, reconciliationBatchSize),
  );
}
