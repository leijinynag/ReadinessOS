export { AgentObservationService } from './agent-observation';
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
  isGuest: boolean;
  guestExpiresAt: string | undefined;
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
  proposedActionValidationContextSchema,
  createProposedActionValidationContext,
  validateProposedAction,
  validateProposedActionContext,
  type AgentHandle,
  type AgentInputRequest,
  type AgentInputResponse,
  type AgentObservationIntent,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentTurnResult,
  type Observation,
  type ProposedAction,
  type ProposedActionValidationContext,
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
  type ApprovalSummary,
  type ReplaySummary,
  type ReviewSummary,
  type CommandExecution,
  type CreateBranchRequest,
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
  specializeScenarioPack,
} from './runtime';
