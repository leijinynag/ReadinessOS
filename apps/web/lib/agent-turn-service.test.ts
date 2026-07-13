import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentTurnResult, Observation } from '@readinessos/application';
import { AgentTurnService } from './agent-turn-service';

const handle = {
  runParticipantId: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  agentKey: 'director',
  sessionId: undefined,
  continuationToken: undefined,
  streamIndex: 0,
};
const result: AgentTurnResult = {
  handle,
  status: 'completed',
  proposedAction: undefined,
  inputRequests: [],
};
const observation = { participant: { id: handle.runParticipantId } } as Observation;

describe('AgentTurnService', () => {
  it('服务端构造 Observation 并调用受控 AgentRuntime', async () => {
    const runtime = fakeRuntime('active');
    const buildObservation = vi.fn().mockResolvedValue(observation);
    const requireAgentParticipant = vi.fn().mockResolvedValue(undefined);
    const service = new AgentTurnService({
      runtimeFactory: () => runtime,
      buildObservation,
      requireAgentParticipant,
    });

    await expect(service.turn(request({ type: 'observe' }))).resolves.toBe(result);
    expect(requireAgentParticipant).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledWith({
      runParticipantId: handle.runParticipantId,
      agentKey: 'director',
    });
    expect(buildObservation).toHaveBeenCalledOnce();
    expect(runtime.sendObservation).toHaveBeenCalledWith(handle, observation);
    expect(runtime.answerInput).not.toHaveBeenCalled();
  });

  it('仅 waiting session 可继续 HITL，且不重建 Observation', async () => {
    const runtime = fakeRuntime('waiting_for_input');
    const buildObservation = vi.fn();
    const service = new AgentTurnService({
      runtimeFactory: () => runtime,
      buildObservation,
      requireAgentParticipant: vi.fn(),
    });
    const input = {
      type: 'input-response' as const,
      response: { requestId: 'request', text: 'yes' },
    };

    await expect(service.turn(request(input))).resolves.toBe(result);
    expect(runtime.answerInput).toHaveBeenCalledWith(handle, input.response);
    expect(buildObservation).not.toHaveBeenCalled();
  });

  it('participant guard 失败时不创建 Runtime 或 Session', async () => {
    const runtimeFactory = vi.fn();
    const service = new AgentTurnService({
      runtimeFactory,
      buildObservation: vi.fn(),
      requireAgentParticipant: vi.fn().mockRejectedValue(new Error('participant rejected')),
    });

    await expect(service.turn(request({ type: 'observe' }))).rejects.toThrow(
      'participant rejected',
    );
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', 'observe while completed'],
    ['failed', 'observe while failed'],
    ['terminated', 'observe while terminated'],
  ] as const)('拒绝 %s session 接收 observe', async (status, message) => {
    const runtime = fakeRuntime(status);
    const service = new AgentTurnService({
      runtimeFactory: () => runtime,
      buildObservation: vi.fn(),
      requireAgentParticipant: vi.fn(),
    });

    await expect(service.turn(request({ type: 'observe' }))).rejects.toThrow(message);
    expect(runtime.sendObservation).not.toHaveBeenCalled();
  });

  it('waiting session 拒绝 observe 并要求继续 HITL', async () => {
    const runtime = fakeRuntime('waiting_for_input');
    const service = new AgentTurnService({
      runtimeFactory: () => runtime,
      buildObservation: vi.fn(),
      requireAgentParticipant: vi.fn(),
    });

    await expect(service.turn(request({ type: 'observe' }))).rejects.toThrow('waiting for input');
    expect(runtime.sendObservation).not.toHaveBeenCalled();
  });
});

function fakeRuntime(
  status: 'active' | 'waiting_for_input' | 'completed' | 'failed' | 'terminated',
): AgentRuntime {
  return {
    start: vi.fn().mockResolvedValue(handle),
    getStatus: vi.fn().mockResolvedValue(status),
    sendObservation: vi.fn().mockResolvedValue(result),
    answerInput: vi.fn().mockResolvedValue(result),
    terminate: vi.fn(),
  };
}

function request(input: Parameters<AgentTurnService['turn']>[0]['input']) {
  return {
    runId: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
    organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
    participantId: handle.runParticipantId,
    input,
  };
}
