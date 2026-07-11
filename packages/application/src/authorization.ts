import { ApplicationError } from '@readinessos/domain-events';
import type {
  AuthSession,
  AuthorizationService,
  OrganizationMembership,
  OrganizationRole,
} from './index';

const rolePriority: Record<OrganizationRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export class OrganizationAuthorizationService implements AuthorizationService {
  requireOrganizationAccess(
    session: AuthSession | null,
    organizationId: string,
    minimumRole: OrganizationRole = 'viewer',
  ): OrganizationMembership {
    if (!session) {
      throw new ApplicationError('UNAUTHENTICATED', 'Authentication is required.');
    }

    // 只以当前会话中已经加载的成员关系作授权判断，避免调用方绕过组织边界。
    const membership = session.memberships.find(
      (candidate) => candidate.organizationId === organizationId,
    );

    if (!membership || rolePriority[membership.role] < rolePriority[minimumRole]) {
      throw new ApplicationError('FORBIDDEN', 'Your organization role is insufficient.');
    }

    return membership;
  }
}
