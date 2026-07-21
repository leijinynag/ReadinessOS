import {
  type OutboxMessageHandler,
} from '@readinessos/application';
import { prisma } from '@readinessos/database';
import type { AgentAdvisorPolicy } from '@readinessos/scenario-sdk';
import { start } from 'workflow/api';
import { z } from 'zod';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { queueAgentDispatch as persistAgentDispatch } from '@/lib/agent-dispatch-queue';
import { runService } from '@/lib/run-runtime';
import { agentDispatchWorkflow } from '@/workflows/agent-dispatch';

const runEventPayloadSchema = z.object({
  cursor: z.number().int().positive(),
  event: z.object({
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  }),
});

const agentSchedulePayloadSchema = z.object({
  advisorParticipantKey: z.string().min(1),
  eventType: z.string().min(1),
  eventSequence: z.number().int().positive(),
  eventPayload: z.record(z.string(), z.unknown()),
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

        // 每一条领域事件都可能推进事实版本。先让基于较旧 Observation 的
        // 待裁决建议失效，避免 UI 继续把它们呈现为可以采纳的当前方案。
        await recommendationService.supersedeStaleRecommendations(
          message.runId,
          message.organizationId,
        );

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
              await persistAgentDispatch({
                organizationId: message.organizationId,
                runId: message.runId,
                dispatchId: queued.dispatchId,
              });
            }
          }
        }

        const pack = await runService.getRunScenarioPack(message.runId, message.organizationId);
        const policies = pack.agentPolicy?.advisors.filter((advisor) =>
          matchesAgentAdvisorPolicyEvent(advisor, payload.event),
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
              eventPayload: payload.event.payload,
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
          !matchesAgentAdvisorPolicyEvent(policy, {
            type: payload.eventType,
            payload: payload.eventPayload,
          })
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
        await persistAgentDispatch({
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
        // Outbox 只负责快速启动 Durable Workflow，不能在这里等待 DeepSeek。
        // 否则 after() 的请求生命周期被中断时，会留下已锁定的 Dispatch。
        await start(agentDispatchWorkflow, [{
          dispatchId: payload.dispatchId,
          runId: message.runId,
          organizationId: message.organizationId,
        }]);
      },
    },
  };
}

/**
 * Outbox 第一层筛选减少无效 Dispatch；agent.schedule 再做一次同样的检查，
 * 用于防止 Scenario Version 在消息排队期间发生变化后仍使用过期 Policy。
 */
export function matchesAgentAdvisorPolicyEvent(
  policy: AgentAdvisorPolicy,
  event: { type: string; payload: Record<string, unknown> },
): boolean {
  if (!policy.triggerEventTypes.includes(event.type)) return false;
  if (event.type === 'inject.triggered') {
    return matchesPayloadKey(policy.triggerInjectKeys, event.payload.injectKey);
  }
  if (event.type === 'signal.emitted') {
    return matchesPayloadKey(policy.triggerSignalKeys, event.payload.signalKey);
  }
  if (
    event.type === 'action.proposed' ||
    event.type === 'action.executed' ||
    event.type === 'action.rejected' ||
    event.type === 'action.approval_requested'
  ) {
    return matchesPayloadKey(policy.triggerActionTypes, event.payload.actionType);
  }
  return true;
}

function matchesPayloadKey(
  allowed: readonly string[] | undefined,
  value: unknown,
): boolean {
  return allowed === undefined || (typeof value === 'string' && allowed.includes(value));
}

export async function queueAgentDispatch(input: {
  organizationId: string;
  runId: string;
  dispatchId: string;
}): Promise<void> {
  await persistAgentDispatch(input);
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}
