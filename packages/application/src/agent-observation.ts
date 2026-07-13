import type { PrismaClient } from '@prisma/client';
import { observationSchema, type Observation } from './agent-runtime';

const publicEventTypes = new Set([
  'run.created',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'clock.advanced',
]);

/** 从参与方投影构造最小观察，不读取完整 Snapshot/WorldState。 */
export class AgentObservationService {
  constructor(private readonly client: PrismaClient) {}

  async build(input: {
    runId: string;
    organizationId: string;
    participantId: string;
    remainingTurns?: number;
    remainingTokens?: number;
  }): Promise<Observation> {
    const participant = await this.client.runParticipant.findFirst({
      where: {
        id: input.participantId,
        runId: input.runId,
        controller: 'agent',
        run: { organizationId: input.organizationId },
      },
      include: {
        run: { select: { virtualTime: true } },
        projection: { select: { data: true } },
      },
    });
    if (!participant) throw new Error('Agent participant was not found.');

    const capabilities = stringArray(participant.capabilities);
    const knowledgeScopes = new Set(stringArray(participant.knowledgeScopes));
    const projection = objectValue(participant.projection?.data);
    const kernelParticipantId = typeof projection.id === 'string' ? projection.id : participant.id;
    const events = await this.client.runEvent.findMany({
      where: { runId: input.runId, organizationId: input.organizationId },
      orderBy: { sequence: 'desc' },
      take: 200,
      select: { sequence: true, type: true, participantId: true, payload: true },
    });
    const visibleEvents = events
      .filter((event) =>
        isVisibleEvent(event, participant.id, kernelParticipantId, knowledgeScopes),
      )
      .slice(0, 20)
      .reverse();
    const visibleSignals = visibleEvents
      .filter((event) => event.type === 'signal.emitted')
      .map((event) => objectValue(event.payload));

    return observationSchema.parse({
      organizationId: input.organizationId,
      runId: input.runId,
      participant: {
        id: participant.id,
        key: participant.key,
        displayName: participant.displayName,
        objectives: stringArray(participant.objectives),
      },
      virtualTimeMinutes: participant.run.virtualTime,
      visibleState: projection,
      visibleSignals,
      recentEvents: visibleEvents.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        summary: event.type,
      })),
      availableActions: capabilities.map((type) => ({
        type,
        label: type,
        parameterSchema: {},
      })),
      budget: {
        remainingTurns: input.remainingTurns ?? 1,
        remainingTokens: input.remainingTokens ?? 4_000,
      },
    });
  }
}

function isVisibleEvent(
  event: { type: string; participantId: string | null; payload: unknown },
  databaseParticipantId: string,
  kernelParticipantId: string,
  knowledgeScopes: ReadonlySet<string>,
): boolean {
  if (
    event.participantId === databaseParticipantId ||
    event.participantId === kernelParticipantId
  ) {
    return true;
  }
  const payload = objectValue(event.payload);
  if (event.type === 'signal.emitted') {
    const recipients = stringArray(payload.recipients);
    const requiredScopes = stringArray(payload.requiredKnowledgeScopes);
    return (
      (recipients.includes(databaseParticipantId) || recipients.includes(kernelParticipantId)) &&
      requiredScopes.every((scope) => knowledgeScopes.has(scope))
    );
  }
  return event.participantId === null && publicEventTypes.has(event.type);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
