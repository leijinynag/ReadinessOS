import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import { apiError } from '@/lib/api-response';
import { AgentRecommendationService } from '@/lib/agent-recommendation-service';
import { requireRunSession } from '@/lib/run-api';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ runId: string }> };

const recommendationService = new AgentRecommendationService(prisma);

/**
 * Agent 审计流使用数据库 cursor 轮询实现 SSE。它不依赖单进程内存 Hub，
 * 因此多实例部署、进程重启和浏览器重连都能从最后看到的活动位置恢复。
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');
    await requireRunSession(run.organizationId, 'viewer');

    const rawAfter = new URL(request.url).searchParams.get('after') ?? '0';
    const after = Number(rawAfter);
    if (!Number.isInteger(after) || after < 0) {
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid agent activity cursor.');
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let cursor = after;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };
        const abort = () => close();
        request.signal.addEventListener('abort', abort, { once: true });

        const pump = async () => {
          let idleTicks = 0;
          try {
            while (!closed && !request.signal.aborted) {
              const activities = await recommendationService.listActivities({
                runId,
                organizationId: run.organizationId,
                after: cursor,
                take: 200,
              });
              if (activities.length > 0) {
                idleTicks = 0;
                for (const activity of activities) {
                  cursor = activity.sequence;
                  controller.enqueue(
                    encoder.encode(
                      `id: ${activity.sequence}\nevent: agent.activity\ndata: ${JSON.stringify(activity)}\n\n`,
                    ),
                  );
                }
              } else {
                idleTicks += 1;
                if (idleTicks >= 15) {
                  controller.enqueue(encoder.encode(': keep-alive\n\n'));
                  idleTicks = 0;
                }
              }
              await sleep(1_000, request.signal);
            }
          } catch {
            // 连接已被浏览器关闭时无需向一个不可写的 controller 报错。
          } finally {
            request.signal.removeEventListener('abort', abort);
            close();
          }
        };
        void pump();
      },
      cancel() {
        // request.signal 会终止轮询；这里无需维护额外的跨请求状态。
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

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      done();
    };
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
