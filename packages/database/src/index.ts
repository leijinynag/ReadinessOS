export type { Prisma, PrismaClient } from '@prisma/client';
export { prisma } from './prisma';
export {
  assertOrganizationAccess,
  type OrganizationAccess,
  type OrganizationRole,
} from './authorization';
