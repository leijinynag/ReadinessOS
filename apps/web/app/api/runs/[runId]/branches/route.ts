import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { prisma } from '@readinessos/database';
import {
  apiError,
  parseExpectedRunVersion,
  requiredIdempotencyKey,
  responseWithRunVersion,
} from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';

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
      select: { organizationId: true },
    });
    if (!parent) throw new ApplicationError('NOT_FOUND', 'Run not found');
    const session = await requireRunSession(parent.organizationId, 'member');
    const branch = await runService.createBranchRun({
      parentRunId: runId,
      organizationId: parent.organizationId,
      createdById: session.userId,
      idempotencyKey: requiredIdempotencyKey(request),
      expectedParentRunVersion: parseExpectedRunVersion(request),
      branchFromSequence: input.sequence,
      name: input.name,
    });
    await drainRuntimeOutbox();
    return responseWithRunVersion({ branch }, branch.version);
  } catch (error) {
    return apiError(error);
  }
}
