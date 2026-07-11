import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@readinessos/domain-events';
import { assertOrganizationAccess } from '../src/authorization.js';

describe('organization authorization', () => {
  it('accepts a member accessing their own organization', () => {
    expect(() =>
      assertOrganizationAccess(
        {
          organizationId: 'organization-1',
          role: 'member',
          userId: 'user-1',
        },
        'organization-1',
        'viewer',
      ),
    ).not.toThrow();
  });

  it('rejects cross-organization access', () => {
    expect(() =>
      assertOrganizationAccess(
        {
          organizationId: 'organization-1',
          role: 'owner',
          userId: 'user-1',
        },
        'organization-2',
      ),
    ).toThrow(ApplicationError);
  });
});
