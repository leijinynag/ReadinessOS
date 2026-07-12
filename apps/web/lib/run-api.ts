import { OrganizationAuthorizationService, type AuthSession } from '@readinessos/application';
import type { ActorRef } from '@readinessos/domain-events';
import { getAuthSession } from './auth-session';

const authorization = new OrganizationAuthorizationService();

export async function requireRunSession(
  organizationId: string,
  minimumRole: 'viewer' | 'member' = 'viewer',
): Promise<AuthSession> {
  const session = await getAuthSession();
  authorization.requireOrganizationAccess(session, organizationId, minimumRole);
  return session as AuthSession;
}

export function userActor(session: AuthSession, organizationId: string): ActorRef {
  return {
    id: session.userId,
    type: 'user',
    organizationId,
    displayName: session.email,
  };
}
