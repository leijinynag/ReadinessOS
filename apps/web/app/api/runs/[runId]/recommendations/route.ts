import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError } from '@/lib/api-response';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { requireRunSession } from '@/lib/run-api';

const querySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  take: z.coerce.number().int().min(1).max(500).default(200),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

const recommendationService = new AgentRecommendationService(prisma);

/**
 * 建议、追问和活动属于同一份 Agent 审计视图，但不属于 Kernel 事件流。
 * 浏览器据此渲染 IC 决策中心，而不需要读取 Eve 的内部 Session 状态。
 */
export async function GET(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');

    await requireRunSession(run.organizationId, 'viewer');
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const [recommendations, questions, activities] = await Promise.all([
      recommendationService.listRecommendations(runId, run.organizationId),
      recommendationService.listQuestions(runId, run.organizationId),
      recommendationService.listActivities({
        runId,
        organizationId: run.organizationId,
        after: query.after,
        take: query.take,
      }),
    ]);
    return Response.json(
      {
        recommendations,
        questions,
        activities,
        nextActivityCursor: activities.at(-1)?.sequence ?? query.after,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}
