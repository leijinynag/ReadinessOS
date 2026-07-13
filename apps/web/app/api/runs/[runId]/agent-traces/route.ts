import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  recordedAt: z.iso.datetime(),
  id: z.string().uuid(),
});
const querySchema = z.object({
  after: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).default(100),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

/** Eve Trace 使用 Run 级 keyset cursor，不依赖 session-local streamIndex。 */
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
    const cursor = query.after === undefined ? undefined : decodeCursor(query.after);
    const traces = await prisma.agentTrace.findMany({
      where: {
        runId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { recordedAt: { gt: new Date(cursor.recordedAt) } },
                {
                  recordedAt: new Date(cursor.recordedAt),
                  id: { gt: cursor.id },
                },
              ],
            }),
      },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
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
    const last = traces.at(-1);
    return Response.json(
      {
        agentTraces: traces.map((trace) => ({
          ...trace,
          recordedAt: trace.recordedAt.toISOString(),
        })),
        nextTraceCursor:
          last === undefined
            ? query.after
            : encodeCursor({
                version: 1,
                recordedAt: last.recordedAt.toISOString(),
                id: last.id,
              }),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export function encodeCursor(payload: z.infer<typeof cursorPayloadSchema>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(value: string): z.infer<typeof cursorPayloadSchema> {
  try {
    return cursorPayloadSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', 'Agent trace cursor is invalid.');
  }
}
