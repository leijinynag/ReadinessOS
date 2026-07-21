import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';
import { assertGuestFeature, assertRunIsActiveForSession } from '@/lib/release-policy';

const branchSchema = z.object({
  sequence: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const input = branchSchema.parse(await request.json());
    const parent = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, expiresAt: true },
    });
    if (!parent) throw new ApplicationError('NOT_FOUND', 'Run not found');
    const session = await requireRunSession(parent.organizationId, 'member');
    assertRunIsActiveForSession(session, parent);
    assertGuestFeature(session, 'branch');
    const branch = await runService.createBranchRun({
      parentRunId: runId,
      organizationId: parent.organizationId,
      createdById: session.userId,
      idempotencyKey: requiredIdempotencyKey(request),
      expectedParentRunVersion: parseExpectedRunVersion(request),
      branchFromSequence: input.sequence,
      name: input.name,
    });
    drainOutboxAfterResponse();
    return responseWithRunVersion({ branch }, branch.version);
  } catch (error) {
    return apiError(error);
  }
}
