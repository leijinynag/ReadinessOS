import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import {
  AgentRecommendationService,
  type AgentRecommendationDecision,
} from '@/lib/agent-recommendation-service';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { assertGuestFeature, assertRunIsActiveForSession } from '@/lib/release-policy';
import { requireRunSession, userActor } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

const modifiedActionSchema = z
  .object({
    targetParticipantId: z.string().uuid(),
    actionType: z.string().min(1).max(128),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('adopt'), rationale: z.string().max(4_000).optional() }).strict(),
  z
    .object({
      decision: z.literal('modify'),
      rationale: z.string().max(4_000).optional(),
      modifiedAction: modifiedActionSchema,
    })
    .strict(),
  z.object({ decision: z.literal('reject'), rationale: z.string().max(4_000).optional() }).strict(),
  z
    .object({
      decision: z.literal('defer'),
      rationale: z.string().max(4_000).optional(),
      deferMinutes: z.union([z.literal(1), z.literal(3), z.literal(5)]),
    })
    .strict(),
]);
type RouteContext = { params: Promise<{ runId: string; recommendationId: string }> };

const recommendationService = new AgentRecommendationService(prisma);

export async function POST(request: Request, context: RouteContext) {
  try {
    const { runId, recommendationId } = await context.params;
    const input = decisionSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, version: true, expiresAt: true },
    });
    if (!run) throw new ApplicationError('NOT_FOUND', 'Run not found.');
    const session = await requireRunSession(run.organizationId, 'member');
    assertRunIsActiveForSession(session, run);
    assertGuestFeature(session, 'agent-recommendation');

    // 裁决页面也使用乐观并发控制。即使建议本身会再次校验版本，也不能让
    // 用户在已刷新事实后不知情地提交旧页面上的裁决。
    const expectedRunVersion = parseExpectedRunVersion(request);
    if (expectedRunVersion !== run.version) {
      throw new ApplicationError('RUN_VERSION_CONFLICT', 'The Run changed before this decision.');
    }
    const idempotencyKey = requiredIdempotencyKey(request);
    const pack = await runService.getRunScenarioPack(runId, run.organizationId);
    const result = await recommendationService.decide({
      runId,
      organizationId: run.organizationId,
      recommendationId,
      actor: userActor(session, run.organizationId),
      decision: input.decision as AgentRecommendationDecision,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      ...(input.decision === 'defer' ? { deferMinutes: input.deferMinutes } : {}),
      ...(input.decision === 'modify' ? { modifiedAction: input.modifiedAction } : {}),
      pack,
      executeAction: async (action) => {
        const commandId = randomUUID();
        const execution = await runService.execute({
          commandId,
          organizationId: run.organizationId,
          runId,
          actor: userActor(session, run.organizationId),
          expectedRunVersion: action.expectedRunVersion,
          // 一个 IC 裁决只会发起一条 Kernel Command；保留同一个幂等键可追溯
          // 该命令和浏览器请求之间的关系。
          idempotencyKey,
          issuedAt: new Date().toISOString(),
          payload: {
            type: 'submit-action',
            participantId: action.participantId,
            actionType: action.actionType,
            parameters: action.parameters,
          },
        });
        return {
          commandId,
          latestSequence: execution.result.state.run.latestSequence,
          rejected: execution.result.status === 'rejected',
        };
      },
    });
    drainOutboxAfterResponse();
    const latestRun = await runService.getRun(runId, run.organizationId);
    return responseWithRunVersion(
      {
        decision: {
          decision: input.decision,
          executionSequence: result.executionSequence,
        },
      },
      latestRun.version,
    );
  } catch (error) {
    return apiError(error);
  }
}
