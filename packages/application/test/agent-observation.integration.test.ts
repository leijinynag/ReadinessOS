import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@readinessos/database';
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
      }),
      service.build({
        runId: fixture.runId,
        organizationId: fixture.organizationId,
        participantId: fixture.secondRowId,
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
});

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
  const firstKernelId = randomUUID();
  const secondKernelId = randomUUID();
  await prisma.participantProjection.createMany({
    data: [
      {
        runParticipantId: first.id,
        runId: run.id,
        status: 'active',
        data: { id: firstKernelId, privateMarker: 'first' },
      },
      {
        runParticipantId: second.id,
        runId: run.id,
        status: 'active',
        data: { id: secondKernelId, privateMarker: 'second' },
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
        participantId: firstKernelId,
        idempotencyKey: 'first-event',
        payload: {},
      },
      {
        ...base,
        id: randomUUID(),
        sequence: 2,
        type: 'participant.second',
        participantId: secondKernelId,
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
          recipients: [firstKernelId],
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
          recipients: [secondKernelId],
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
