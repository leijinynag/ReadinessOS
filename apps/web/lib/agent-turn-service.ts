import type {
  AgentInputResponse,
  AgentRuntime,
  AgentTurnResult,
  Observation,
} from '@readinessos/application';
import { ApplicationError } from '@readinessos/domain-events';

export type AgentTurnInput =
  { type: 'observe' } | { type: 'input-response'; response: AgentInputResponse };

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
  }): Promise<void>;
};

const directorAgentKey = 'director';

/**
 * Agent turn 只编排 Observation 和 Eve Session。该服务不持有 Run command、
 * Outbox 或 Kernel 依赖，因而 ProposedAction 不可能在此处改变 WorldState。
 */
export class AgentTurnService {
  constructor(private readonly dependencies: AgentTurnDependencies) {}

  async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    await this.dependencies.requireAgentParticipant(request);
    const runtime = this.dependencies.runtimeFactory();
    const handle = await runtime.start({
      runParticipantId: request.participantId,
      agentKey: directorAgentKey,
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

    if (status !== 'active') {
      throw new ApplicationError(
        status === 'waiting_for_input' ? 'APPROVAL_REQUIRED' : 'VALIDATION_ERROR',
        status === 'waiting_for_input'
          ? 'The agent session is waiting for input.'
          : `The agent session cannot observe while ${status}.`,
      );
    }

    const observation = await this.dependencies.buildObservation(request);
    return runtime.sendObservation(handle, observation);
  }
}
