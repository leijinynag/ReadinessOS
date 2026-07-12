import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SimulationKernel,
  type KernelContext,
  type RunCommand,
} from '@readinessos/simulation-kernel';
import {
  saasIncidentPack,
  saasIncidentParticipantIds,
  saasIncidentStateSchema,
} from '../src/index.js';

const ids = {
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befedf1',
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befedf2',
  actorId: '018f4c8b-9ae2-7a72-86bd-4f867befedf3',
};

function createContext(): KernelContext {
  let eventNumber = 0;

  return {
    recordedAt: '2026-07-12T00:00:00.000Z',
    nextEventId: () => {
      eventNumber += 1;
      return `00000000-0000-4000-8000-${String(eventNumber).padStart(12, '0')}`;
    },
  };
}

function command(
  sequence: number,
  expectedRunVersion: number,
  payload: RunCommand['payload'],
): RunCommand {
  return {
    commandId: `00000000-0000-4000-9000-${String(sequence).padStart(12, '0')}`,
    organizationId: ids.organizationId,
    runId: ids.runId,
    actor: {
      id: ids.actorId,
      type: 'user',
      organizationId: ids.organizationId,
    },
    expectedRunVersion,
    idempotencyKey: `incident:${sequence}`,
    issuedAt: '2026-07-12T00:00:00.000Z',
    payload,
  };
}

describe('SaaS incident pack', () => {
  it('declares a valid WorldState and framework-free deterministic pack', () => {
    expect(saasIncidentStateSchema.parse(saasIncidentPack.initialState({}))).toBeDefined();
    expect(saasIncidentPack.participants).toHaveLength(6);
    expect(saasIncidentPack.actions.map((action) => action.key)).toEqual(
      expect.arrayContaining([
        'declare-incident',
        'inspect-metrics',
        'disable-payment-writes',
        'start-rollback',
        'publish-status',
        'notify-customers',
        'verify-recovery',
        'close-incident',
      ]),
    );
  });

  it('does not depend on persistence, UI, or agent runtime packages', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const source = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
    const forbiddenDependencies = ['@prisma/client', 'next', 'react', 'eve'];

    for (const dependency of forbiddenDependencies) {
      expect(packageJson.dependencies?.[dependency]).toBeUndefined();
      expect(source).not.toContain(`'${dependency}'`);
      expect(source).not.toContain(`"${dependency}"`);
    }
  });

  it('runs the minimum payment incident without a database or LLM', () => {
    const kernel = new SimulationKernel(saasIncidentPack);
    const created = kernel.createRun(
      {
        organizationId: ids.organizationId,
        runId: ids.runId,
        seed: 20260712,
        simulatedAt: '2026-07-12T00:00:00.000Z',
      },
      createContext(),
    );
    let state = created.state;
    let sequence = 1;

    const execute = (payload: RunCommand['payload']) => {
      const result = kernel.execute(
        state,
        command(sequence, state.run.version, payload),
        createContext(),
      );
      sequence += 1;
      state = result.state;
      return result;
    };

    execute({ type: 'start-run' });
    expect(state.world.service.errorRate).toBe(0.47);
    execute({
      type: 'submit-action',
      actionType: 'declare-incident',
      participantId: saasIncidentParticipantIds.incidentCommander,
      parameters: {},
    });
    execute({
      type: 'submit-action',
      actionType: 'disable-payment-writes',
      participantId: saasIncidentParticipantIds.onCallEngineer,
      parameters: {},
    });
    const disableApproval = Object.keys(state.pendingApprovals)[0];
    execute({
      type: 'resolve-approval',
      approvalId: disableApproval ?? 'missing',
      decision: 'approved',
    });
    execute({
      type: 'submit-action',
      actionType: 'start-rollback',
      participantId: saasIncidentParticipantIds.onCallEngineer,
      parameters: {},
    });
    const rollbackApproval = Object.keys(state.pendingApprovals)[0];
    execute({
      type: 'resolve-approval',
      approvalId: rollbackApproval ?? 'missing',
      decision: 'approved',
    });
    execute({ type: 'advance-clock', minutes: 2 });
    execute({
      type: 'submit-action',
      actionType: 'publish-status',
      participantId: saasIncidentParticipantIds.customerSupportLead,
      parameters: {},
    });
    execute({
      type: 'submit-action',
      actionType: 'notify-customers',
      participantId: saasIncidentParticipantIds.customerSupportLead,
      parameters: {},
    });
    execute({
      type: 'submit-action',
      actionType: 'verify-recovery',
      participantId: saasIncidentParticipantIds.onCallEngineer,
      parameters: {},
    });
    const closed = execute({
      type: 'submit-action',
      actionType: 'close-incident',
      participantId: saasIncidentParticipantIds.incidentCommander,
      parameters: {},
    });

    expect(closed.status).toBe('accepted');
    expect(state.run.status).toBe('completed');
    expect(state.world.service.recovered).toBe(true);
    expect(kernel.evaluate(state).every((result) => result.score === 100)).toBe(true);
  });
});
