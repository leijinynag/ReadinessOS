import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

const querySchema = z.object({
  sequence: z.coerce.number().int().nonnegative().optional(),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found');
    await requireRunSession(run.organizationId, 'viewer');
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      { replay: await runService.getReplay(runId, run.organizationId, query.sequence) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}
