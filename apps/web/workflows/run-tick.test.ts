import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  renewRunSchedule: vi.fn(),
  executeScheduledTick: vi.fn(),
  hasAgentDecisionBlocker: vi.fn(),
  drainRuntimeOutbox: vi.fn(),
}));

vi.mock('workflow', () => ({
  sleep: vi.fn(),
}));
vi.mock('@/lib/agent-dispatch-queue', () => ({
  hasAgentDecisionBlocker: mocks.hasAgentDecisionBlocker,
}));
vi.mock('@/lib/observability', () => ({
  withSpan: <T>(_name: string, _attributes: Record<string, unknown>, callback: () => T) =>
    callback(),
}));
vi.mock('@/lib/run-runtime', () => ({
  runService: {
    renewRunSchedule: mocks.renewRunSchedule,
    executeScheduledTick: mocks.executeScheduledTick,
  },
  drainRuntimeOutbox: mocks.drainRuntimeOutbox,
}));

const { executeRunTickStep } = await import('./run-tick');

const input = {
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
  generation: 2,
  holderId: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
  tickIndex: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renewRunSchedule.mockResolvedValue(true);
  mocks.hasAgentDecisionBlocker.mockResolvedValue(false);
  mocks.executeScheduledTick.mockResolvedValue({
    result: { status: 'accepted' },
  });
  mocks.drainRuntimeOutbox.mockResolvedValue(undefined);
});

describe('run tick workflow', () => {
  it('有待裁决建议或待回答问题时不推进虚拟时钟', async () => {
    mocks.hasAgentDecisionBlocker.mockResolvedValue(true);

    await expect(executeRunTickStep(input)).resolves.toBe('blocked');

    expect(mocks.renewRunSchedule).toHaveBeenCalledWith(input);
    expect(mocks.hasAgentDecisionBlocker).toHaveBeenCalledWith({
      runId: input.runId,
      organizationId: input.organizationId,
    });
    expect(mocks.executeScheduledTick).not.toHaveBeenCalled();
    expect(mocks.drainRuntimeOutbox).not.toHaveBeenCalled();
  });

  it('没有 Agent 决策窗口时按原调度推进并投递派生任务', async () => {
    await expect(executeRunTickStep(input)).resolves.toBe('advanced');

    expect(mocks.executeScheduledTick).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        minutes: 1,
        issuedAt: expect.any(String),
      }),
    );
    expect(mocks.drainRuntimeOutbox).toHaveBeenCalledOnce();
  });
});
