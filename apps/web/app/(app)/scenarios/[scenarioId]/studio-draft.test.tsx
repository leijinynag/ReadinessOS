import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioScenarioConfig } from '@/lib/scenario-query';
import { StudioDraft } from './studio-draft';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

const participantIds = {
  commander: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  engineer: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
  monitor: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
};

const baseline: StudioScenarioConfig = {
  packKey: 'saas-incident',
  defaultDurationMinutes: 15,
  difficulty: 'intermediate',
  defaultSeed: 42,
  objectives: [
    { key: 'availability', label: '恢复服务', description: '验证支付链路恢复。' },
    { key: 'trust', label: '维护客户信任' },
  ],
  participants: [
    participant('commander', 'Incident Commander', participantIds.commander, 'human'),
    participant('engineer', 'On-call Engineer', participantIds.engineer, 'agent'),
    participant('monitor', 'Monitoring System', participantIds.monitor, 'system'),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('crypto', { randomUUID: () => 'studio-request-1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StudioDraft', () => {
  it('从已发布基线初始化并保留权限信息', () => {
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);

    expect(screen.getByRole('status')).toHaveTextContent('基于已发布 v3');
    expect(screen.queryByText('未保存草稿')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '进阶' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: '随机种子' })).toHaveValue(42);
    expect(screen.getByRole('checkbox', { name: /恢复服务/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /维护客户信任/ })).toBeChecked();
    const commander = screen
      .getByRole('heading', { name: 'Incident Commander' })
      .closest('article')!;
    expect(within(commander).getByRole('checkbox', { name: '已启用' })).toBeChecked();
    expect(within(commander).getByRole('combobox', { name: 'Controller' })).toHaveValue('human');
    expect(screen.getAllByText('declare-incident').length).toBeGreaterThan(0);
    expect(screen.getAllByText('incident').length).toBeGreaterThan(0);
    expect(screen.getAllByText('write:incident').length).toBeGreaterThan(0);
  });

  it('在客户端更新难度、目标、seed、参与方和三种 Controller', () => {
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);

    fireEvent.click(screen.getByRole('radio', { name: '高阶' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /维护客户信任/ }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '随机种子' }), {
      target: { value: '314' },
    });

    const commander = screen
      .getByRole('heading', { name: 'Incident Commander' })
      .closest('article')!;
    fireEvent.click(within(commander).getByRole('checkbox', { name: '已启用' }));
    fireEvent.change(within(commander).getByRole('combobox', { name: 'Controller' }), {
      target: { value: 'agent' },
    });
    const engineer = screen.getByRole('heading', { name: 'On-call Engineer' }).closest('article')!;
    fireEvent.change(within(engineer).getByRole('combobox', { name: 'Controller' }), {
      target: { value: 'system' },
    });
    const monitor = screen.getByRole('heading', { name: 'Monitoring System' }).closest('article')!;
    fireEvent.change(within(monitor).getByRole('combobox', { name: 'Controller' }), {
      target: { value: 'human' },
    });

    expect(screen.getByRole('status')).toHaveTextContent('未保存草稿');
    expect(screen.getByRole('status')).toHaveTextContent('尚未创建新的场景版本');
    expect(screen.queryByText(/保存成功/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '高阶' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /维护客户信任/ })).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: '随机种子' })).toHaveValue(314);
    expect(within(commander).getByRole('checkbox', { name: '已停用' })).not.toBeChecked();
    expect(within(commander).getByRole('combobox', { name: 'Controller' })).toHaveValue('agent');
    expect(within(engineer).getByRole('combobox', { name: 'Controller' })).toHaveValue('system');
    expect(within(monitor).getByRole('combobox', { name: 'Controller' })).toHaveValue('human');
  });

  it('校验随机种子并可重置完整草稿', () => {
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);
    const seed = screen.getByRole('spinbutton', { name: '随机种子' });

    fireEvent.change(seed, { target: { value: '1.5' } });
    expect(screen.getByText('随机种子必须是整数。')).toBeVisible();
    expect(seed).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(seed, { target: { value: '2147483648' } });
    expect(screen.getByText('随机种子必须介于 0 和 2147483647 之间。')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '重置为已发布版本' }));
    expect(seed).toHaveValue(42);
    expect(seed).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('基于已发布 v3');
    expect(screen.getByRole('button', { name: '重置为已发布版本' })).toBeDisabled();
  });

  it('提交最小草稿 DTO，并在成功后跳转到真实 Run', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ run: { id: 'run-1' } }), { status: 201 }),
    );
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);

    fireEvent.click(screen.getByRole('button', { name: '开始演练' }));
    expect(screen.getByRole('button', { name: '正在启动' })).toBeDisabled();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/runs/run-1'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/scenarios/scenario-1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'studio-request-1',
        },
        body: JSON.stringify({
          difficulty: 'intermediate',
          seed: 42,
          selectedObjectiveKeys: ['availability', 'trust'],
          participants: baseline.participants.map(({ id, enabled, controller }) => ({
            id,
            enabled,
            controller,
          })),
        }),
      }),
    );
  });

  it('在没有启用 Human 参与方时禁止启动', () => {
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);
    const commander = screen
      .getByRole('heading', { name: 'Incident Commander' })
      .closest('article')!;
    fireEvent.click(within(commander).getByRole('checkbox', { name: '已启用' }));

    expect(screen.getByRole('button', { name: '开始演练' })).toBeDisabled();
    expect(screen.getByText('至少需要保留一名已启用的 Human 参与方。')).toBeVisible();
  });

  it('显示请求失败信息并保持同一按钮可重试', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: '版本创建失败' } }), { status: 400 }),
    );
    render(<StudioDraft scenarioId="scenario-1" version={3} baseline={baseline} graph={null} />);

    fireEvent.click(screen.getByRole('button', { name: '开始演练' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本创建失败');
    expect(screen.getByRole('button', { name: '开始演练' })).toBeEnabled();
  });
});

function participant(
  key: string,
  displayName: string,
  id: string,
  controller: 'human' | 'agent' | 'system',
): StudioScenarioConfig['participants'][number] {
  return {
    id,
    key,
    displayName,
    controller,
    enabled: true,
    capabilities: ['declare-incident'],
    permissions: ['write:incident'],
    knowledgeScopes: ['incident'],
    objectives: ['availability'],
  };
}
