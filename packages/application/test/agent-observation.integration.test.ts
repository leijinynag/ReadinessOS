import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
import type { ScenarioPack } from '@readinessos/scenario-sdk';
import { SimulationKernel, stateEquals } from '@readinessos/simulation-kernel';
import { z } from 'zod';
import { AgentObservationService } from '../src/index.js';

const organizationIds: string[] = [];
afterEach(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds.splice(0) } } });
});
afterAll(async () => prisma.$disconnect());

describe('AgentObservationService', () => {
  it('按 recipient 和 knowledge scope 隔离两个参与方', async () => {
    const fixture = await createFixture();
    const service = new AgentObservationService(prisma);

    const [first, second] = await Promise.all([
      service.build({
        runId: fixture.runId,
        organizationId: fixture.organizationId,
        participantId: fixture.firstRowId,
        pack: observationPack,
      }),
      service.build({
        runId: fixture.runId,
        organizationId: fixture.organizationId,
        participantId: fixture.secondRowId,
        pack: observationPack,
      }),
    ]);

    expect(first.visibleState).toMatchObject({ privateMarker: 'first' });
    expect(first.visibleSignals).toEqual([expect.objectContaining({ signalKey: 'metrics-only' })]);
    expect(first.recentEvents.map((event) => event.type)).not.toContain('state.changed');
    expect(first.recentEvents.map((event) => event.type)).not.toContain('participant.second');

    expect(second.visibleState).toMatchObject({ privateMarker: 'second' });
    expect(second.visibleSignals).toEqual([
      expect.objectContaining({ signalKey: 'customer-only' }),
    ]);
    expect(second.recentEvents.map((event) => event.type)).not.toContain('participant.first');
  });

  it('只暴露同时满足建议授权与 Kernel 前置条件的动作', async () => {
    const fixture = await createFixture();
    const service = new AgentObservationService(prisma);

    const beforeDeclaration = await service.build({
      runId: fixture.runId,
      organizationId: fixture.organizationId,
      participantId: fixture.firstRowId,
      pack: observationPack,
    });
    expect(beforeDeclaration.availableActions.map((action) => action.type)).toEqual(['observe']);

    await updateFixtureState(fixture.runId, true);
    const afterDeclaration = await service.build({
      runId: fixture.runId,
      organizationId: fixture.organizationId,
      participantId: fixture.firstRowId,
      pack: observationPack,
    });
    expect(afterDeclaration.availableActions.map((action) => action.type)).toEqual([
      'observe',
      'freeze-retries',
    ]);
  });
});

const kernelParticipantIds = {
  first: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  second: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
} as const;

const observationStateSchema = z.object({
  response: z.object({
    incidentDeclared: z.boolean(),
  }),
});
type ObservationState = z.infer<typeof observationStateSchema>;

const observationPack: ScenarioPack<ObservationState> = {
  key: 'observation-test',
  manifest: {
    key: 'observation-test',
    name: 'Observation test',
    description: 'Agent Observation 集成测试场景。',
    version: 1,
    estimatedDurationMinutes: 1,
  },
  stateSchema: observationStateSchema,
  initialState: () => ({ response: { incidentDeclared: false } }),
  agentPolicy: {
    advisors: [
      {
        advisorParticipantKey: 'first',
        triggerEventTypes: ['run.started'],
        recommendationPermissions: [
          { targetParticipantKey: 'first', actionType: 'observe' },
          { targetParticipantKey: 'first', actionType: 'freeze-retries' },
        ],
      },
      {
        advisorParticipantKey: 'second',
        triggerEventTypes: ['run.started'],
        recommendationPermissions: [{ targetParticipantKey: 'second', actionType: 'observe' }],
      },
    ],
  },
  participants: [
    {
      id: kernelParticipantIds.first,
      key: 'first',
      displayName: 'First',
      controller: 'agent',
      capabilities: ['observe', 'freeze-retries'],
      permissions: ['read:metrics', 'write:retries'],
      knowledgeScopes: ['metrics'],
      objectives: [],
    },
    {
      id: kernelParticipantIds.second,
      key: 'second',
      displayName: 'Second',
      controller: 'agent',
      capabilities: ['observe'],
      permissions: ['read:metrics'],
      knowledgeScopes: ['customer'],
      objectives: [],
    },
  ],
  actions: [
    {
      key: 'observe',
      label: 'Observe',
      requiredCapabilities: ['observe'],
      requiredPermissions: ['read:metrics'],
      risk: 'low',
      approval: 'none',
      effects: [],
    },
    {
      key: 'freeze-retries',
      label: 'Freeze retries',
      requiredCapabilities: ['freeze-retries'],
      requiredPermissions: ['write:retries'],
      risk: 'high',
      approval: 'required',
      precondition: stateEquals<ObservationState>(['response', 'incidentDeclared'], true),
      effects: [],
    },
  ],
  signals: [],
  injects: [],
  evaluators: [],
  uiContributions: [],
};

