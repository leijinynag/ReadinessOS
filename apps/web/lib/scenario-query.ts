import { z } from 'zod';
import { prisma } from '@readinessos/database';

const scenarioObjectiveSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

const scenarioParticipantSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  displayName: z.string().min(1),
  controller: z.enum(['human', 'agent', 'system']),
  enabled: z.boolean(),
  capabilities: z.array(z.string().min(1)),
  permissions: z.array(z.string().min(1)),
  knowledgeScopes: z.array(z.string().min(1)),
  objectives: z.array(z.string().min(1)),
});

export const studioScenarioConfigSchema = z
  .object({
    packKey: z.string().min(1),
    defaultDurationMinutes: z.number().int().positive(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
    defaultSeed: z.number().int().min(0).max(2_147_483_647),
    objectives: z.array(scenarioObjectiveSchema),
    participants: z.array(scenarioParticipantSchema),
  })
  .passthrough();

export type StudioScenarioConfig = z.infer<typeof studioScenarioConfigSchema>;

export type StudioScenarioDetail = {
  id: string;
  key: string;
  name: string;
  description: string;
  version: number;
  publishedAt: Date;
  config: StudioScenarioConfig;
};

export async function getPublishedScenarioDetail(input: {
  scenarioId: string;
  organizationId: string;
}): Promise<StudioScenarioDetail | null> {
  // 即使 organizationId 已由调用方完成授权，查询仍显式约束租户和发布状态，防止路径 ID 越界读取。
  const scenario = await prisma.scenario.findFirst({
    where: {
      id: input.scenarioId,
      organizationId: input.organizationId,
      status: 'published',
      versions: {
        some: {
          publishedAt: { not: null },
        },
      },
    },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      versions: {
        where: { publishedAt: { not: null } },
        orderBy: { version: 'desc' },
        take: 1,
        select: {
          version: true,
          config: true,
          publishedAt: true,
        },
      },
    },
  });

  const version = scenario?.versions[0];
  if (!scenario || !version?.publishedAt) {
    return null;
  }

  return {
    id: scenario.id,
    key: scenario.key,
    name: scenario.name,
    description: scenario.description,
    version: version.version,
    publishedAt: version.publishedAt,
    config: studioScenarioConfigSchema.parse(version.config),
  };
}
