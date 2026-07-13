import type { PrismaClient } from '@prisma/client';
import { observationSchema, type Observation } from './agent-runtime';

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
    const events = await this.client.runEvent.findMany({
      where: {
        runId: input.runId,
        organizationId: input.organizationId,
        OR: [{ participantId: input.participantId }, { participantId: null }],
      },
      orderBy: { sequence: 'desc' },
      take: 20,
      select: { sequence: true, type: true },
    });

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
      visibleState: objectValue(participant.projection?.data),
      visibleSignals: [],
      recentEvents: events.reverse().map((event) => ({
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
