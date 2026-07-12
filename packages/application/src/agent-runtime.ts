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
  }): Promise<void>;
  cancel(input: { runId: string; organizationId: string; generation: number }): Promise<void>;
}

/**
 * 单测可用的调度器。它不推进时钟，只记录持久化 Outbox 期望触发的操作。
 */
export class ManualRunScheduler implements RunScheduler {
  readonly started: Array<{
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
  }> = [];
  readonly cancelled: Array<{ runId: string; organizationId: string; generation: number }> = [];

  async start(input: {
    runId: string;
    organizationId: string;
    generation: number;
    intervalSeconds: number;
  }): Promise<void> {
    this.started.push(input);
  }

  async cancel(input: {
    runId: string;
    organizationId: string;
    generation: number;
  }): Promise<void> {
    this.cancelled.push(input);
  }
}
