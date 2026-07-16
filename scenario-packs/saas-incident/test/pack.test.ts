import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SimulationKernel,
  type KernelContext,
  type KernelResult,
  type RunCommand,
  type SimulationState,
} from '@readinessos/simulation-kernel';
import {
  saasIncidentPack,
  saasIncidentParticipantIds,
  saasIncidentStateSchema,
  type SaasIncidentState,
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

type ScenarioExecution = {
  readonly kernel: SimulationKernel<SaasIncidentState>;
  state: SimulationState<SaasIncidentState>;
  sequence: number;
  readonly events: { readonly sequence: number; readonly type: string }[];
  execute(payload: RunCommand['payload']): KernelResult<SaasIncidentState>;
};

function createExecution(seed: number): ScenarioExecution {
  const kernel = new SimulationKernel(saasIncidentPack);
  const created = kernel.createRun(
    {
      organizationId: ids.organizationId,
      runId: ids.runId,
      seed,
      simulatedAt: '2026-07-12T00:00:00.000Z',
    },
    createContext(),
  );
  const execution: ScenarioExecution = {
    kernel,
    state: created.state,
    sequence: 1,
    events: [...created.events],
    execute(payload) {
      const result = kernel.execute(
        execution.state,
        command(execution.sequence, execution.state.run.version, payload),
        createContext(),
      );
      execution.sequence += 1;
      execution.state = result.state;
      execution.events.push(...result.events);
      return result;
    },
  };
  return execution;
}

function approvePendingAction(execution: ScenarioExecution): KernelResult<SaasIncidentState> {
  const approvalId = Object.keys(execution.state.pendingApprovals)[0];
  if (!approvalId) {
    throw new Error('Expected a pending approval.');
  }
  return execution.execute({
    type: 'resolve-approval',
    approvalId,
    decision: 'approved',
  });
}

/**
 * 使用固定命令序列驱动完整闭环。场景本身不读取随机数，但每轮仍使用独立 seed，
 * 以确保运行元数据与事件序列在批量回归时持续满足 Kernel 的确定性约束。
 */
function runHappyPath(seed: number): ScenarioExecution {
  const execution = createExecution(seed);
  const act = (
    actionType: string,
    participantId: (typeof saasIncidentParticipantIds)[keyof typeof saasIncidentParticipantIds],
  ) =>
    execution.execute({
      type: 'submit-action',
      actionType,
      participantId,
      parameters: {},
    });

  execution.execute({ type: 'start-run' });
  act('inspect-metrics', saasIncidentParticipantIds.onCallEngineer);
  act('declare-incident', saasIncidentParticipantIds.incidentCommander);
  act('freeze-payment-retries', saasIncidentParticipantIds.onCallEngineer);
  approvePendingAction(execution);
  act('disable-payment-writes', saasIncidentParticipantIds.onCallEngineer);
  approvePendingAction(execution);
  act('contact-provider', saasIncidentParticipantIds.onCallEngineer);
  act('publish-status', saasIncidentParticipantIds.customerSupportLead);
  act('brief-executives', saasIncidentParticipantIds.incidentCommander);
  execution.execute({ type: 'advance-clock', minutes: 5 });
  act('notify-customers', saasIncidentParticipantIds.customerSupportLead);
  act('start-duplicate-charge-reconciliation', saasIncidentParticipantIds.customerSupportLead);
  act('start-rollback', saasIncidentParticipantIds.onCallEngineer);
  approvePendingAction(execution);
  execution.execute({ type: 'advance-clock', minutes: 2 });
  act('verify-recovery', saasIncidentParticipantIds.onCallEngineer);
  act('close-incident', saasIncidentParticipantIds.incidentCommander);

  return execution;
}

describe('SaaS incident pack', () => {
  it('declares a complete, framework-free deterministic scenario pack', () => {
    expect(saasIncidentStateSchema.parse(saasIncidentPack.initialState({}))).toBeDefined();
    expect(saasIncidentPack.participants).toHaveLength(6);
    expect(saasIncidentPack.actions).toHaveLength(12);
    expect(saasIncidentPack.injects).toHaveLength(10);
    expect(saasIncidentPack.evaluators).toHaveLength(6);
    expect(saasIncidentPack.actions.map((action) => action.key)).toEqual(
      expect.arrayContaining([
        'declare-incident',
        'freeze-payment-retries',
        'disable-payment-writes',
        'start-rollback',
        'contact-provider',
        'publish-status',
        'notify-customers',
        'brief-executives',
        'start-duplicate-charge-reconciliation',
        'verify-recovery',
        'close-incident',
      ]),
    );

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

  it('runs the complete payment incident without a database or LLM', () => {
    const execution = runHappyPath(20_260_712);
    const evaluations = execution.kernel.evaluate(execution.state);

    expect(execution.state.run.status).toBe('completed');
    expect(execution.state.world.service.recovered).toBe(true);
    expect(execution.state.world.response.recoveryVerified).toBe(true);
    expect(execution.state.world.response.reconciliationCompleted).toBe(true);
    expect(execution.state.world.impact.duplicateChargesDetected).toBe(true);
    expect(execution.state.triggeredInjectKeys).toEqual(
      expect.arrayContaining([
        'payment-service-outage',
        'monitoring-confirmation',
        'support-queue-spike',
        'duplicate-charge-escalation',
        'provider-status-update',
        'recovery-complete',
        'reconciliation-complete',
      ]),
    );
    expect(evaluations.every((result) => result.score === 100)).toBe(true);
    expect(evaluations.every((result) => result.evidenceEventTypes.length > 0)).toBe(true);
  });

  it('rejects overreach and keeps high-risk actions inert until approval', () => {
    const execution = createExecution(42);
    execution.execute({ type: 'start-run' });
    execution.execute({
      type: 'submit-action',
      actionType: 'declare-incident',
      participantId: saasIncidentParticipantIds.incidentCommander,
      parameters: {},
    });

    const unauthorized = execution.execute({
      type: 'submit-action',
      actionType: 'disable-payment-writes',
      participantId: saasIncidentParticipantIds.customerSupportLead,
      parameters: {},
    });
    expect(unauthorized.status).toBe('rejected');
    expect(unauthorized.rejection?.message).toBe('Participant lacks required capabilities.');

    const proposed = execution.execute({
      type: 'submit-action',
      actionType: 'disable-payment-writes',
      participantId: saasIncidentParticipantIds.onCallEngineer,
      parameters: {},
    });
    expect(proposed.status).toBe('accepted');
    expect(proposed.events.map((event) => event.type)).toEqual([
      'action.proposed',
      'action.approval_requested',
    ]);
    expect(execution.state.world.service.writesDisabled).toBe(false);

    const denied = execution.execute({
      type: 'resolve-approval',
      approvalId: Object.keys(execution.state.pendingApprovals)[0] ?? 'missing',
      decision: 'denied',
    });
    expect(denied.events.map((event) => event.type)).toEqual(['action.denied']);
    expect(execution.state.world.service.writesDisabled).toBe(false);
  });

  it('passes 20 fixed seeds with valid state, contiguous events, and evidence-ready scores', () => {
    const seeds = Array.from({ length: 20 }, (_, index) => 10_000 + index);
    const results = seeds.map((seed) => runHappyPath(seed));

    for (const execution of results) {
      expect(execution.state.run.status).toBe('completed');
      expect(saasIncidentStateSchema.safeParse(execution.state.world).success).toBe(true);
      expect(execution.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: execution.events.length }, (_, index) => index + 1),
      );

      const evaluations = execution.kernel.evaluate(execution.state);
      expect(evaluations).toHaveLength(6);
      expect(evaluations.every((evaluation) => evaluation.score === 100)).toBe(true);
      expect(
        evaluations.every(
          (evaluation) =>
            evaluation.evidenceEventTypes.length > 0 &&
            evaluation.evidenceEventTypes.every((type) =>
              execution.events.some((event) => event.type === type),
            ),
        ),
      ).toBe(true);
    }
  });
});
