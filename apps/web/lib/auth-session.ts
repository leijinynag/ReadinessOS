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

  const memberships = await prisma.member.findMany({
    where: {
      userId,
    },
    select: {
      organizationId: true,
      role: true,
    },
  });

  // NextAuth 的 Session 仅是框架会话；这里将它转换为业务层稳定的 AuthSession。
  return {
    userId,
    email,
    memberships: memberships.map((membership) => ({
      organizationId: membership.organizationId,
      role: membership.role as OrganizationRole,
    })),
  };
}
