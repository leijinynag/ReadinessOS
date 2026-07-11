import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';
import type { AuthSession } from '../src/index.js';
import { OrganizationAuthorizationService } from '../src/authorization.js';

const authorizationService = new OrganizationAuthorizationService();

const session: AuthSession = {
  userId: 'user-1',
  email: 'operator@example.com',
  memberships: [
    {
      organizationId: 'organization-1',
      role: 'member',
    },
  ],
};

describe('OrganizationAuthorizationService', () => {
  it('allows a member to access its organization', () => {
    expect(() =>
      authorizationService.requireOrganizationAccess(session, 'organization-1', 'viewer'),
    ).not.toThrow();
  });

  it('rejects an organization that is absent from the session', () => {
    expect(() => authorizationService.requireOrganizationAccess(session, 'organization-2')).toThrow(
      ApplicationError,
    );
  });
});
