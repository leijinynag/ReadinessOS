import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import {
  SimulationKernel,
  all,
  createDeterministicRandom,
  elapsedMinutesGte,
  stateEquals,
  validateScenarioDefinition,
  type CreateRunInput,
  type KernelContext,
  type RunCommand,
  type ScenarioDefinition,
} from '../src/index.js';

type FixtureState = {
  clock: {
    elapsedMinutes: number;
    status: 'idle' | 'running' | 'paused' | 'completed';
  };
  service: {
    writesDisabled: boolean;
    inspectedCount: number;
    recovered: boolean;
  };
  flags: {
    armed: boolean;
  };
};

const ids = {
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befedd5',
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befedd6',
  commanderId: '018f4c8b-9ae2-7a72-86bd-4f867befedd7',
  capabilityMissingId: '018f4c8b-9ae2-7a72-86bd-4f867befedd8',
  permissionMissingId: '018f4c8b-9ae2-7a72-86bd-4f867befedd9',
  knowledgeMissingId: '018f4c8b-9ae2-7a72-86bd-4f867befedda',
  actorId: '018f4c8b-9ae2-7a72-86bd-4f867befeddb',
};

const input: CreateRunInput = {
  organizationId: ids.organizationId,
  runId: ids.runId,
  seed: 42,
  simulatedAt: '2026-07-12T00:00:00.000Z',
};

function createDefinition(): ScenarioDefinition<FixtureState> {
  return {
    key: 'kernel-test',
    stateSchema: z.object({
      clock: z.object({
        elapsedMinutes: z.number().int().nonnegative(),
        status: z.enum(['idle', 'running', 'paused', 'completed']),
      }),
      service: z.object({
        writesDisabled: z.boolean(),
        inspectedCount: z.number().int().nonnegative(),
        recovered: z.boolean(),
      }),
      flags: z.object({
        armed: z.boolean(),
      }),
    }),
    initialState: () => ({
      clock: { elapsedMinutes: 0, status: 'idle' },
      service: { writesDisabled: false, inspectedCount: 0, recovered: false },
      flags: { armed: false },
    }),
    participants: [
      {
        id: ids.commanderId,
        key: 'commander',
        displayName: 'Incident Commander',
        controller: 'human',
        capabilities: ['inspect', 'mitigate', 'restricted'],
        permissions: ['read:metrics', 'write:payments', 'read:private'],
        knowledgeScopes: ['metrics', 'incident', 'private'],
        objectives: ['restore-service'],
      },
      {
        id: ids.capabilityMissingId,
        key: 'capability-missing',
        displayName: 'Capability Missing',
        controller: 'human',
        capabilities: [],
        permissions: ['read:private'],
        knowledgeScopes: ['private'],
        objectives: [],
      },
      {
        id: ids.permissionMissingId,
        key: 'permission-missing',
        displayName: 'Permission Missing',
        controller: 'human',
        capabilities: ['restricted'],
        permissions: [],
        knowledgeScopes: ['private'],
        objectives: [],
      },
      {
        id: ids.knowledgeMissingId,
        key: 'knowledge-missing',
        displayName: 'Knowledge Missing',
        controller: 'human',
        capabilities: ['restricted'],
        permissions: ['read:private'],
        knowledgeScopes: [],
        objectives: [],
      },
    ],
    actions: [
      {
        key: 'inspect',
        label: 'Inspect metrics',
        requiredCapabilities: ['inspect'],
        requiredPermissions: ['read:metrics'],
        requiredKnowledgeScopes: ['metrics'],
        risk: 'low',
        approval: 'none',
        effects: [
          { kind: 'increment-state', path: ['service', 'inspectedCount'], amount: 1 },
          { kind: 'record-metric', metricKey: 'inspections', value: 1 },
        ],
      },
      {
        key: 'disable-writes',
        label: 'Disable payment writes',
        requiredCapabilities: ['mitigate'],
        requiredPermissions: ['write:payments'],
        requiredKnowledgeScopes: ['incident'],
        risk: 'high',
        approval: 'required',
        effects: [
          { kind: 'set-state', path: ['service', 'writesDisabled'], value: true },
          {
            kind: 'emit-signal',
            signalKey: 'writes-disabled',
            recipients: [ids.commanderId],
          },
        ],
      },
      {
        key: 'restricted',
        label: 'Read private evidence',
        requiredCapabilities: ['restricted'],
        requiredPermissions: ['read:private'],
        requiredKnowledgeScopes: ['private'],
        risk: 'low',
        approval: 'none',
        effects: [],
      },
      {
        key: 'arm-delay',
        label: 'Arm a delayed inject',
        risk: 'low',
        approval: 'none',
        effects: [
          { kind: 'set-state', path: ['flags', 'armed'], value: true },
          { kind: 'schedule-inject', injectKey: 'delayed-recovery', delayMinutes: 2 },
        ],
      },
    ],
    signals: [
      {
        key: 'writes-disabled',
        label: 'Payment writes disabled',
        requiredKnowledgeScopes: ['incident'],
      },
    ],
    injects: [
      {
        key: 'delayed-recovery',
        trigger: all(
          elapsedMinutesGte<FixtureState>(2),
          stateEquals<FixtureState>(['flags', 'armed'], true),
        ),
        effects: [{ kind: 'set-state', path: ['service', 'recovered'], value: true }],
      },
    ],
    evaluators: [
      {
        key: 'recovery',
        evaluate: ({ state }) => ({
          evaluatorKey: 'recovery',
          score: state.world.service.recovered ? 100 : 0,
          summary: state.world.service.recovered ? '服务已恢复。' : '服务尚未恢复。',
          evidenceEventTypes: ['action.executed', 'inject.triggered'],
        }),
      },
    ],
    runtimeBindings: {
      statusPath: ['clock', 'status'],
      elapsedMinutesPath: ['clock', 'elapsedMinutes'],
    },
  };
}

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
  idempotencyKey = `command:${sequence}`,
): RunCommand {
  return {
    commandId: `00000000-0000-4000-9000-${String(sequence).padStart(12, '0')}`,
    organizationId: ids.organizationId,
    runId: ids.runId,
    actor: {
      id: ids.actorId,
      type: 'user',
      organizationId: ids.organizationId,
      displayName: 'Test Operator',
    },
    expectedRunVersion,
    idempotencyKey,
    issuedAt: '2026-07-12T00:00:00.000Z',
    payload,
  };
}

