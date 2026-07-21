import { randomUUID } from 'node:crypto';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseForCommandResult,
} from '@/lib/api-response';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { requireRunSession, userActor } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';
import { prisma } from '@readinessos/database';
import { ApplicationError } from '@readinessos/domain-events';
import { assertRunIsActiveForSession } from '@/lib/release-policy';

type RunRouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
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
      payload: { type: 'start-run' },
    });
    drainOutboxAfterResponse();
    return responseForCommandResult({ result: execution.result }, execution.result.state.run.version);
  } catch (error) {
    return apiError(error);
  }
}
