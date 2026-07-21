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

const answerSchema = z
  .object({
    optionId: z.string().min(1).max(256).optional(),
    text: z.string().min(1).max(10_000).optional(),
  })
  .strict()
  .refine((value) => value.optionId !== undefined || value.text !== undefined, {
    message: 'Either optionId or text is required.',
  });
type RouteContext = { params: Promise<{ runId: string; questionId: string }> };

const recommendationService = new AgentRecommendationService(prisma);

export async function POST(request: Request, context: RouteContext) {
  try {
    const { runId, questionId } = await context.params;
    const input = answerSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, version: true, expiresAt: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');
    const session = await requireRunSession(run.organizationId, 'member');
    assertRunIsActiveForSession(session, run);
    assertGuestFeature(session, 'agent-recommendation');
    if (parseExpectedRunVersion(request) !== run.version) {
      throw new ApplicationError(
        'RUN_VERSION_CONFLICT',
        'The Run changed before the answer was submitted.',
      );
    }
    requiredIdempotencyKey(request);

    const answered = await recommendationService.answerQuestion({
      runId,
      organizationId: run.organizationId,
      questionId,
      actorId: session.userId,
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    await queueAgentDispatch({
      organizationId: run.organizationId,
      runId,
      dispatchId: answered.dispatchId,
    });
    drainOutboxAfterResponse();
    const latestRun = await prisma.simulationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { version: true },
    });
    return responseWithRunVersion({ dispatchId: answered.dispatchId }, latestRun.version);
  } catch (error) {
    return apiError(error);
  }
}
