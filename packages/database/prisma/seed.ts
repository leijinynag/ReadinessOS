import { PrismaClient } from '@prisma/client';
import { saasIncidentPack } from '@readinessos/scenario-pack-saas-incident';
import {
  nextSeedScenarioVersion,
  saasIncidentSeedRevision,
  studioSeedRevision,
} from './seed-version';

const prisma = new PrismaClient();

const demoEmail = process.env.AUTH_DEMO_EMAIL ?? 'demo@readinessos.local';

const saasParticipants = saasIncidentPack.participants.map((participant) => ({
  id: participant.id,
  key: participant.key,
  displayName: participant.displayName,
  controller: participant.controller,
  enabled: true,
  capabilities: [...participant.capabilities],
  permissions: [...participant.permissions],
  knowledgeScopes: [...participant.knowledgeScopes],
  objectives: [...participant.objectives],
}));

async function main() {
  const organization = await prisma.organization.upsert({
    where: { slug: 'readiness-demo' },
    update: {
      name: 'ReadinessOS Demo',
    },
    create: {
      slug: 'readiness-demo',
      name: 'ReadinessOS Demo',
    },
  });

  const user = await prisma.user.upsert({
    where: { email: demoEmail },
    update: {
      name: 'Demo Operator',
    },
    create: {
      email: demoEmail,
      name: 'Demo Operator',
    },
  });

  await prisma.member.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: {
      role: 'owner',
    },
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: 'owner',
    },
  });

  const scenarios = [
    {
      key: 'saas-payment-incident',
      name: 'SaaS 支付服务故障',
      description: '支付成功率下降、客户影响扩大时的跨职能事故处置演练。',
      config: {
        seedRevision: saasIncidentSeedRevision,
        packKey: saasIncidentPack.key,
        defaultDurationMinutes: saasIncidentPack.manifest.estimatedDurationMinutes,
        difficulty: 'intermediate',
        defaultSeed: 42,
        objectives: [
          {
            key: 'serviceAvailability',
            label: '恢复服务可用性',
            description: '控制故障扩散并验证支付链路恢复。',
          },
          {
            key: 'customerTrust',
            label: '维护客户信任',
            description: '及时同步影响范围与处置进度。',
          },
          {
            key: 'financialIntegrity',
            label: '保护财务完整性',
            description: '识别并降低重复扣费和收入损失风险。',
          },
        ],
        participants: saasParticipants,
      },
    },
    {
      key: 'critical-customer-escalation',
      name: '关键客户升级',
      description: '关键客户风险升级时的响应、沟通和修复协调演练。',
      config: {
        seedRevision: studioSeedRevision,
        packKey: 'customer-escalation',
        defaultDurationMinutes: 10,
        difficulty: 'beginner',
        defaultSeed: 17,
        objectives: [
          {
            key: 'customerRecovery',
            label: '稳定客户关系',
            description: '建立清晰的响应节奏并恢复客户信心。',
          },
          {
            key: 'executiveAlignment',
            label: '保持管理层对齐',
            description: '形成一致的风险判断与沟通口径。',
          },
        ],
        // 该场景包尚未实现，保持空配置，避免 seed 虚构无法运行的参与方。
        participants: [],
      },
    },
  ] as const;

  for (const scenarioInput of scenarios) {
    const scenario = await prisma.scenario.upsert({
      where: {
        organizationId_key: {
          organizationId: organization.id,
          key: scenarioInput.key,
        },
      },
      update: {
        name: scenarioInput.name,
        description: scenarioInput.description,
        status: 'published',
      },
      create: {
        organizationId: organization.id,
        key: scenarioInput.key,
        name: scenarioInput.name,
        description: scenarioInput.description,
        status: 'published',
      },
    });

    const existingVersions = await prisma.scenarioVersion.findMany({
      where: { scenarioId: scenario.id },
      select: { version: true, publishedAt: true, config: true },
    });
    const revision = readSeedRevision(scenarioInput.config);
    const nextVersion = nextSeedScenarioVersion(existingVersions, revision);

    if (nextVersion !== null) {
      // ScenarioVersion 是运行引用的不可变快照；seed 只追加，不更新历史 config 或发布时间。
      await prisma.scenarioVersion.create({
        data: {
          scenarioId: scenario.id,
          version: nextVersion,
          config: scenarioInput.config,
          publishedAt: new Date(),
        },
      });
    }
  }
}

function readSeedRevision(config: { readonly seedRevision: string }): string {
  return config.seedRevision;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
