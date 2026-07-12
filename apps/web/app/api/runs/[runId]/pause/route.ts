import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@readinessos/database';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import { requireRunSession, userActor } from '@/lib/run-api';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { ApplicationError } from '@readinessos/domain-events';

const pauseSchema = z.object({ reason: z.string().min(1).max(1_000).optional() });
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const record = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    const session = await requireRunSession(record.organizationId, 'member');
    const body = pauseSchema.parse(await request.json().catch(() => ({})));
    const execution = await runService.execute({
      commandId: randomUUID(),
      organizationId: record.organizationId,
      runId,
      actor: userActor(session, record.organizationId),
      expectedRunVersion: parseExpectedRunVersion(request),
      idempotencyKey: requiredIdempotencyKey(request),
      issuedAt: new Date().toISOString(),
      payload:
        body.reason === undefined
          ? { type: 'pause-run' }
          : { type: 'pause-run', reason: body.reason },
    });
    await drainRuntimeOutbox();
    return responseWithRunVersion({ result: execution.result }, execution.result.state.run.version);
  } catch (error) {
    return apiError(error);
  }
}
