import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runEventHub, runService } from '@/lib/run-runtime';
import { ApplicationError } from '@readinessos/domain-events';

export const dynamic = 'force-dynamic';
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
    const url = new URL(request.url);
    const headerCursor = request.headers.get('last-event-id');
    const rawCursor = url.searchParams.get('after') ?? headerCursor ?? '0';
    const after = Number(rawCursor);
    if (!Number.isInteger(after) || after < 0) {
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid event cursor');
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }, 15_000);

        try {
          for await (const envelope of runService.streamEvents(
            runId,
            record.organizationId,
            after,
            runEventHub,
            request.signal,
          )) {
            controller.enqueue(
              encoder.encode(
                `id: ${envelope.cursor}\nevent: run.event\ndata: ${JSON.stringify(envelope)}\n\n`,
              ),
            );
          }
        } finally {
          clearInterval(keepAlive);
          controller.close();
        }
      },
      cancel() {
        // request.signal 会通知 Application generator 完成清理。
      },
    });

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
