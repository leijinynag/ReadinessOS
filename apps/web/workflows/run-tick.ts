import type { RunScheduler } from '@readinessos/application';
import { sleep } from 'workflow';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';

export type RunTickWorkflowInput = Parameters<RunScheduler['start']>[0];

type RunTickStepInput = Pick<RunTickWorkflowInput, 'runId' | 'organizationId' | 'generation'> & {
  tickIndex: number;
};

export async function runTickWorkflow(input: RunTickWorkflowInput): Promise<void> {
  'use workflow';

  let tickIndex = input.firstTickIndex;
  while (true) {
    await sleep(input.intervalSeconds * 1_000);
    const executed = await executeRunTickStep({
      runId: input.runId,
      organizationId: input.organizationId,
      generation: input.generation,
      tickIndex,
    });
    if (!executed) {
      return;
    }
    tickIndex += 1;
  }
}

async function executeRunTickStep(input: RunTickStepInput): Promise<boolean> {
  'use step';

  const execution = await runService.executeScheduledTick({
    ...input,
    minutes: 1,
    issuedAt: new Date().toISOString(),
  });
  if (!execution || execution.result.status === 'duplicate') {
    return false;
  }

  await drainRuntimeOutbox();
  return true;
}
