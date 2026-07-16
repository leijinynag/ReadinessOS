import { randomBytes } from 'node:crypto';
import type { Prisma } from '@readinessos/database';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { env } from './env';
import { hashPrivacySafeKey } from './release-policy';

const guestRateLimitScope = 'guest-demo-create';
const guestPrefix = 'guest';

export type GuestDemoSource = {
  ip: string | undefined;
  userAgent: string | undefined;
};

export type CreatedGuestDemo = {
  token: string;
  expiresAt: Date;
};

/**
 * 创建访客时复制只读的已发布场景版本到独立组织。该组织没有共享 Member，
 * 因而后续页面和 API 仍可沿用既有组织授权，而不会串租户。
 */
export async function createGuestDemo(source: GuestDemoSource): Promise<CreatedGuestDemo> {
  if (env.GUEST_DEMO_ENABLED !== 'true') {
    throw new ApplicationError('FORBIDDEN', 'Guest demo access is disabled.');
  }

  await consumeGuestCreationRateLimit(source);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.GUEST_DEMO_RETENTION_HOURS * 60 * 60_000);
  const token = randomBytes(32).toString('base64url');
  const uniqueSuffix = randomBytes(10).toString('hex');
  const email = `${guestPrefix}-${uniqueSuffix}@guest.readinessos.local`;
  const organizationSlug = `${guestPrefix}-${uniqueSuffix}`;

  await prisma.$transaction(async (tx) => {
    const sourceVersions = await tx.scenarioVersion.findMany({
      where: {
        publishedAt: { not: null },
        scenario: {
          organization: { slug: 'readiness-demo' },
          status: 'published',
        },
      },
      orderBy: [{ scenarioId: 'asc' }, { version: 'desc' }],
      select: {
        version: true,
        config: true,
        scenario: { select: { key: true, name: true, description: true } },
      },
    });
    const latestByKey = new Map<string, (typeof sourceVersions)[number]>();
    for (const version of sourceVersions) {
      if (!latestByKey.has(version.scenario.key)) latestByKey.set(version.scenario.key, version);
    }
    if (latestByKey.size === 0) {
      throw new ApplicationError('NOT_FOUND', 'Published demo scenarios are not configured.');
    }

    const organization = await tx.organization.create({
      data: { slug: organizationSlug, name: 'ReadinessOS Guest Demo' },
    });
    const user = await tx.user.create({
      data: {
        email,
        name: 'Guest Operator',
        isGuest: true,
        guestExpiresAt: expiresAt,
        guestTokenHash: hashGuestToken(token),
      },
    });
    await tx.member.create({
      data: { organizationId: organization.id, userId: user.id, role: 'owner' },
    });

    for (const source of latestByKey.values()) {
      const scenario = await tx.scenario.create({
        data: {
          organizationId: organization.id,
          key: source.scenario.key,
          name: source.scenario.name,
          description: source.scenario.description,
          status: 'published',
        },
      });
      await tx.scenarioVersion.create({
        data: {
          scenarioId: scenario.id,
          version: 1,
          config: source.config as Prisma.InputJsonValue,
          publishedAt: now,
        },
      });
    }
  });

  return { token, expiresAt };
}

export function hashGuestToken(token: string): string {
  return hashPrivacySafeKey(`guest-token:${token}`);
}

async function consumeGuestCreationRateLimit(source: GuestDemoSource): Promise<void> {
  const keyHash = hashPrivacySafeKey(
    `guest-origin:${source.ip ?? 'unknown-ip'}:${source.userAgent ?? 'unknown-agent'}`,
  );
  const windowStartsAt = startOfUtcDay(new Date());
  const row = await prisma.requestRateLimit.upsert({
    where: {
      scope_keyHash_windowStartsAt: { scope: guestRateLimitScope, keyHash, windowStartsAt },
    },
    create: { scope: guestRateLimitScope, keyHash, windowStartsAt, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  if (row.count > env.GUEST_DEMO_MAX_CREATIONS_PER_DAY) {
    throw new ApplicationError(
      'BUDGET_EXCEEDED',
      'Guest demo creation limit has been reached for this device today.',
    );
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
