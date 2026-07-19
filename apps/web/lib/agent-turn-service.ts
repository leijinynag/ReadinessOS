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
  | { type: 'observe'; intent?: AgentObservationIntent }
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

  async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const participant = await this.dependencies.requireAgentParticipant(request);
    const runtime = this.dependencies.runtimeFactory();
    const handle = await runtime.start({
      runParticipantId: request.participantId,
      agentKey: participant.agentKey,
    });
    const status = await runtime.getStatus(handle);

    if (request.input.type === 'input-response') {
      if (status !== 'waiting_for_input') {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The agent session is not waiting for input.',
        );
      }
      return runtime.answerInput(handle, request.input.response);
    }

    if (status === 'waiting_for_input') {
      throw new ApplicationError(
        'APPROVAL_REQUIRED',
        'The agent session is waiting for input.',
      );
    }

    // Eve completed/failed/terminated 后的观察会由 Runtime 开启新的 durable
    // session；只有 waiting 状态需要并且只能通过 continuation 回答问题。
    const observation = await this.dependencies.buildObservation(request);
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