function startRun(kernel: SimulationKernel<FixtureState>) {
  const created = kernel.createRun(input, createContext());
  const started = kernel.execute(
    created.state,
    command(1, created.state.run.version, { type: 'start-run' }, 'run:start'),
    createContext(),
  );
  return { created, started };
}

describe('simulation kernel', () => {
  it('executes the lifecycle and maintains contiguous event sequence', () => {
    const kernel = new SimulationKernel(createDefinition());
    const created = kernel.createRun(input, createContext());
    const started = kernel.execute(
      created.state,
      command(1, 0, { type: 'start-run' }),
      createContext(),
    );
    const paused = kernel.execute(
      started.state,
      command(2, 1, { type: 'pause-run', reason: 'review' }),
      createContext(),
    );
    const resumed = kernel.execute(
      paused.state,
      command(3, 2, { type: 'resume-run' }),
      createContext(),
    );
    const completed = kernel.execute(
      resumed.state,
      command(4, 3, { type: 'finish-run', reason: 'operator completed' }),
      createContext(),
    );

    const events = [
      ...created.events,
      ...started.events,
      ...paused.events,
      ...resumed.events,
      ...completed.events,
    ];
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(completed.state.run.status).toBe('completed');
    expect(completed.state.world.clock.status).toBe('completed');
  });

  it('deduplicates by command ID and idempotency key', () => {
    const kernel = new SimulationKernel(createDefinition());
    const created = kernel.createRun(input, createContext());
    const startedCommand = command(1, 0, { type: 'start-run' }, 'run:start');
    const started = kernel.execute(created.state, startedCommand, createContext());
    const duplicateById = kernel.execute(started.state, startedCommand, createContext());
    const duplicateByKey = kernel.execute(
      started.state,
      command(2, 0, { type: 'start-run' }, 'run:start'),
      createContext(),
    );

    expect(started.events[0]?.idempotencyKey).toBe('run:start');
    expect(duplicateById.status).toBe('duplicate');
    expect(duplicateByKey.status).toBe('duplicate');
    expect(duplicateByKey.events).toHaveLength(0);
  });

  it('requires approval before a high-risk action can execute', () => {
    const kernel = new SimulationKernel(createDefinition());
    const { started } = startRun(kernel);
    const proposed = kernel.execute(
      started.state,
      command(2, 1, {
        type: 'submit-action',
        actionType: 'disable-writes',
        participantId: ids.commanderId,
        parameters: {},
      }),
      createContext(),
    );
    const approvalId =
      proposed.state.pendingApprovals['00000000-0000-4000-9000-000000000002']?.approvalId;
    const denied = kernel.execute(
      proposed.state,
      command(3, 2, {
        type: 'resolve-approval',
        approvalId: approvalId ?? 'missing',
        decision: 'denied',
      }),
      createContext(),
    );

    expect(proposed.events.map((event) => event.type)).toEqual([
      'action.proposed',
      'action.approval_requested',
    ]);
    expect(proposed.events.some((event) => event.type === 'action.executed')).toBe(false);
    expect(denied.events.map((event) => event.type)).toEqual(['action.denied']);
    expect(denied.events.some((event) => event.type === 'action.executed')).toBe(false);
    expect(denied.state.world.service.writesDisabled).toBe(false);
  });

  it('rejects actions that lack capability, permission, or knowledge scope', () => {
    const kernel = new SimulationKernel(createDefinition());
    const { started } = startRun(kernel);
    const participantIds = [
      ids.capabilityMissingId,
      ids.permissionMissingId,
      ids.knowledgeMissingId,
    ];

    const results = participantIds.map((participantId, index) =>
      kernel.execute(
        started.state,
        command(index + 2, 1, {
          type: 'submit-action',
          actionType: 'restricted',
          participantId,
          parameters: {},
        }),
        createContext(),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(results.map((result) => result.rejection?.message)).toEqual([
      'Participant lacks required capabilities.',
      'Participant lacks required permissions.',
      'Participant lacks required knowledge scope.',
    ]);
    expect(results.every((result) => result.events[0]?.type === 'action.rejected')).toBe(true);
  });

  it('replays effects from a full history or a snapshot to the same state', () => {
    const kernel = new SimulationKernel(createDefinition());
    const created = kernel.createRun(input, createContext());
    const started = kernel.execute(
      created.state,
      command(1, 0, { type: 'start-run' }),
      createContext(),
    );
    const armed = kernel.execute(
      started.state,
      command(2, 1, {
        type: 'submit-action',
        actionType: 'arm-delay',
        participantId: ids.commanderId,
        parameters: {},
      }),
      createContext(),
    );
    const advanced = kernel.execute(
      armed.state,
      command(3, 2, { type: 'advance-clock', minutes: 2 }),
      createContext(),
    );
    const events = [...created.events, ...started.events, ...armed.events, ...advanced.events];

    const fullReplay = kernel.replay(kernel.initialize(input), events);
    const snapshotReplay = kernel.replay(started.state, [...armed.events, ...advanced.events]);

    expect(advanced.state.world.service.recovered).toBe(true);
    expect(fullReplay).toEqual(advanced.state);
    expect(snapshotReplay).toEqual(advanced.state);
    expect(kernel.evaluate(fullReplay)[0]?.score).toBe(100);
  });

  it('keeps identical seeded executions deterministic under property-based inputs', () => {
    const kernel = new SimulationKernel(createDefinition());

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_147_483_647 }),
        fc.integer({ min: 1, max: 20 }),
        (seed, minutes) => {
          const propertyInput = { ...input, seed };
          const firstCreated = kernel.createRun(propertyInput, createContext());
          const firstStarted = kernel.execute(
            firstCreated.state,
            command(1, 0, { type: 'start-run' }),
            createContext(),
          );
          const firstAdvanced = kernel.execute(
            firstStarted.state,
            command(2, 1, { type: 'advance-clock', minutes }),
            createContext(),
          );
          const firstReplay = kernel.replay(kernel.initialize(propertyInput), [
            ...firstCreated.events,
            ...firstStarted.events,
            ...firstAdvanced.events,
          ]);

          const secondCreated = kernel.createRun(propertyInput, createContext());
          const secondStarted = kernel.execute(
            secondCreated.state,
            command(1, 0, { type: 'start-run' }),
            createContext(),
          );
          const secondAdvanced = kernel.execute(
            secondStarted.state,
            command(2, 1, { type: 'advance-clock', minutes }),
            createContext(),
          );

          expect(secondAdvanced).toEqual(firstAdvanced);
          expect(firstReplay).toEqual(firstAdvanced.state);
        },
      ),
    );
  });

  it('uses an explicit deterministic random source', () => {
    const first = createDeterministicRandom(7);
    const second = createDeterministicRandom(7);

    expect([first.next(), first.integer(1, 10), first.next()]).toEqual([
      second.next(),
      second.integer(1, 10),
      second.next(),
    ]);
  });

  it('rejects zero-delay inject scheduling during scenario validation', () => {
    const definition = createDefinition();
    const result = validateScenarioDefinition({
      ...definition,
      actions: [
        ...definition.actions,
        {
          key: 'invalid-schedule',
          label: 'Invalid schedule',
          risk: 'low',
          approval: 'none',
          effects: [{ kind: 'schedule-inject', injectKey: 'delayed-recovery', delayMinutes: 0 }],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      '动作 invalid-schedule 的 schedule-inject 延迟必须大于 0，避免零延迟循环。',
    );
  });
});
