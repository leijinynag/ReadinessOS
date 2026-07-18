import type { PrismaClient } from '@prisma/client';
import type { ScenarioPack } from '@readinessos/scenario-sdk';
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
    pack: ScenarioPack<unknown>;
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
        run: {
          select: {
            virtualTime: true,
            // Observation 对 Eve 暴露的是当前 Run 的参与方主键。该 ID 可以被
            // Recommendation 持久化并受外键保护；Kernel 静态 ID 只留在服务端映射。
            participants: { select: { id: true, key: true } },
          },
        },
        projection: { select: { data: true } },
      },
    });
    if (!participant) throw new Error('Agent participant was not found.');

    const knowledgeScopes = new Set(stringArray(participant.knowledgeScopes));
    const projection = objectValue(participant.projection?.data);
    const kernelParticipantId = typeof projection.id === 'string' ? projection.id : participant.id;
    const advisorPolicy = input.pack.agentPolicy?.advisors.find(
      (policy) => policy.advisorParticipantKey === participant.key,
    );
    if (!advisorPolicy) {
      throw new Error('Agent participant has no recommendation policy in this scenario.');
    }
    const packParticipants = new Map(
      input.pack.participants.map((candidate) => [candidate.key, candidate]),
    );
    const runParticipants = new Map(
      participant.run.participants.map((candidate) => [candidate.key, candidate]),
    );
    const packActions = new Map(input.pack.actions.map((action) => [action.key, action]));
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
      // 可建议动作来自 Pack 的显式授权，而非 advisor 自己的 capability。
      // 目标参与方仍在 Kernel 命令提交时接受完整权限与前置条件校验。
      availableActions: advisorPolicy.recommendationPermissions.flatMap((permission) => {
        const target = packParticipants.get(permission.targetParticipantKey);
        const runTarget = runParticipants.get(permission.targetParticipantKey);
        const action = packActions.get(permission.actionType);
        if (!target || !runTarget || !action) return [];
        return [
          {
            targetParticipantId: runTarget.id,
            type: action.key,
            label: action.label,
            parameterSchema: {},
          },
        ];
      }),
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
