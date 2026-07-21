import type {
  AgentObservationIntent,
  AgentInputResponse,
  AgentRuntime,
  AgentTurnResult,
  Observation,
} from '@readinessos/application';
import { ApplicationError } from '@readinessos/domain-events';
import { createHash } from 'node:crypto';

export type AgentTurnInput =
  | {
      type: 'observe';
      intent?: AgentObservationIntent;
      /**
       * Dispatch 在调用 Eve 前构造并验证过的 Observation。只允许内部调度
       * 传入，目的是避免同一份角色事实被重复读取后产生不必要的模型调用。
       */
      observation?: Observation;
    }
  | { type: 'input-response'; response: AgentInputResponse };

export type AgentTurnRequest = {
  runId: string;
  organizationId: string;
  participantId: string;
  input: AgentTurnInput;
};

type AgentTurnDependencies = {
  runtimeFactory(): AgentRuntime;
  buildObservation(input: {
    runId: string;
    organizationId: string;
    participantId: string;
  }): Promise<Observation>;
  requireAgentParticipant(input: {
    runId: string;
    organizationId: string;
    participantId: string;
  }): Promise<{ agentKey: string }>;
};

/**
 * Agent turn 只编排 Observation 和 Eve Session。该服务不持有 Run command、
 * Outbox 或 Kernel 依赖，因而 ProposedAction 不可能在此处改变 WorldState。
 */
export class AgentTurnService {
  constructor(private readonly dependencies: AgentTurnDependencies) {}

  /**
   * 在创建 Eve Session 前构造角色可见事实。Dispatcher 使用它判断当前是否
   * 存在 Kernel 已授权的建议动作；空集合时直接写审计并结束，不消耗模型预算。
   */
  async buildObservation(input: {
    runId: string;
    organizationId: string;
    participantId: string;
  }): Promise<Observation> {
    await this.dependencies.requireAgentParticipant(input);
    return this.dependencies.buildObservation(input);
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const participant = await this.dependencies.requireAgentParticipant(request);

    if (request.input.type === 'input-response') {
      const runtime = this.dependencies.runtimeFactory();
      const handle = await runtime.start({
        runParticipantId: request.participantId,
        agentKey: participant.agentKey,
      });
      const status = await runtime.getStatus(handle);
      if (status !== 'waiting_for_input') {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The agent session is not waiting for input.',
        );
      }
      return runtime.answerInput(handle, request.input.response);
    }

    // Dispatch 可传入已预检的 Observation，保证“空动作不调用 Eve”与实际
    // 发送给 Eve 的事实一致。其他内部调用仍由服务端即时构造 Observation。
    const observation =
      request.input.observation ?? (await this.dependencies.buildObservation(request));
    const runtime = this.dependencies.runtimeFactory();
    const handle = await runtime.start({
      runParticipantId: request.participantId,
      agentKey: participant.agentKey,
    });
    const status = await runtime.getStatus(handle);
    if (status === 'waiting_for_input') {
      throw new ApplicationError(
        'APPROVAL_REQUIRED',
        'The agent session is waiting for input.',
      );
    }

    // Eve completed/failed/terminated 后的观察会由 Runtime 开启新的 durable
    // session；只有 waiting 状态需要并且只能通过 continuation 回答问题。
    const result =
      request.input.intent === undefined || request.input.intent === 'recommend'
        ? await runtime.sendObservation(handle, observation)
        : await runtime.sendObservation(handle, observation, { intent: request.input.intent });
    return {
      ...result,
      observationHash: createHash('sha256')
        .update(JSON.stringify(observation))
        .digest('hex'),
    };
  }
}
