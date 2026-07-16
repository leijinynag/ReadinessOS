import type { RunScheduler } from '@readinessos/application';
import { sleep } from 'workflow';
import { withSpan } from '@/lib/observability';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';

export type RunTickWorkflowInput = Parameters<RunScheduler['start']>[0];

const heartbeatIntervalMilliseconds = 60_000;

type LeaseInput = Pick<
  RunTickWorkflowInput,
  'runId' | 'organizationId' | 'generation' | 'holderId'
>;

type RunTickStepInput = LeaseInput & { tickIndex: number };

export async function runTickWorkflow(input: RunTickWorkflowInput): Promise<void> {
  'use workflow';

  if (!(await renewRunScheduleStep(input))) {
    return;
  }

  let tickIndex = input.firstTickIndex;
  let remainingMilliseconds = input.intervalSeconds * 1_000;
  try {
    while (true) {
      const sleepMilliseconds = Math.min(remainingMilliseconds, heartbeatIntervalMilliseconds);
      await sleep(sleepMilliseconds);
      remainingMilliseconds -= sleepMilliseconds;

      if (!(await renewRunScheduleStep(input))) {
        return;
      }
      if (remainingMilliseconds > 0) {
        continue;
      }

      const executed = await executeRunTickStep({
        runId: input.runId,
        organizationId: input.organizationId,
        generation: input.generation,
        holderId: input.holderId,
        tickIndex,
      });
      if (!executed) {
        return;
      }
      tickIndex += 1;
      remainingMilliseconds = input.intervalSeconds * 1_000;
    }
  } finally {
    await releaseRunScheduleStep(input);
  }
}

async function renewRunScheduleStep(input: LeaseInput): Promise<boolean> {
  'use step';

  return withSpan(
    'readinessos.workflow.renew_run_schedule',
    { 'run.id': input.runId, 'workflow.generation': input.generation },
    () => runService.renewRunSchedule(input),
  );
}

async function releaseRunScheduleStep(input: LeaseInput): Promise<void> {
  'use step';

  await withSpan(
    'readinessos.workflow.release_run_schedule',
    { 'run.id': input.runId, 'workflow.generation': input.generation },
    () => runService.releaseRunSchedule(input),
  );
}

async function executeRunTickStep(input: RunTickStepInput): Promise<boolean> {
  'use step';

  // tick 前再次续租，确保 takeover 后的旧 Workflow 不能穿透到领域命令。
  if (!(await runService.renewRunSchedule(input))) {
    return false;
  }
  const execution = await withSpan(
    'readinessos.workflow.run_tick',
    {
      'run.id': input.runId,
      'workflow.generation': input.generation,
      'workflow.tick_index': input.tickIndex,
    },
    () =>
      runService.executeScheduledTick({
        runId: input.runId,
        organizationId: input.organizationId,
        generation: input.generation,
        tickIndex: input.tickIndex,
        holderId: input.holderId,
        minutes: 1,
        issuedAt: new Date().toISOString(),
      }),
  );
  if (!execution || execution.result.status === 'duplicate') {
    return false;
  }

  await drainRuntimeOutbox();
  return true;
}
