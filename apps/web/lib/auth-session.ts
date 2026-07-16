import type { AuthSession, OrganizationRole } from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { auth } from '@/auth';

export async function getAuthSession(): Promise<AuthSession | null> {
  const frameworkSession = await auth();
  const userId = frameworkSession?.user?.id;
  const email = frameworkSession?.user?.email;

  if (!userId || !email) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isGuest: true,
      guestExpiresAt: true,
      memberships: {
        select: {
          organizationId: true,
          role: true,
        },
      },
    },
  });
  if (!user || (user.isGuest && (!user.guestExpiresAt || user.guestExpiresAt <= new Date()))) {
    return null;
  }

  // NextAuth 的 Session 仅是框架会话；这里将它转换为业务层稳定的 AuthSession。
  return {
    userId,
    email,
    isGuest: user.isGuest,
    guestExpiresAt: user.guestExpiresAt?.toISOString(),
    memberships: user.memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role as OrganizationRole,
    })),
  };
}

/**
 * MVP 的登录身份只属于一个工作区。该函数将「当前组织」集中收敛，后续接入
 * 多组织切换时只需替换这里的选择策略，页面和路由不用再次硬编码 demo slug。
 */
export function getPrimaryOrganizationId(session: AuthSession): string {
  const organizationId = session.memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('The authenticated user has no organization membership.');
  }
  return organizationId;
}
