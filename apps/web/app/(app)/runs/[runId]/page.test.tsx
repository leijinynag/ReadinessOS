import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  findRun: vi.fn(),
  findParticipants: vi.fn(),
  getRun: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth-session', () => ({ getAuthSession: mocks.getAuthSession }));
vi.mock('@/lib/run-runtime', () => ({ runService: { getRun: mocks.getRun } }));
vi.mock('@readinessos/database', () => ({
  prisma: {
    simulationRun: { findUnique: mocks.findRun },
    runParticipant: { findMany: mocks.findParticipants },
  },
}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));

const { default: LiveRunPage } = await import('./page');

const runId = '018f4c8b-9ae2-7a72-86bd-4f867befef11';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef12';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({
    userId: 'user-1',
    email: 'demo@readinessos.local',
    memberships: [{ organizationId, role: 'owner' }],
  });
  mocks.findRun.mockResolvedValue({ organizationId });
  mocks.getRun.mockResolvedValue(runFixture());
  mocks.findParticipants.mockResolvedValue([
    {
      id: '018f4c8b-9ae2-7a72-86bd-4f867befef13',
      key: 'incident-commander',
      displayName: 'Incident Commander',
      controller: 'human',
      capabilities: ['declare-incident', 'coordinate-response'],
      objectives: ['serviceAvailability', 'customerTrust'],
      projection: { status: 'active', data: {} },
    },
  ]);
});

describe('LiveRunPage', () => {
  it('在鉴权后读取运行时投影并展示响应式工作台的初始内容', async () => {
    render(await renderPage());

    expect(screen.getByRole('heading', { name: '运行工作台' })).toBeVisible();
    expect(screen.getByText(`Run ID: ${runId}`)).toBeVisible();
    expect(screen.getByText('运行中')).toBeVisible();
    expect(screen.getByText('虚拟时间 T+4 分钟')).toBeVisible();
    expect(screen.getByText('96%')).toBeVisible();
    expect(screen.getByText('SEV1')).toBeVisible();
    expect(screen.getByRole('heading', { name: '参与方检查器' })).toBeVisible();
    expect(screen.getByText('Incident Commander')).toBeVisible();
    expect(screen.getByText('事件流准备加载')).toBeVisible();
    expect(screen.getByRole('link', { name: '返回场景列表' })).toHaveAttribute(
      'href',
      '/scenarios',
    );
    expect(mocks.getRun).toHaveBeenCalledWith(runId, organizationId);
    expect(mocks.findParticipants).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId } }),
    );
  });

  it('未登录时跳转，且不读取 Run', async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(mocks.findRun).not.toHaveBeenCalled();
  });

  it('Run 不存在时返回 not found', async () => {
    mocks.findRun.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.findParticipants).not.toHaveBeenCalled();
  });

  it('无 Run 所属组织权限时拒绝读取投影', async () => {
    mocks.getAuthSession.mockResolvedValue({
      userId: 'user-1',
      email: 'outsider@example.com',
      memberships: [{ organizationId: 'other-organization', role: 'owner' }],
    });

    await expect(renderPage()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.findParticipants).not.toHaveBeenCalled();
  });
});

function renderPage() {
  return LiveRunPage({ params: Promise.resolve({ runId }) });
}

function runFixture() {
  return {
    id: runId,
    organizationId,
    scenarioVersionId: '018f4c8b-9ae2-7a72-86bd-4f867befef14',
    status: 'running' as const,
    version: 3,
    seed: 42,
    virtualTime: 4,
    latestSequence: 9,
    schedulerGeneration: 1,
    nextTickIndex: 2,
    tickIntervalSeconds: 15,
    startedAt: '2026-07-16T00:00:00.000Z',
    completedAt: undefined,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    data: {
      pendingApprovalIds: ['approval-1'],
      world: {
        service: {
          paymentSuccessRate: 0.96,
          errorRate: 0.04,
          latencyP95Ms: 810,
        },
        impact: {
          affectedCustomers: 242,
          estimatedRevenueLoss: 185000,
        },
        response: { severity: 'sev1' },
        objectives: {
          serviceAvailability: 'at-risk',
          customerTrust: 'healthy',
        },
      },
    },
  };
}