async function createFixture() {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: { slug: `observation-${suffix}`, name: 'Observation' },
  });
  organizationIds.push(organization.id);
  const user = await prisma.user.create({ data: { email: `observation-${suffix}@example.com` } });
  const scenario = await prisma.scenario.create({
    data: {
      organizationId: organization.id,
      key: `observation-${suffix}`,
      name: 'Observation',
      description: 'Observation',
    },
  });
  const version = await prisma.scenarioVersion.create({
    data: { scenarioId: scenario.id, version: 1, config: { packKey: 'test' } },
  });
  const run = await prisma.simulationRun.create({
    data: {
      organizationId: organization.id,
      scenarioVersionId: version.id,
      createdById: user.id,
      seed: 1,
    },
  });
  const first = await prisma.runParticipant.create({
    data: {
      runId: run.id,
      key: 'first',
      displayName: 'First',
      controller: 'agent',
      knowledgeScopes: ['metrics'],
    },
  });
  const second = await prisma.runParticipant.create({
    data: {
      runId: run.id,
      key: 'second',
      displayName: 'Second',
      controller: 'agent',
      knowledgeScopes: ['customer'],
    },
  });
  const initialState = new SimulationKernel(observationPack).initialize({
    organizationId: organization.id,
    runId: run.id,
    seed: run.seed,
    config: {},
    simulatedAt: run.createdAt.toISOString(),
  });
  const persistedState = normalizeJson(initialState);
  await prisma.stateSnapshot.create({
    data: {
      runId: run.id,
      sequence: 0,
      schemaVersion: 2,
      state: persistedState,
      checksum: checksum(persistedState),
    },
  });
  await prisma.participantProjection.createMany({
    data: [
      {
        runParticipantId: first.id,
        runId: run.id,
        status: 'active',
        data: { id: kernelParticipantIds.first, privateMarker: 'first' },
      },
      {
        runParticipantId: second.id,
        runId: run.id,
        status: 'active',
        data: { id: kernelParticipantIds.second, privateMarker: 'second' },
      },
    ],
  });
  const base = {
    organizationId: organization.id,
    runId: run.id,
    version: 1,
    source: 'system' as const,
    simulatedAt: new Date(),
    recordedAt: new Date(),
  };
  await prisma.runEvent.createMany({
    data: [
      {
        ...base,
        id: randomUUID(),
        sequence: 1,
        type: 'participant.first',
        participantId: kernelParticipantIds.first,
        idempotencyKey: 'first-event',
        payload: {},
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 2,
        type: 'participant.second',
        participantId: kernelParticipantIds.second,
        idempotencyKey: 'second-event',
        payload: {},
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 3,
        type: 'signal.emitted',
        idempotencyKey: 'first-signal',
        payload: {
          signalKey: 'metrics-only',
          recipients: [kernelParticipantIds.first],
          requiredKnowledgeScopes: ['metrics'],
        },
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 4,
        type: 'signal.emitted',
        idempotencyKey: 'second-signal',
        payload: {
          signalKey: 'customer-only',
          recipients: [kernelParticipantIds.second],
          requiredKnowledgeScopes: ['customer'],
        },
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 5,
        type: 'state.changed',
        idempotencyKey: 'private-state',
        payload: { secret: true },
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 6,
        type: 'run.started',
        idempotencyKey: 'public-event',
        payload: {},
      },
    ],
  });
  return {
    organizationId: organization.id,
    runId: run.id,
    firstRowId: first.id,
    secondRowId: second.id,
  };
}

async function updateFixtureState(runId: string, incidentDeclared: boolean) {
  const snapshot = await prisma.stateSnapshot.findUniqueOrThrow({
    where: { runId_sequence: { runId, sequence: 0 } },
  });
  const state = normalizeJson(snapshot.state) as {
    world: { response: { incidentDeclared: boolean } };
  };
  state.world.response.incidentDeclared = incidentDeclared;
  await prisma.stateSnapshot.update({
    where: { id: snapshot.id },
    data: {
      state,
      checksum: checksum(state),
    },
  });
}

function normalizeJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
