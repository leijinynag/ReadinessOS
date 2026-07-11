export type ApplicationBoundary = 'command' | 'query' | 'runtime';

export const organizationRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export type OrganizationMembership = {
  organizationId: string;
  role: OrganizationRole;
};

export type AuthSession = {
  userId: string;
  email: string;
  memberships: OrganizationMembership[];
};

export interface AuthorizationService {
  requireOrganizationAccess(
    session: AuthSession | null,
    organizationId: string,
    minimumRole?: OrganizationRole,
  ): OrganizationMembership;
}

export { OrganizationAuthorizationService } from './authorization';
