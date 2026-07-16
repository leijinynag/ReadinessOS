import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioGraphDto } from '@/lib/scenario-graph';

const flow = vi.hoisted(() => ({ props: vi.fn() }));
vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' },
  ReactFlow: ({ children, ...props }: { children?: React.ReactNode }) => {
    flow.props(props);
    return <div data-testid="react-flow">{children}</div>;
  },
  Background: () => null,
  Controls: () => null,
}));

const { ScenarioGraph } = await import('./scenario-graph');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const graph: ScenarioGraphDto = {
  packKey: 'saas-incident',
  nodes: [
    {
      id: 'participant:commander',
      kind: 'participant',
      label: 'Incident Commander',
      detail: 'human',
      position: { x: 0, y: 0 },
    },
    {
      id: 'action:declare',
      kind: 'action',
      label: 'Declare incident',
      detail: '动作',
      position: { x: 300, y: 0 },
    },
  ],
  relations: [
    {
      id: 'eligible:commander:declare',
      kind: 'eligible',
      source: 'participant:commander',
      target: 'action:declare',
      sourceLabel: 'Incident Commander',
      targetLabel: 'Declare incident',
      label: '策略上可执行',
    },
  ],
};

describe('ScenarioGraph', () => {
  it('以只读 React Flow 渲染服务端 DTO', () => {
    render(<ScenarioGraph graph={graph} />);

    expect(screen.getByRole('heading', { name: '只读 Scenario Graph' })).toBeVisible();
    expect(screen.getByRole('img', { name: '场景关系图，共 2 个节点、1 条关系' })).toBeVisible();
    expect(screen.getByText(/saas-incident/)).toBeVisible();
    expect(flow.props).toHaveBeenCalledWith(
      expect.objectContaining({
        nodesDraggable: false,
        nodesConnectable: false,
        connectOnClick: false,
        deleteKeyCode: null,
        zoomOnDoubleClick: false,
      }),
    );
  });

  it('提供不依赖画布的可访问关系清单', () => {
    render(<ScenarioGraph graph={graph} />);

    expect(screen.getByText('查看可访问的关系清单（1）')).toBeVisible();
    expect(screen.getByText('Incident Commander')).toBeInTheDocument();
    expect(screen.getByText('策略上可执行')).toBeInTheDocument();
    expect(screen.getByText('Declare incident')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '节点图例' })).toBeVisible();
  });

  it('未知 Pack 不回退到静态通用图', () => {
    render(<ScenarioGraph graph={null} />);

    expect(screen.getByText(/无法生成可信关系图/)).toBeVisible();
    expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
  });
});
