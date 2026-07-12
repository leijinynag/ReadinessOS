import { z } from 'zod';
import { apiError, requiredIdempotencyKey, responseWithRunVersion } from '@/lib/api-response';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { requireRunSession } from '@/lib/run-api';

const createRunSchema = z.object({
  organizationId: z.string().uuid(),
  scenarioVersionId: z.string().uuid(),
  seed: z.number().int(),
  tickIntervalSeconds: z.number().int().min(1).max(3_600).optional(),
});

export async function POST(request: Request) {
  try {
    const input = createRunSchema.parse(await request.json());
    const session = await requireRunSession(input.organizationId, 'member');
    const idempotencyKey = requiredIdempotencyKey(request);

    const run = await runService.createRun({
      organizationId: input.organizationId,
      scenarioVersionId: input.scenarioVersionId,
      createdById: session.userId,
      idempotencyKey,
      seed: input.seed,
      simulatedAt: new Date().toISOString(),
      ...(input.tickIntervalSeconds === undefined
        ? {}
        : { tickIntervalSeconds: input.tickIntervalSeconds }),
    });
    await drainRuntimeOutbox();
    return responseWithRunVersion({ run }, run.version, 201);
  } catch (error) {
    return apiError(error);
  }
}
