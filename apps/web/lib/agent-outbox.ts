import {
  type OutboxMessageHandler,
} from '@readinessos/application';
import { prisma } from '@readinessos/database';
import { z } from 'zod';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { getProductionAgentTurnService } from '@/lib/agent-turn-runtime';
import { env } from '@/lib/env';
import { runService } from '@/lib/run-runtime';

const runEventPayloadSchema = z.object({
  cursor: z.number().int().positive(),
  event: z.object({
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: z.string().min(1),
  }),
});

const agentSchedulePayloadSchema = z.object({
  advisorParticipantKey: z.string().min(1),
  eventType: z.string().min(1),
  eventSequence: z.number().int().positive(),
});

const agentDispatchPayloadSchema = z.object({
  dispatchId: z.string().uuid(),
});

const recommendationService = new AgentRecommendationService(prisma);

/**
 * Agent 调度是领域事件之后的非权威派生层。每一步都通过 Outbox 持久化：
 * run.event -> agent.schedule -> agent.dispatch，进程重启不会丢失等待中的分析。
 */
export function createAgentRecommendationOutboxHandlers(): Readonly<
  Record<string, OutboxMessageHandler>
> {
  return {
    'run.event': {
      async handle(message) {
        const payload = runEventPayloadSchema.parse(message.payload);
        if (!message.runId || message.runId !== payload.event.runId) return;

        // 延后建议以虚拟时间作为唯一到期依据。时钟推进后先让旧建议失效，
        // 再强制为同一顾问创建新的 Observation，避免 IC 继续看到过期方案。
        if (payload.event.type === 'clock.advanced') {
          const expired = await recommendationService.expireDueRecommendations(
            message.runId,
            message.organizationId,
          );
          for (const advisor of new Map(
            expired.map((item) => [item.advisorParticipantId, item]),
          ).values()) {
            const queued = await recommendationService.enqueueDispatch({
              runId: message.runId,
              organizationId: message.organizationId,
              advisorParticipantId: advisor.advisorParticipantId,
              requestKind: 'automatic',
              triggerEventTypes: ['clock.advanced'],
              triggerSequences: [payload.event.sequence],
              force: true,
            });
            if (queued.dispatchId) {
              await queueDispatchMessage({
                organizationId: message.organizationId,
                runId: message.runId,
                dispatchId: queued.dispatchId,
              });
            }
          }
        }

        const pack = await runService.getRunScenarioPack(message.runId, message.organizationId);
        const policies = pack.agentPolicy?.advisors.filter((advisor) =>
          advisor.triggerEventTypes.includes(payload.event.type),
        );
        if (!policies?.length) return;

        await prisma.outboxMessage.createMany({
          data: policies.map((advisor) => ({
            organizationId: message.organizationId,
            runId: message.runId,
            topic: 'agent.schedule',
            payload: toJson({
              advisorParticipantKey: advisor.advisorParticipantKey,
              eventType: payload.event.type,
              eventSequence: payload.event.sequence,
            }),
          })),
        });
      },
    },
    'agent.schedule': {
      async handle(message) {
        if (!message.runId) return;
        const payload = agentSchedulePayloadSchema.parse(message.payload);
        const [pack, advisor, run] = await Promise.all([
          runService.getRunScenarioPack(message.runId, message.organizationId),
          prisma.runParticipant.findFirst({
            where: {
              runId: message.runId,
              key: payload.advisorParticipantKey,
              controller: 'agent',
            },
            select: { id: true },
          }),
          prisma.simulationRun.findFirst({
            where: { id: message.runId, organizationId: message.organizationId },
            select: { status: true },
          }),
        ]);
        const policy = pack.agentPolicy?.advisors.find(
          (candidate) => candidate.advisorParticipantKey === payload.advisorParticipantKey,
        );
        // Scenario Version 或参与方设置被更新后，历史 Outbox 可能仍在队列中。
        // 二次检查能避免向已失去授权的角色派发分析任务。
        if (
          run?.status !== 'running' ||
          !advisor ||
          !policy ||
          !policy.triggerEventTypes.includes(payload.eventType)
        ) {
          return;
        }

        const queued = await recommendationService.enqueueDispatch({
          runId: message.runId,
          organizationId: message.organizationId,
          advisorParticipantId: advisor.id,
          requestKind: 'automatic',
          triggerEventTypes: [payload.eventType],
          triggerSequences: [payload.eventSequence],
        });
        if (!queued.dispatchId) return;
        await queueDispatchMessage({
          organizationId: message.organizationId,
          runId: message.runId,
          dispatchId: queued.dispatchId,
        });
      },
    },
    'agent.dispatch': {
      async handle(message) {
        if (!message.runId) return;
        const payload = agentDispatchPayloadSchema.parse(message.payload);
        const dispatch = await recommendationService.claimDispatch({
          dispatchId: payload.dispatchId,
          runId: message.runId,
          organizationId: message.organizationId,
        });
        if (!dispatch) return;

        try {
          const run = await prisma.simulationRun.findFirst({
            where: { id: dispatch.runId, organizationId: dispatch.organizationId },
            select: { status: true },
          });
          if (run?.status !== 'running') {
            await recommendationService.markDispatchCompleted({
              dispatchId: dispatch.id,
              runId: dispatch.runId,
              type: 'agent.analysis_skipped',
              data: { reason: 'Run is no longer running.' },
            });
            return;
          }
          const turnService = getProductionAgentTurnService(resolveEveOrigin());
          const result = await turnService.turn({
            runId: dispatch.runId,
            organizationId: dispatch.organizationId,
            participantId: dispatch.advisorParticipantId,
            input:
              dispatch.answeredQuestion === undefined
                ? {
                    type: 'observe',
                    intent: dispatch.requestKind === 'compare' ? 'compare' : 'recommend',
                  }
                : {
                    type: 'input-response',
                    response: {
                      requestId: dispatch.answeredQuestion.requestId,
                      ...dispatch.answeredQuestion.answer,
                    },
                  },
          });
          const observationHash = result.observationHash ?? dispatch.observationHash;
          if (result.observationHash !== undefined) {
            await recommendationService.recordDispatchObservation({
              dispatchId: dispatch.id,
              runId: dispatch.runId,
              observationHash: result.observationHash,
            });
          }

          if (result.status === 'waiting_for_input') {
            if (result.inputRequests.length === 0) {
              throw new Error('Eve is waiting for input without a question payload.');
            }
            await recommendationService.markDispatchWaiting({
              dispatchId: dispatch.id,
              runId: dispatch.runId,
              questions: result.inputRequests,
            });
            return;
          }

          if (result.status === 'completed' && result.proposedAction !== undefined) {
            if (observationHash === undefined) {
              throw new Error('The Agent proposal has no Observation hash.');
            }
            const recommendation = await recommendationService.createRecommendation({
              dispatchId: dispatch.id,
              runId: dispatch.runId,
              organizationId: dispatch.organizationId,
              action: result.proposedAction,
              observationHash,
              ...(result.eveSessionId === undefined
                ? {}
                : { eveSessionId: result.eveSessionId }),
              ...(result.eveTraceIdentity === undefined
                ? {}
                : { eveTraceIdentity: result.eveTraceIdentity }),
            });
            if (recommendation.status === 'superseded') {
              const requeued = await recommendationService.requeueFromDispatch({
                dispatchId: dispatch.id,
                runId: dispatch.runId,
                organizationId: dispatch.organizationId,
              });
              if (requeued.dispatchId) {
                await queueDispatchMessage({
                  organizationId: dispatch.organizationId,
                  runId: dispatch.runId,
                  dispatchId: requeued.dispatchId,
                });
              }
            }
            return;
          }

          if (result.status === 'completed') {
            await recommendationService.markDispatchCompleted({
              dispatchId: dispatch.id,
              runId: dispatch.runId,
              type: 'agent.analysis_completed_without_recommendation',
            });
            return;
          }
          throw new Error(`Eve returned terminal status "${result.status}".`);
        } catch (error) {
          // Eve transport、配额或 schema 失败只让 Dispatch 退避重试。领域事件在
          // 进入这里之前已经被 Kernel 提交并发布，不能被模型故障回滚或阻塞。
          const retry = await recommendationService.markDispatchRetry({
            dispatchId: dispatch.id,
            runId: dispatch.runId,
            error,
          });
          await queueDispatchMessage({
            organizationId: dispatch.organizationId,
            runId: dispatch.runId,
            dispatchId: dispatch.id,
            nextAttemptAt: retry.nextAttemptAt,
          });
        }
      },
    },
  };
}

export async function queueAgentDispatch(input: {
  organizationId: string;
  runId: string;
  dispatchId: string;
}): Promise<void> {
  await queueDispatchMessage(input);
}

async function queueDispatchMessage(input: {
  organizationId: string;
  runId: string;
  dispatchId: string;
  nextAttemptAt?: Date;
}): Promise<void> {
  await prisma.outboxMessage.create({
    data: {
      organizationId: input.organizationId,
      runId: input.runId,
      topic: 'agent.dispatch',
      payload: toJson({ dispatchId: input.dispatchId }),
      ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
    },
  });
}

function resolveEveOrigin(): string {
  if (env.EVE_RUNTIME_URL) return env.EVE_RUNTIME_URL;
  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost) {
    return `https://${deploymentHost}`;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('EVE_RUNTIME_URL or VERCEL_URL is required for Agent dispatch in production.');
  }
  return `http://localhost:${process.env.PORT?.trim() || '3000'}`;
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}
