'use client';

import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Activity, BellRing, GitBranch, Users } from 'lucide-react';
import type { ScenarioGraphDto, ScenarioGraphNodeKind } from '@/lib/scenario-graph';

type ScenarioGraphProps = {
  graph: ScenarioGraphDto | null;
};

const kindLabels: Record<ScenarioGraphNodeKind, string> = {
  participant: '参与方',
  action: 'Action',
  signal: 'Signal',
  inject: 'Inject',
};

export function ScenarioGraph({ graph }: ScenarioGraphProps) {
  if (!graph) {
    return (
      <section className="scenario-graph-section" aria-labelledby="scenario-graph-heading">
        <h2 className="section-heading" id="scenario-graph-heading">
          只读 Scenario Graph
        </h2>
        <div className="empty-state">
          当前已发布版本引用的场景包尚未在 Web Runtime 注册，因此无法生成可信关系图。
        </div>
      </section>
    );
  }

  const nodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    draggable: false,
    selectable: true,
    data: {
      label: (
        <div className={`graph-node graph-node-${node.kind}`}>
          <span>{kindLabels[node.kind]}</span>
          <strong>{node.label}</strong>
          <small>{node.detail}</small>
        </div>
      ),
    },
    ariaLabel: `${kindLabels[node.kind]}：${node.label}，${node.detail}`,
  }));
  const edges: Edge[] = graph.relations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    label: relation.label,
    markerEnd: { type: MarkerType.ArrowClosed },
    focusable: true,
    selectable: true,
  }));

  return (
    <section className="scenario-graph-section" aria-labelledby="scenario-graph-heading">
      <div className="section-title-row">
        <div>
          <h2 className="section-heading" id="scenario-graph-heading">
            只读 Scenario Graph
          </h2>
          <p id="scenario-graph-help">
            图由已发布版本的 <code>{graph.packKey}</code>{' '}
            场景包在服务端推导。可缩放和移动视图，但不能拖动、连接或删除节点。
          </p>
        </div>
        <ul className="graph-legend" aria-label="节点图例">
          <li>
            <Users size={14} aria-hidden="true" />
            参与方
          </li>
          <li>
            <Activity size={14} aria-hidden="true" />
            Action
          </li>
          <li>
            <BellRing size={14} aria-hidden="true" />
            Signal
          </li>
          <li>
            <GitBranch size={14} aria-hidden="true" />
            Inject
          </li>
        </ul>
      </div>

      <figure
        className="scenario-graph-figure"
        aria-labelledby="scenario-graph-heading"
        aria-describedby="scenario-graph-help"
      >
        <div
          className="scenario-flow"
          role="img"
          aria-label={`场景关系图，共 ${graph.nodes.length} 个节点、${graph.relations.length} 条关系`}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            fitViewOptions={{ padding: 0.16 }}
            nodesDraggable={false}
            nodesConnectable={false}
            connectOnClick={false}
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            minZoom={0.25}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <figcaption>
          关系图仅展示 Pack 的静态策略和 Effect 引用，不代表运行时前置条件已经满足。
        </figcaption>
      </figure>

      <details className="graph-relations">
        <summary>查看可访问的关系清单（{graph.relations.length}）</summary>
        <ul>
          {graph.relations.map((relation) => (
            <li key={relation.id}>
              <strong>{relation.sourceLabel}</strong>
              <span>{relation.label}</span>
              <strong>{relation.targetLabel}</strong>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
