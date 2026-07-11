import { ApplicationError } from '@readinessos/domain-events';

export const organizationRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export type OrganizationAccess = {
  organizationId: string;
  role: OrganizationRole;
  userId: string;
};

export function assertOrganizationAccess(
  access: OrganizationAccess | null,
  organizationId: string,
  minimumRole: OrganizationRole = 'viewer',
): asserts access is OrganizationAccess {
  if (!access || access.organizationId !== organizationId) {
    throw new ApplicationError('FORBIDDEN', 'You cannot access this organization.');
  }

  const priority: Record<OrganizationRole, number> = {
    owner: 4,
    admin: 3,
    member: 2,
    viewer: 1,
  };

  if (priority[access.role] < priority[minimumRole]) {
    throw new ApplicationError('FORBIDDEN', 'Your organization role is insufficient.');
  }
}
