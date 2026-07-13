import { z } from 'zod';

/**
 * Agent 只能返回待执行的业务动作。它不持有 WorldState，也不能直接写入
 * 事件表；最终仍由 RunCommand 经过 SimulationKernel 校验和落库。
 */
export const proposedActionSchema = z.object({
  participantKey: z.string().min(1).max(128),
  actionType: z.string().min(1).max(128),
  parameters: z.record(z.string(), z.unknown()).default({}),
  rationale: z.string().min(1).max(4_000),
});
export type ProposedAction = z.infer<typeof proposedActionSchema>;

/**
 * 给 Agent 的观察只包含其参与方已经拥有的状态切片和近期事实。
 * 具体的知识域过滤由 Web Adapter 在构造 Observation 时完成。
 */
export const observationSchema = z.object({
  organizationId: z.string().uuid(),
  runId: z.string().uuid(),
  participantId: z.string().uuid(),
  participantKey: z.string().min(1),
  virtualTimeMinutes: z.number().int().nonnegative(),
  world: z.unknown(),
  recentEvents: z.array(
    z.object({
      sequence: z.number().int().positive(),
      type: z.string().min(1),
      payload: z.unknown(),
    }),
  ),
});
export type Observation = z.infer<typeof observationSchema>;

export interface AgentHandle {
  readonly sessionId: string | undefined;
  readonly continuationToken: string | undefined;
  readonly streamIndex: number;
}

export interface AgentRuntime {
  proposeAction(input: Observation): Promise<ProposedAction | undefined>;
}

export interface RunScheduler {
  start(input: {
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
    firstTickIndex: number;
  }): Promise<void>;
  cancel(input: { runId: string; organizationId: string; generation: number }): Promise<void>;
}

/**
 * 单测可用的调度器。它不触碰墙上时间，调用方可通过 takeNextTick 手动取得
 * 下一次应执行的 tick，再交给 RunApplicationService 执行。
 */
export class ManualRunScheduler implements RunScheduler {
  readonly started: Array<{
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
    firstTickIndex: number;
  }> = [];
  readonly cancelled: Array<{ runId: string; organizationId: string; generation: number }> = [];
  private readonly activeSchedules = new Map<
    string,
    {
      organizationId: string;
      generation: number;
      nextTickIndex: number;
    }
  >();
  private readonly minimumGeneration = new Map<string, number>();

  async start(input: {
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
    firstTickIndex: number;
  }): Promise<void> {
    this.started.push(input);
    const current = this.activeSchedules.get(input.runId);
    if (current && current.generation > input.generation) {
      return;
    }

    this.activeSchedules.set(input.runId, {
      organizationId: input.organizationId,
      generation: input.generation,
      // 重复消费同一条 Start Outbox 时，不能把已手动取得的 tick 倒退。
      nextTickIndex:
        current?.generation === input.generation
          ? Math.max(current.nextTickIndex, input.firstTickIndex)
          : input.firstTickIndex,
    });
  }

  async cancel(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<void> {
    this.cancelled.push(input);
    this.minimumGeneration.set(
      input.runId,
      Math.max(this.minimumGeneration.get(input.runId) ?? 0, input.generation),
    );
  }

  /**
   * 返回下一次需要执行的 tick。没有活跃调度时返回 undefined，便于测试精确
   * 验证 Pause 后不会继续推进、Resume 后只消费新 generation。
   */
  takeNextTick(runId: string):
    | {
        runId: string;
        organizationId: string;
        generation: number;
        tickIndex: number;
      }
    | undefined {
    const schedule = this.activeSchedules.get(runId);
    if (!schedule || schedule.generation < (this.minimumGeneration.get(runId) ?? 0)) {
      return undefined;
    }

    const tick = {
      runId,
      organizationId: schedule.organizationId,
      generation: schedule.generation,
      tickIndex: schedule.nextTickIndex,
    };
    schedule.nextTickIndex += 1;
    return tick;
  }
}
