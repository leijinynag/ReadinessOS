import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

type RunRouteContext = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    await requireRunSession(run.organizationId, 'viewer');
    const approvals = await runService.listApprovals(runId, run.organizationId);
    return Response.json({ approvals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
