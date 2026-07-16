import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError } from '@/lib/api-response';
import type { AgentTurnService } from '@/lib/agent-turn-service';
import { getProductionAgentTurnService } from '@/lib/agent-turn-runtime';
import { assertGuestFeature, assertRunIsActiveForSession } from '@/lib/release-policy';
import { requireRunSession } from '@/lib/run-api';

const inputResponseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    optionId: z.string().min(1).max(256).optional(),
    text: z.string().min(1).max(10_000).optional(),
  })
  .strict()
  .refine((value) => value.optionId !== undefined || value.text !== undefined, {
    message: 'Either optionId or text is required.',
  });
const bodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observe') }).strict(),
  z.object({ type: z.literal('input-response'), response: inputResponseSchema }).strict(),
]);
type RouteContext = { params: Promise<{ runId: string; participantId: string }> };

export function createPostHandler(getTurnService: () => Pick<AgentTurnService, 'turn'>) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    try {
      const { runId, participantId } = await context.params;
      const run = await prisma.simulationRun.findUnique({
        where: { id: runId },
        select: { organizationId: true, status: true, expiresAt: true },
      });
      if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');
      const session = await requireRunSession(run.organizationId, 'member');
      assertRunIsActiveForSession(session, run);
      assertGuestFeature(session, 'agent-turn');
      if (run.status !== 'running') {
        throw new ApplicationError('VALIDATION_ERROR', 'Agent turns require a running Run.');
      }
      const parsed = bodySchema.parse(await request.json());
      const input =
        parsed.type === 'observe'
          ? parsed
          : {
              type: parsed.type,
              response: {
                requestId: parsed.response.requestId,
                ...(parsed.response.optionId === undefined
                  ? {}
                  : { optionId: parsed.response.optionId }),
                ...(parsed.response.text === undefined ? {} : { text: parsed.response.text }),
              },
            };
      const result = await getTurnService().turn({
        runId,
        participantId,
        organizationId: run.organizationId,
        input,
      });

      // continuation token 只保存在服务端；客户端仅获得继续交互所需的安全 DTO。
      return Response.json(
        {
          agentTurn: {
            status: result.status,
            participantId: result.handle.runParticipantId,
            agentKey: result.handle.agentKey,
            sessionId: result.handle.sessionId ?? null,
            streamIndex: result.handle.streamIndex,
            proposedAction: result.proposedAction ?? null,
            inputRequests: result.inputRequests,
          },
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      return apiError(error);
    }
  };
}

export const POST = createPostHandler(getProductionAgentTurnService);
