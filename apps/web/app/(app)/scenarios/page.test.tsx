import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScenariosPage from './page';

vi.mock('@/lib/auth-session', () => ({
  getAuthSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    email: 'demo@readinessos.local',
    memberships: [
      {
        organizationId: 'organization-1',
        role: 'owner',
      },
    ],
  }),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'organization-1',
      }),
    },
    scenario: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'scenario-1',
          name: 'SaaS 支付服务故障',
          description: '支付服务故障演练。',
          versions: [
            {
              version: 1,
              config: {
                defaultDurationMinutes: 15,
              },
            },
          ],
        },
      ]),
    },
  },
}));

describe('ScenariosPage', () => {
  it('renders a published scenario', async () => {
    render(await ScenariosPage());

    expect(screen.getByRole('heading', { name: '选择一次业务韧性演练' })).toBeVisible();
    expect(screen.getByText('SaaS 支付服务故障')).toBeVisible();
    expect(screen.getByRole('link', { name: '打开SaaS 支付服务故障' })).toHaveAttribute(
      'href',
      '/scenarios/scenario-1',
    );
  });
});
