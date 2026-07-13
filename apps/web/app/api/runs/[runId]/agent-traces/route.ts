import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';

const querySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  take: z.coerce.number().int().min(1).max(200).default(100),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

/** Eve Trace 使用独立 cursor/DTO，不混入权威 DomainEvent 流。 */
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
    const traces = await prisma.agentTrace.findMany({
      where: { runId, streamIndex: { gt: query.after } },
      orderBy: [{ streamIndex: 'asc' }, { recordedAt: 'asc' }],
      take: query.take,
      select: {
        id: true,
        runParticipantId: true,
        sessionId: true,
        streamIndex: true,
        eventType: true,
        recordedAt: true,
      },
    });
    return Response.json(
      {
        agentTraces: traces,
        nextTraceCursor: traces.at(-1)?.streamIndex ?? query.after,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}
