import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findScenario: vi.fn(),
}));

vi.mock('@readinessos/database', () => ({
  prisma: {
    scenario: {
      findFirst: mocks.findScenario,
    },
  },
}));

const { getPublishedScenarioDetail } = await import('./scenario-query');

const scenarioId = '018f4c8b-9ae2-7a72-86bd-4f867befef01';
const organizationId = '018f4c8b-9ae2-7a72-86bd-4f867befefef02';
const participantId = '018f4c8b-9ae2-7a72-86bd-4f867befef03';
const publishedAt = new Date('2026-07-14T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findScenario.mockResolvedValue({
    id: scenarioId,
    key: 'saas-payment-incident',
    name: 'SaaS 支付服务故障',
    description: '支付服务故障演练。',
    versions: [
      {
        version: 3,
        publishedAt,
        config: {
          packKey: 'saas-incident',
          defaultDurationMinutes: 15,
          difficulty: 'intermediate',
          defaultSeed: 42,
          objectives: [{ key: 'recovery', label: '恢复服务' }],
          participants: [
            {
              id: participantId,
              key: 'commander',
              displayName: 'Incident Commander',
              controller: 'human',
              enabled: true,
              capabilities: ['declare-incident'],
              permissions: ['write:incident'],
              knowledgeScopes: ['incident'],
              objectives: ['recovery'],
            },
          ],
        },
      },
    ],
  });
});

describe('getPublishedScenarioDetail', () => {
  it('按组织读取最新已发布版本并解析配置', async () => {
    await expect(getPublishedScenarioDetail({ scenarioId, organizationId })).resolves.toMatchObject(
      {
        id: scenarioId,
        version: 3,
        publishedAt,
        config: {
          difficulty: 'intermediate',
          defaultSeed: 42,
        },
      },
    );

    expect(mocks.findScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: scenarioId,
          organizationId,
          status: 'published',
          versions: { some: { publishedAt: { not: null } } },
        },
        select: expect.objectContaining({
          versions: {
            where: { publishedAt: { not: null } },
            orderBy: { version: 'desc' },
            take: 1,
            select: { version: true, config: true, publishedAt: true },
          },
        }),
      }),
    );
  });

  it.each([
    ['场景不存在或未发布', null],
    [
      '没有已发布版本',
      {
        id: scenarioId,
        key: 'draft',
        name: 'Draft',
        description: 'Draft',
        versions: [],
      },
    ],
  ])('%s 时返回 null', async (_label, value) => {
    mocks.findScenario.mockResolvedValue(value);
    await expect(getPublishedScenarioDetail({ scenarioId, organizationId })).resolves.toBeNull();
  });

  it('配置结构非法时明确拒绝', async () => {
    mocks.findScenario.mockResolvedValue({
      id: scenarioId,
      key: 'invalid',
      name: 'Invalid',
      description: 'Invalid',
      versions: [{ version: 1, publishedAt, config: { packKey: 'invalid' } }],
    });

    await expect(getPublishedScenarioDetail({ scenarioId, organizationId })).rejects.toThrow();
  });
});
