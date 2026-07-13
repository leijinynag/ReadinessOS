import { start } from 'workflow/api';
import { env } from '@/lib/env';
import { reconcileRunsWorkflow } from '@/workflows/reconcile-runs';

export async function GET(request: Request): Promise<Response> {
  const authorized =
    env.CRON_SECRET !== undefined &&
    request.headers.get('authorization') === `Bearer ${env.CRON_SECRET}`;
  if (!authorized) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const run = await start(reconcileRunsWorkflow, []);
  return Response.json(
    { workflowRunId: run.runId },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
