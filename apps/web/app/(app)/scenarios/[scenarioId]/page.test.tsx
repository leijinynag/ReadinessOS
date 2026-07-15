import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  findOrganization: vi.fn(),
  getScenario: vi.fn(),
  push: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth-session', () => ({ getAuthSession: mocks.getAuthSession }));
vi.mock('@/lib/scenario-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenario-query')>();
  return { ...actual, getPublishedScenarioDetail: mocks.getScenario };
});
vi.mock('@readinessos/database', () => ({
  prisma: { organization: { findUnique: mocks.findOrganization } },
}));
vi.mock('./scenario-graph', () => ({
  ScenarioGraph: ({ graph }: { graph: { packKey: string } | null }) => (
    <section aria-label="只读 Scenario Graph">{graph?.packKey ?? '图不可用'}</section>
  ),
}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
  useRouter: () => ({ push: mocks.push }),
}));

const { default: ScenarioDetailPage } = await import('./page');
const scenarioId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befef02';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({
    userId: 'user-1',
    email: 'demo@readinessos.local',
    memberships: [{ organizationId, role: 'owner' }],
  });
  mocks.findOrganization.mockResolvedValue({ id: organizationId });
  mocks.getScenario.mockResolvedValue(scenarioFixture());
});

describe('ScenarioDetailPage', () => {
  it('展示最新发布版本和可继续配置的场景信息', async () => {
    render(await renderPage());

    expect(screen.getByRole('heading', { name: 'SaaS 支付服务故障' })).toBeVisible();
    expect(screen.getByText('已发布 v2')).toBeVisible();
    expect(screen.getByText('15 分钟')).toBeVisible();
    expect(screen.getByText('进阶')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: '随机种子' })).toHaveValue(42);
    expect(screen.getByRole('checkbox', { name: /恢复服务可用性/ })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Incident Commander' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Controller' })).toHaveValue('human');
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByRole('link', { name: '返回场景列表' })).toHaveAttribute(
      'href',
      '/scenarios',
    );
    expect(mocks.getScenario).toHaveBeenCalledWith({ scenarioId, organizationId });
  });

  it('未登录时立即跳转且不读取组织或场景', async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(mocks.redirect).toHaveBeenCalledWith('/login');
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.getScenario).not.toHaveBeenCalled();
  });

  it('无组织权限时拒绝访问且不读取场景', async () => {
    mocks.getAuthSession.mockResolvedValue({
      userId: 'user-1',
      email: 'outsider@example.com',
      memberships: [{ organizationId: 'other-organization', role: 'owner' }],
    });

    await expect(renderPage()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.getScenario).not.toHaveBeenCalled();
  });

  it('演示组织不存在时返回 not found', async () => {
    mocks.findOrganization.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getScenario).not.toHaveBeenCalled();
  });

  it.each(['场景不存在', '场景未发布或没有已发布版本'])('%s 时返回 not found', async () => {
    mocks.getScenario.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getScenario).toHaveBeenCalledWith({ scenarioId, organizationId });
  });
});

function renderPage() {
  return ScenarioDetailPage({ params: Promise.resolve({ scenarioId }) });
}

function scenarioFixture() {
  return {
    id: scenarioId,
    key: 'saas-payment-incident',
    name: 'SaaS 支付服务故障',
    description: '支付成功率下降时的跨职能事故演练。',
    version: 2,
    publishedAt: new Date('2026-07-14T00:00:00.000Z'),
    config: {
      packKey: 'saas-incident',
      defaultDurationMinutes: 15,
      difficulty: 'intermediate' as const,
      defaultSeed: 42,
      objectives: [
        {
          key: 'serviceAvailability',
          label: '恢复服务可用性',
          description: '控制故障扩散。',
        },
      ],
      participants: [
        {
          id: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
          key: 'incident-commander',
          displayName: 'Incident Commander',
          controller: 'human' as const,
          enabled: true,
          capabilities: ['declare-incident'],
          permissions: ['write:incident'],
          knowledgeScopes: ['incident'],
          objectives: ['serviceAvailability'],
        },
      ],
    },
  };
}
