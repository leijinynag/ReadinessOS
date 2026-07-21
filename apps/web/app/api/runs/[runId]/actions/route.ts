import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@readinessos/database';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseForCommandResult,
} from '@/lib/api-response';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { requireRunSession, userActor } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';
import { ApplicationError } from '@readinessos/domain-events';
import { assertRunIsActiveForSession } from '@/lib/release-policy';

const actionSchema = z.object({
  participantId: z.string().uuid(),
  actionType: z.string().min(1).max(128),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const input = actionSchema.parse(await request.json());
    const record = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, expiresAt: true },
    });
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    const session = await requireRunSession(record.organizationId, 'member');
    assertRunIsActiveForSession(session, record);
    const execution = await runService.execute({
      commandId: randomUUID(),
      organizationId: record.organizationId,
      runId,
      actor: userActor(session, record.organizationId),
      expectedRunVersion: parseExpectedRunVersion(request),
      idempotencyKey: requiredIdempotencyKey(request),
      issuedAt: new Date().toISOString(),
      payload: {
        type: 'submit-action',
        participantId: input.participantId,
        actionType: input.actionType,
        parameters: input.parameters,
      },
    });
    drainOutboxAfterResponse();
    return responseForCommandResult({ result: execution.result }, execution.result.state.run.version);
  } catch (error) {
    return apiError(error);
  }
}
