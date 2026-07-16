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
import { requireRunSession, userActor } from '@/lib/run-api';
import { drainRuntimeOutbox, runService } from '@/lib/run-runtime';
import { assertGuestFeature, assertRunIsActiveForSession } from '@/lib/release-policy';

const injectSchema = z.object({
  injectKey: z.string().min(1).max(128),
});
type RunRouteContext = { params: Promise<{ runId: string }> };

/**
 * Director 注入只能引用当前 Run 所属 Pack 的静态声明。客户端仅提供 key，
 * 内核会再次检查该注入是否已经触发，不能借此写入任意 WorldState。
 */
export async function POST(request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    const input = injectSchema.parse(await request.json());
    const record = await prisma.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true, expiresAt: true },
    });
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }

    const session = await requireRunSession(record.organizationId, 'member');
    assertRunIsActiveForSession(session, record);
    assertGuestFeature(session, 'director-inject');
    const pack = await runService.getRunScenarioPack(runId, record.organizationId);
    if (!pack.injects.some((inject) => inject.key === input.injectKey)) {
      throw new ApplicationError('ACTION_NOT_ALLOWED', 'The inject is unavailable for this Run.');
    }

    const execution = await runService.execute({
      commandId: randomUUID(),
      organizationId: record.organizationId,
      runId,
      actor: userActor(session, record.organizationId),
      expectedRunVersion: parseExpectedRunVersion(request),
      idempotencyKey: requiredIdempotencyKey(request),
      issuedAt: new Date().toISOString(),
      payload: { type: 'trigger-inject', injectKey: input.injectKey },
    });
    await drainRuntimeOutbox();
    return responseWithRunVersion({ result: execution.result }, execution.result.state.run.version);
  } catch (error) {
    return apiError(error);
  }
}
