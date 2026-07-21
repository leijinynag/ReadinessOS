import { prisma } from '@readinessos/database';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { queueAgentDispatch } from '@/lib/agent-dispatch-queue';
import { getProductionAgentTurnService } from '@/lib/agent-turn-runtime';
import { env } from '@/lib/env';

export type AgentDispatchWorkflowInput = {
  dispatchId: string;
  runId: string;
  organizationId: string;
};

const recommendationService = new AgentRecommendationService(prisma);

/**
 * 这是 Agent 分析的唯一业务执行入口。它不在 Outbox handler 内直接运行：
 * Workflow step 即使经历请求进程重启，也会继续完成或将 Dispatch 回写为重试。
 */
export async function executeAgentDispatch(input: AgentDispatchWorkflowInput): Promise<void> {
  const dispatch = await recommendationService.claimDispatch(input);
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
    const result =
      dispatch.answeredQuestion === undefined
        ? await executeObservationTurn(turnService, dispatch)
        : await turnService.turn({
            runId: dispatch.runId,
            organizationId: dispatch.organizationId,
            participantId: dispatch.advisorParticipantId,
            input: {
              type: 'input-response',
              response: {
                requestId: dispatch.answeredQuestion.requestId,
                ...dispatch.answeredQuestion.answer,
              },
            },
          });
    if (result === undefined) return;
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
        ...(result.eveSessionId === undefined ? {} : { eveSessionId: result.eveSessionId }),
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
          await queueAgentDispatch({
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
    // Eve 的模型、预算和结构化输出失败都只能影响分析审计层。统一退避重试，
    // 让配置修复或额度恢复后仍能基于最新事实继续分析，绝不能回滚领域命令。
    const retry = await recommendationService.markDispatchRetry({
      dispatchId: dispatch.id,
      runId: dispatch.runId,
      error,
    });
    await queueAgentDispatch({
      organizationId: dispatch.organizationId,
      runId: dispatch.runId,
      dispatchId: dispatch.id,
      nextAttemptAt: retry.nextAttemptAt,
    });
  }
}

async function executeObservationTurn(
  turnService: ReturnType<typeof getProductionAgentTurnService>,
  dispatch: {
    id: string;
    runId: string;
    organizationId: string;
    advisorParticipantId: string;
    requestKind: 'automatic' | 'reanalyze' | 'compare';
  },
) {
  const observation = await turnService.buildObservation({
    runId: dispatch.runId,
    organizationId: dispatch.organizationId,
    participantId: dispatch.advisorParticipantId,
  });
  if (observation.availableActions.length === 0) {
    await recommendationService.markDispatchCompleted({
      dispatchId: dispatch.id,
      runId: dispatch.runId,
      type: 'agent.analysis_skipped',
      data: {
        reason: 'No authorized action currently satisfies Kernel policy.',
      },
    });
    return undefined;
  }
  return turnService.turn({
    runId: dispatch.runId,
    organizationId: dispatch.organizationId,
    participantId: dispatch.advisorParticipantId,
    input: {
      type: 'observe',
      intent: dispatch.requestKind === 'compare' ? 'compare' : 'recommend',
      observation,
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
