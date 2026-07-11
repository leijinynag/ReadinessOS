import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma.js';

const organizationIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  // User 与 Organization 没有级联关系，测试完成后需分别清理以保持本地数据库可重复使用。
  await prisma.organization.deleteMany({
    where: {
      id: {
        in: organizationIds.splice(0),
      },
    },
  });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: userIds.splice(0),
      },
    },
  });
});

describe('database constraints', () => {
  it('enforces one membership per user and organization', async () => {
    const suffix = randomUUID();
    const organization = await prisma.organization.create({
      data: {
        slug: `constraint-${suffix}`,
        name: 'Constraint test organization',
      },
    });
    organizationIds.push(organization.id);

    const user = await prisma.user.create({
      data: {
        email: `constraint-${suffix}@example.com`,
      },
    });
    userIds.push(user.id);

    await prisma.member.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: 'member',
      },
    });

    // 该约束是组织隔离的最后防线，不能只依赖应用层调用约定。
    await expect(
      prisma.member.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: 'member',
        },
      }),
    ).rejects.toMatchObject({
      code: 'P2002',
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });
});
