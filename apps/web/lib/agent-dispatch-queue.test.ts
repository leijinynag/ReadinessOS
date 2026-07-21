import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: { findFirst: mocks.findRun },
  },
}));
vi.mock('@/lib/agent-recommendation-service', () => ({
  AgentRecommendationService: class {},
}));

const { hasAgentDecisionBlocker } = await import('./agent-dispatch-queue');

const input = {
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Agent dispatch clock blocker', () => {
  it('首次 pending/running 分析也会暂停自动时钟，保护建议的事实基线', async () => {
    mocks.findRun.mockResolvedValue({
      _count: { agentRecommendations: 0, agentDispatches: 1 },
    });

    await expect(hasAgentDecisionBlocker(input)).resolves.toBe(true);
    expect(mocks.findRun).toHaveBeenCalledWith({
      where: { id: input.runId, organizationId: input.organizationId },
      select: {
        _count: {
          select: {
            agentRecommendations: { where: { status: 'pending' } },
            agentDispatches: {
              where: {
                OR: [
                  { status: 'waiting_for_input' },
                  {
                    status: { in: ['pending', 'running'] },
                    lastError: null,
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  it('没有建议、问题或首次分析时允许自动时钟推进', async () => {
    mocks.findRun.mockResolvedValue({
      _count: { agentRecommendations: 0, agentDispatches: 0 },
    });

    await expect(hasAgentDecisionBlocker(input)).resolves.toBe(false);
  });
});
