import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn();
const env = { CRON_SECRET: undefined as string | undefined };
const workflow = vi.fn();

vi.mock('workflow/api', () => ({ start }));
vi.mock('@/lib/env', () => ({ env }));
vi.mock('@/workflows/reconcile-runs', () => ({ reconcileRunsWorkflow: workflow }));

const { GET } = await import('./route');

describe('reconciliation Cron route', () => {
  beforeEach(() => {
    start.mockReset();
    env.CRON_SECRET = undefined;
  });

  it('未配置密钥时拒绝 Bearer undefined', async () => {
    const response = await GET(
      new Request('http://localhost/api/cron/reconcile-runs', {
        headers: { authorization: 'Bearer undefined' },
      }),
    );

    expect(response.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('拒绝错误密钥', async () => {
    env.CRON_SECRET = 'correct-secret-value';
    const response = await GET(
      new Request('http://localhost/api/cron/reconcile-runs', {
        headers: { authorization: 'Bearer wrong-secret' },
      }),
    );

    expect(response.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('只为授权请求启动一个有限对账 Workflow', async () => {
    env.CRON_SECRET = 'correct-secret-value';
    start.mockResolvedValue({ runId: 'workflow-run-id' });
    const response = await GET(
      new Request('http://localhost/api/cron/reconcile-runs', {
        headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(workflow, []);
  });
});
