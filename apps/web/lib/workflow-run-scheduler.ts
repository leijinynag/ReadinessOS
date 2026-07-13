import type {
  ClaimedOutboxMessage,
  OutboxMessageHandler,
  RunScheduleClaimResult,
  RunScheduler,
} from '@readinessos/application';
import { start } from 'workflow/api';
import { z } from 'zod';
import { runTickWorkflow } from '@/workflows/run-tick';

const startInstructionSchema = z.object({
  type: z.literal('start'),
  runId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  intervalSeconds: z.number().int().positive(),
  firstTickIndex: z.number().int().positive(),
});

const cancelInstructionSchema = z.object({
  type: z.literal('cancel'),
  runId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
});

type RunScheduleLeaseService = {
  claimRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<RunScheduleClaimResult>;
  releaseRunSchedule(input: Parameters<RunScheduler['start']>[0]): Promise<boolean>;
  releaseObsoleteRunSchedule(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<void>;
};

/** Workflow 是否仍有效由数据库租约的 generation 和 holder 双重裁决。 */
export class WorkflowRunScheduler implements RunScheduler {
  async start(input: Parameters<RunScheduler['start']>[0]): Promise<void> {
    await start(runTickWorkflow, [input]);
  }

  async cancel(): Promise<void> {
    // 物理 Workflow ID 不参与正确性；cancel handler 会释放旧 generation 的租约。
  }
}

export const workflowRunScheduler = new WorkflowRunScheduler();

function startHandler(
  scheduler: RunScheduler,
  leases: RunScheduleLeaseService,
): OutboxMessageHandler {
  return {
    async handle(message: ClaimedOutboxMessage) {
      const instruction = startInstructionSchema.parse(message.payload);
      const claim = await leases.claimRunSchedule({
        runId: instruction.runId,
        organizationId: message.organizationId,
        generation: instruction.generation,
      });
      if (claim.status !== 'claimed') {
        return;
      }
      try {
        await scheduler.start(claim.lease);
      } catch (error) {
        await leases.releaseRunSchedule(claim.lease);
        throw error;
      }
    },
  };
}

function cancelHandler(
  scheduler: RunScheduler,
  leases: RunScheduleLeaseService,
): OutboxMessageHandler {
  return {
    async handle(message: ClaimedOutboxMessage) {
      const instruction = cancelInstructionSchema.parse(message.payload);
      await leases.releaseObsoleteRunSchedule({
        runId: instruction.runId,
        organizationId: message.organizationId,
        generation: instruction.generation,
      });
      await scheduler.cancel({
        runId: instruction.runId,
        organizationId: message.organizationId,
        generation: instruction.generation,
      });
    },
  };
}

export function createRunSchedulerOutboxHandlers(
  scheduler: RunScheduler,
  leases: RunScheduleLeaseService,
): Readonly<Record<string, OutboxMessageHandler>> {
  return {
    'run.scheduler.start': startHandler(scheduler, leases),
    'run.scheduler.cancel': cancelHandler(scheduler, leases),
  };
}
