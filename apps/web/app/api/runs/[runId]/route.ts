import { ApplicationError } from '@readinessos/domain-events';
import { apiError, responseWithRunVersion } from '@/lib/api-response';
import { requireRunSession } from '@/lib/run-api';
import { runService } from '@/lib/run-runtime';

type RunRouteContext = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, context: RunRouteContext) {
  try {
    const { runId } = await context.params;
    // 查询 Run 时先读到组织 ID，再以真实会话完成授权。
    // service 内部会再次约束 organizationId，避免路径 ID 绕开租户条件。
    const candidates = (await import('@readinessos/database')).prisma;
    const runRecord = await candidates.simulationRun.findUnique({
      where: { id: runId },
      select: { organizationId: true },
    });
    if (!runRecord) {
      throw new ApplicationError('NOT_FOUND', 'Run not found');
    }
    await requireRunSession(runRecord.organizationId, 'viewer');
    const run = await runService.getRun(runId, runRecord.organizationId);
    return responseWithRunVersion({ run }, run.version);
  } catch (error) {
    return apiError(error);
  }
}
