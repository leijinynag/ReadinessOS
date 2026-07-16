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
  customerEscalationPack,
  customerEscalationParticipantIds,
  customerEscalationStateSchema,
  type CustomerEscalationState,
} from '../src/index.js';

const ids = {
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef11',
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befef12',
  actorId: '018f4c8b-9ae2-7a72-86bd-4f867befef13',
};

function createContext(): KernelContext {
  let eventNumber = 0;

  return {
    recordedAt: '2026-07-16T00:00:00.000Z',
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
    idempotencyKey: `customer-escalation:${sequence}`,
    issuedAt: '2026-07-16T00:00:00.000Z',
    payload,
  };
}

type ScenarioExecution = {
  readonly kernel: SimulationKernel<CustomerEscalationState>;
  state: SimulationState<CustomerEscalationState>;
  sequence: number;
  readonly events: { readonly sequence: number; readonly type: string }[];
  execute(payload: RunCommand['payload']): KernelResult<CustomerEscalationState>;
};

function createExecution(seed: number): ScenarioExecution {
  const kernel = new SimulationKernel(customerEscalationPack);
  const created = kernel.createRun(
    {
      organizationId: ids.organizationId,
      runId: ids.runId,
      seed,
      simulatedAt: '2026-07-16T00:00:00.000Z',
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

function approvePendingAction(execution: ScenarioExecution): KernelResult<CustomerEscalationState> {
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
 * 先推进未响应的虚拟时间，以覆盖客户信心和续约风险的升级 Inject；随后通过相同
 * Kernel Command 闭合场景。这里不依赖数据库、浏览器或 LLM。
 */
function runHappyPath(seed: number): ScenarioExecution {
  const execution = createExecution(seed);
  const act = (
    actionType: string,
    participantId: (typeof customerEscalationParticipantIds)[keyof typeof customerEscalationParticipantIds],
  ) =>
    execution.execute({
      type: 'submit-action',
      actionType,
      participantId,
      parameters: {},
    });

  execution.execute({ type: 'start-run' });
  act('acknowledge-escalation', customerEscalationParticipantIds.accountExecutive);
  act('investigate-root-cause', customerEscalationParticipantIds.engineeringLead);
  execution.execute({ type: 'advance-clock', minutes: 4 });
  act('brief-executive-sponsor', customerEscalationParticipantIds.accountExecutive);
  act('send-customer-update', customerEscalationParticipantIds.customerSuccessLead);
  act('share-recovery-plan', customerEscalationParticipantIds.customerSuccessLead);
  act('schedule-remediation', customerEscalationParticipantIds.engineeringLead);
  approvePendingAction(execution);
  execution.execute({ type: 'advance-clock', minutes: 2 });
  act('validate-customer-recovery', customerEscalationParticipantIds.customerSuccessLead);
  act('close-escalation', customerEscalationParticipantIds.accountExecutive);

  return execution;
}

describe('Customer escalation pack', () => {
  it('declares a complete, framework-free deterministic scenario pack', () => {
    expect(
      customerEscalationStateSchema.parse(customerEscalationPack.initialState({})),
    ).toBeDefined();
    expect(customerEscalationPack.participants).toHaveLength(5);
    expect(customerEscalationPack.actions).toHaveLength(8);
    expect(customerEscalationPack.injects).toHaveLength(6);
    expect(customerEscalationPack.evaluators).toHaveLength(5);
    expect(customerEscalationPack.actions.map((action) => action.key)).toEqual(
      expect.arrayContaining([
        'acknowledge-escalation',
        'investigate-root-cause',
        'brief-executive-sponsor',
        'send-customer-update',
        'share-recovery-plan',
        'schedule-remediation',
        'validate-customer-recovery',
        'close-escalation',
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

  it('runs the complete customer recovery without a database or LLM', () => {
    const execution = runHappyPath(20_260_716);
    const evaluations = execution.kernel.evaluate(execution.state);

    expect(execution.state.run.status).toBe('completed');
    expect(execution.state.world.account.riskLevel).toBe('recovered');
    expect(execution.state.world.account.customerConfidence).toBe(91);
    expect(execution.state.world.case.remediationCompleted).toBe(true);
    expect(execution.state.world.case.customerValidated).toBe(true);
    expect(execution.state.triggeredInjectKeys).toEqual(
      expect.arrayContaining([
        'customer-escalation-opened',
        'root-cause-confirmed',
        'executive-risk-alert',
        'customer-confidence-drop',
        'renewal-risk-escalation',
        'remediation-complete',
      ]),
    );
    expect(evaluations.every((result) => result.score === 100)).toBe(true);
    expect(evaluations.every((result) => result.evidenceEventTypes.length > 0)).toBe(true);
  });

  it('rejects overreach and keeps production remediation inert until approval', () => {
    const execution = createExecution(42);
    execution.execute({ type: 'start-run' });
    execution.execute({
      type: 'submit-action',
      actionType: 'acknowledge-escalation',
      participantId: customerEscalationParticipantIds.accountExecutive,
      parameters: {},
    });
    execution.execute({
      type: 'submit-action',
      actionType: 'investigate-root-cause',
      participantId: customerEscalationParticipantIds.engineeringLead,
      parameters: {},
    });
    execution.execute({
      type: 'submit-action',
      actionType: 'brief-executive-sponsor',
      participantId: customerEscalationParticipantIds.accountExecutive,
      parameters: {},
    });
    execution.execute({
      type: 'submit-action',
      actionType: 'send-customer-update',
      participantId: customerEscalationParticipantIds.customerSuccessLead,
      parameters: {},
    });
    execution.execute({
      type: 'submit-action',
      actionType: 'share-recovery-plan',
      participantId: customerEscalationParticipantIds.customerSuccessLead,
      parameters: {},
    });

    const unauthorized = execution.execute({
      type: 'submit-action',
      actionType: 'schedule-remediation',
      participantId: customerEscalationParticipantIds.customerSuccessLead,
      parameters: {},
    });
    expect(unauthorized.status).toBe('rejected');
    expect(unauthorized.rejection?.message).toBe('Participant lacks required capabilities.');

    const proposed = execution.execute({
      type: 'submit-action',
      actionType: 'schedule-remediation',
      participantId: customerEscalationParticipantIds.engineeringLead,
      parameters: {},
    });
    expect(proposed.status).toBe('accepted');
    expect(proposed.events.map((event) => event.type)).toEqual([
      'action.proposed',
      'action.approval_requested',
    ]);
    expect(execution.state.world.case.remediationScheduled).toBe(false);

    const denied = execution.execute({
      type: 'resolve-approval',
      approvalId: Object.keys(execution.state.pendingApprovals)[0] ?? 'missing',
      decision: 'denied',
    });
    expect(denied.events.map((event) => event.type)).toEqual(['action.denied']);
    expect(execution.state.world.case.remediationScheduled).toBe(false);
  });

  it('passes 20 fixed seeds with valid state, contiguous events, and evidence-ready scores', () => {
    const seeds = Array.from({ length: 20 }, (_, index) => 20_000 + index);
    const results = seeds.map((seed) => runHappyPath(seed));

    for (const execution of results) {
      expect(execution.state.run.status).toBe('completed');
      expect(customerEscalationStateSchema.safeParse(execution.state.world).success).toBe(true);
      expect(execution.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: execution.events.length }, (_, index) => index + 1),
      );

      const evaluations = execution.kernel.evaluate(execution.state);
      expect(evaluations).toHaveLength(5);
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
