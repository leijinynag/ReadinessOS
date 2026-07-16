import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

const createSchema = z.object({
  evaluationId: z.string().uuid().optional(),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(2_000),
  dueAt: z.string().datetime().optional(),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const body = createSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found');
    await requireRunSession(run.organizationId, 'member');
    const item = await runService.createRemediationItem({
      runId,
      organizationId: run.organizationId,
      title: body.title,
      description: body.description,
      ...(body.evaluationId ? { evaluationId: body.evaluationId } : {}),
      ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
