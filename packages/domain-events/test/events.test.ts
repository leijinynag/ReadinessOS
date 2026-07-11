import { describe, expect, it } from 'vitest';
import { ApplicationError, commandEnvelopeSchema, domainEventSchema } from '../src/index.js';

const ids = {
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befedd5',
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befedd6',
  commandId: '018f4c8b-9ae2-7a72-86bd-4f867befedd7',
  eventId: '018f4c8b-9ae2-7a72-86bd-4f867befedd8',
};

describe('domain event protocol', () => {
  it('accepts a complete domain event envelope', () => {
    const event = domainEventSchema.parse({
      id: ids.eventId,
      organizationId: ids.organizationId,
      runId: ids.runId,
      sequence: 1,
      type: 'run.created',
      version: 1,
      source: 'system',
      simulatedAt: '2026-07-11T00:00:00.000Z',
      recordedAt: '2026-07-11T00:00:00.000Z',
      idempotencyKey: 'create:run',
      payload: { seed: 42 },
    });

    expect(event.sequence).toBe(1);
  });

  it('rejects a command without a valid optimistic version', () => {
    const result = commandEnvelopeSchema.safeParse({
      commandId: ids.commandId,
      organizationId: ids.organizationId,
      runId: ids.runId,
      actor: {
        id: ids.organizationId,
        type: 'user',
        organizationId: ids.organizationId,
      },
      expectedRunVersion: -1,
      idempotencyKey: 'run:start',
      issuedAt: '2026-07-11T00:00:00.000Z',
      payload: {},
    });

    expect(result.success).toBe(false);
  });

  it('retains a typed application error code', () => {
    const error = new ApplicationError('RUN_VERSION_CONFLICT', 'Run changed.');

    expect(error.code).toBe('RUN_VERSION_CONFLICT');
  });
});
