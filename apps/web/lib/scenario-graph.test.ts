import { describe, expect, it } from 'vitest';
import { saasIncidentPack } from '@readinessos/scenario-pack-saas-incident';
import { buildScenarioGraph } from './scenario-graph';

describe('buildScenarioGraph', () => {
  it('从真实 SaaS Pack 构建四类节点与策略资格关系', () => {
    const graph = buildScenarioGraph(saasIncidentPack);

    expect(new Set(graph.nodes.map((node) => node.kind))).toEqual(
      new Set(['participant', 'action', 'signal', 'inject']),
    );
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'eligible',
          sourceLabel: 'Incident Commander',
          targetLabel: 'Declare incident',
        }),
        expect.objectContaining({
          kind: 'eligible',
          sourceLabel: 'On-call Engineer',
          targetLabel: 'Inspect payment metrics',
        }),
      ]),
    );
    expect(graph.relations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'eligible',
          sourceLabel: 'Executive Stakeholder',
        }),
      ]),
    );
  });

  it('保留真实调度、Signal 发出与明确接收方关系', () => {
    const graph = buildScenarioGraph(saasIncidentPack);

    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'schedules',
          sourceLabel: 'Start rollback',
          targetLabel: 'recovery-complete',
          label: '计划 2 分钟后触发',
        }),
        expect.objectContaining({
          kind: 'emits',
          sourceLabel: 'Disable payment writes',
          targetLabel: 'Payment writes disabled',
        }),
        expect.objectContaining({
          kind: 'delivers',
          sourceLabel: 'Payment writes disabled',
          targetLabel: 'Incident Commander',
        }),
        expect.objectContaining({
          kind: 'emits',
          sourceLabel: 'payment-service-outage',
          targetLabel: 'Payment service outage detected',
        }),
      ]),
    );
  });

  it('输出可安全传给客户端的纯 JSON DTO', () => {
    const graph = buildScenarioGraph(saasIncidentPack);
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('saas-incident');
    expect(JSON.parse(serialized)).toEqual(graph);
    expect(serialized).not.toContain('stateSchema');
    expect(serialized).not.toContain('initialState');
  });
});
