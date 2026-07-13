import { sleep } from 'workflow';
import { runService } from '@/lib/run-runtime';
import { workflowRunScheduler } from '@/lib/workflow-run-scheduler';

const reconciliationIntervalMilliseconds = 5 * 60 * 1_000;
const reconciliationBatchSize = 50;

/** 低频对账允许重复启动；每个有效 tick 仍由数据库 generation 和序号唯一裁决。 */
export async function reconcileRunsWorkflow(): Promise<void> {
  'use workflow';

  while (true) {
    await sleep(reconciliationIntervalMilliseconds);
    await reconcileRunsStep();
  }
}

async function reconcileRunsStep(): Promise<void> {
  'use step';

  await runService.reconcileRunningRuns(workflowRunScheduler, reconciliationBatchSize);
}
