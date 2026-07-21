import { z } from 'zod';
import { ApplicationError } from '@readinessos/domain-events';
import { apiError, requiredIdempotencyKey, responseWithRunVersion } from '@/lib/api-response';
import { drainOutboxAfterResponse } from '@/lib/outbox-after-response';
import { runService } from '@/lib/run-runtime';
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
    if (session.isGuest) {
      // 访客只能从 Studio 创建带时效和配置约束的 Run，不能调用通用 API 绕过边界。
      throw new ApplicationError(
        'FORBIDDEN',
        'Guest demo access must create runs through the Studio workflow.',
      );
    }
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
    drainOutboxAfterResponse();
    return responseWithRunVersion({ run }, run.version, 201);
  } catch (error) {
    return apiError(error);
  }
}
