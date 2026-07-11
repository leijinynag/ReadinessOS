import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const demoEmail = process.env.AUTH_DEMO_EMAIL ?? 'demo@readinessos.local';

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
        packKey: 'saas-incident',
        defaultDurationMinutes: 15,
        capabilities: ['incident-response', 'customer-communications'],
      },
    },
    {
      key: 'critical-customer-escalation',
      name: '关键客户升级',
      description: '关键客户风险升级时的响应、沟通和修复协调演练。',
      config: {
        packKey: 'customer-escalation',
        defaultDurationMinutes: 10,
        capabilities: ['executive-communication', 'account-recovery'],
      },
    },
  ];

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

    await prisma.scenarioVersion.upsert({
      where: {
        scenarioId_version: {
          scenarioId: scenario.id,
          version: 1,
        },
      },
      update: {
        config: scenarioInput.config,
        publishedAt: new Date(),
      },
      create: {
        scenarioId: scenario.id,
        version: 1,
        config: scenarioInput.config,
        publishedAt: new Date(),
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
