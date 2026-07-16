import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']),
});
type RunRouteContext = { params: Promise<{ runId: string; itemId: string }> };

export async function PATCH(request: Request, context: RunRouteContext) {
  try {
    const { runId, itemId } = await context.params;
    const body = updateSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found');
    await requireRunSession(run.organizationId, 'member');
    await runService.updateRemediationItem(runId, run.organizationId, itemId, body.status);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
