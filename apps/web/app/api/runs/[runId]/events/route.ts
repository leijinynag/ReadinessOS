import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';
import { ApplicationError } from '@readinessos/domain-events';

const querySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  take: z.coerce.number().int().min(1).max(1_000).default(200),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const record = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    await requireRunSession(record.organizationId, 'viewer');
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const events = await runService.listEvents(
      runId,
      record.organizationId,
      query.after,
      query.take,
    );
    return Response.json(
      { events, nextCursor: events.at(-1)?.cursor ?? query.after },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}
