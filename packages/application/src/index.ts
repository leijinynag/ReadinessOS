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
export {
  ManualRunScheduler,
  observationSchema,
  proposedActionSchema,
  type AgentHandle,
  type AgentRuntime,
  type Observation,
  type ProposedAction,
  type RunScheduler,
} from './agent-runtime';
export {
  InMemoryScenarioPackRegistry,
  PrismaRunRepository,
  RunApplicationService,
  RunEventHub,
  RuntimeOutboxPublisher,
  streamEnvelopeSchema,
  type ClaimedOutboxMessage,
  type CommandExecution,
  type CreateRunRequest,
  type OutboxMessageHandler,
  type RunScheduleClaimResult,
  type RunScheduleLeaseClaim,
  type RunSummary,
  type ScenarioPackRegistry,
  type ScheduledTick,
  type SchedulerInstruction,
  type StreamEnvelope,
  createScheduledTickIdempotencyKey,
} from './runtime';
