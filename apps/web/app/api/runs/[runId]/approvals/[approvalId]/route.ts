import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import { requireRunSession, userActor } from '@/lib/run-api';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { assertRunIsActiveForSession } from '@/lib/release-policy';

const decisionSchema = z.object({
  decision: z.enum(['approved', 'denied']),
});
type RunRouteContext = { params: Promise<{ runId: string; approvalId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId, approvalId } = await context.params;
    const input = decisionSchema.parse(await request.json());
    const run = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, expiresAt: true },
    });
    if (!run) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    const session = await requireRunSession(run.organizationId, 'member');
    assertRunIsActiveForSession(session, run);
    const execution = await runService.resolveApproval(
      {
        commandId: randomUUID(),
        organizationId: run.organizationId,
        runId,
        actor: userActor(session, run.organizationId),
        expectedRunVersion: parseExpectedRunVersion(request),
        idempotencyKey: requiredIdempotencyKey(request),
        issuedAt: new Date().toISOString(),
      },
      approvalId,
      input.decision,
    );
    await drainRuntimeOutbox();
    return responseWithRunVersion({ result: execution.result }, execution.result.state.run.version);
  } catch (error) {
    return apiError(error);
  }
}
