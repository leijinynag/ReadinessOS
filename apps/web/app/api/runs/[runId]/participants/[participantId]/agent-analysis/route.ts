import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import { queueAgentDispatch } from '@/lib/agent-outbox';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { assertGuestFeature, assertRunIsActiveForSession } from '@/lib/release-policy';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

const inputSchema = z
  .object({
    requestKind: z.enum(['reanalyze', 'compare']),
  })
  .strict();
type RouteContext = { params: Promise<{ runId: string; participantId: string }> };

const recommendationService = new AgentRecommendationService(prisma);

/**
 * IC 的重新分析请求不会直接调用 Eve。先持久化为 Dispatch，再由 Outbox 投递，
 * 这样页面刷新或服务重启都不会丢失这次有明确业务意图的分析请求。
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { runId, participantId } = await context.params;
    const input = inputSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, status: true, version: true, expiresAt: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');
    const session = await requireRunSession(run.organizationId, 'member');
    assertRunIsActiveForSession(session, run);
    assertGuestFeature(session, 'agent-recommendation');
    if (run.status !== 'running') {
      throw new ApplicationError('VALIDATION_ERROR', 'Agent analysis requires a running Run.');
    }
    if (parseExpectedRunVersion(request) !== run.version) {
      throw new ApplicationError(
        'RUN_VERSION_CONFLICT',
        'The Run changed before analysis was requested.',
      );
    }
    requiredIdempotencyKey(request);

    const advisor = await prisma.runParticipant.findFirst({
      where: { id: participantId, runId, controller: 'agent' },
      select: { id: true, key: true },
    });
    if (!advisor) {
      throw new ApplicationError('NOT_FOUND', 'Agent advisor was not found for this run.');
    }
    const pack = await runService.getRunScenarioPack(runId, run.organizationId);
    // 数据库中是 Agent 控制的参与方，并不代表它天然具备提出建议的资格。
    // 手动入口必须与自动调度一样受当前 Scenario Version 的 agentPolicy 约束。
    if (
      !pack.agentPolicy?.advisors.some((policy) => policy.advisorParticipantKey === advisor.key)
    ) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'This Agent participant is not authorized to provide recommendations in this scenario.',
      );
    }

    const queued = await recommendationService.enqueueDispatch({
      runId,
      organizationId: run.organizationId,
      advisorParticipantId: advisor.id,
      requestKind: input.requestKind,
      // 这是 IC 显式触发，不伪造不存在的 Kernel sequence。
      triggerEventTypes: [`ic.${input.requestKind}_requested`],
      triggerSequences: [],
      force: true,
    });
    if (queued.dispatchId) {
      await queueAgentDispatch({
        organizationId: run.organizationId,
        runId,
        dispatchId: queued.dispatchId,
      });
    }
    drainOutboxAfterResponse();
    const latestRun = await prisma.simulationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { version: true },
    });
    return responseWithRunVersion(
      { dispatchId: queued.dispatchId ?? null, merged: queued.merged },
      latestRun.version,
    );
  } catch (error) {
    return apiError(error);
  }
}
