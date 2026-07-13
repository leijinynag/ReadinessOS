import type {
  ClaimedOutboxMessage,
  OutboxMessageHandler,
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

/** Workflow 的实例标识不写入业务库；有效性由 Run generation 和 tick 顺序裁决。 */
export class WorkflowRunScheduler implements RunScheduler {
  async start(input: Parameters<RunScheduler['start']>[0]): Promise<void> {
    await start(runTickWorkflow, [input]);
  }

  async cancel(): Promise<void> {
    // 逻辑取消已由事务内 generation 更新完成。旧 Workflow 下次醒来会自行退出。
  }
}

export const workflowRunScheduler = new WorkflowRunScheduler();

function startHandler(scheduler: RunScheduler): OutboxMessageHandler {
  return {
    async handle(message: ClaimedOutboxMessage) {
      const instruction = startInstructionSchema.parse(message.payload);
      await scheduler.start({
        runId: instruction.runId,
        organizationId: message.organizationId,
        generation: instruction.generation,
        intervalSeconds: instruction.intervalSeconds,
        firstTickIndex: instruction.firstTickIndex,
      });
    },
  };
}

function cancelHandler(scheduler: RunScheduler): OutboxMessageHandler {
  return {
    async handle(message: ClaimedOutboxMessage) {
      const instruction = cancelInstructionSchema.parse(message.payload);
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
): Readonly<Record<string, OutboxMessageHandler>> {
  return {
    'run.scheduler.start': startHandler(scheduler),
    'run.scheduler.cancel': cancelHandler(scheduler),
  };
}

export const runSchedulerOutboxHandlers = createRunSchedulerOutboxHandlers(workflowRunScheduler);
