import { z } from 'zod';

export const eventSourceSchema = z.enum(['human', 'agent', 'system', 'integration']);
export type EventSource = z.infer<typeof eventSourceSchema>;

export const actorTypeSchema = z.enum(['user', 'agent', 'system']);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const actorRefSchema = z.object({
  id: z.string().min(1),
  type: actorTypeSchema,
  organizationId: z.string().min(1),
  displayName: z.string().min(1).optional(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export const domainEventSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  source: eventSourceSchema,
  participantId: z.string().uuid().optional(),
  simulatedAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  causationId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1),
  payload: z.unknown(),
});
export type DomainEvent<TPayload = unknown> = Omit<z.infer<typeof domainEventSchema>, 'payload'> & {
  payload: TPayload;
};

export const commandEnvelopeSchema = z.object({
  commandId: z.string().uuid(),
  organizationId: z.string().uuid(),
  runId: z.string().uuid(),
  actor: actorRefSchema,
  expectedRunVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  issuedAt: z.string().datetime(),
  payload: z.unknown(),
});
export type CommandEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof commandEnvelopeSchema>,
  'payload'
> & {
  payload: TPayload;
};

export const runEventTypes = [
  'run.created',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'clock.advanced',
  'signal.emitted',
  'signal.observed',
  'action.proposed',
  'action.rejected',
  'action.approval_requested',
  'action.approved',
  'action.denied',
  'action.executed',
  'state.changed',
  'inject.triggered',
  'participant.joined',
  'participant.status_changed',
  'decision.recorded',
  'checkpoint.created',
  'evaluation.completed',
  'remediation.created',
  'branch.created',
] as const;

export type RunEventType = (typeof runEventTypes)[number];

export const applicationErrorCodeSchema = z.enum([
  'RUN_VERSION_CONFLICT',
  'COMMAND_ALREADY_APPLIED',
  'ACTION_NOT_ALLOWED',
  'APPROVAL_REQUIRED',
  'APPROVAL_STALE',
  'RUN_TERMINAL',
  'BUDGET_EXCEEDED',
  'SEQUENCE_GAP',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
]);
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApplicationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.details = details;
  }
}
