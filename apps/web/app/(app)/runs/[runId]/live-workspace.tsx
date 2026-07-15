import { Activity, AlertTriangle, Clock3, Radio, UsersRound } from 'lucide-react';
import type { RunSummary } from '@readinessos/application';

type JsonRecord = Record<string, unknown>;

export type LiveParticipant = {
  id: string;
  key: string;
  displayName: string;
  controller: 'human' | 'agent' | 'system';
  capabilities: readonly string[];
  objectives: readonly string[];
  projection: {
    status: string;
    data: unknown;
  } | null;
};

type LiveWorkspaceProps = {
  run: RunSummary;
  participants: readonly LiveParticipant[];
};

const runStatusLabels: Record<RunSummary['status'], string> = {
  created: '待启动',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '运行失败',
};

const controllerLabels: Record<LiveParticipant['controller'], string> = {
  human: 'Human',
  agent: 'Agent',
  system: 'System',
};

const objectiveLabels: Record<string, string> = {
  serviceAvailability: '服务可用性',
  customerTrust: '客户信任',
  financialIntegrity: '财务完整性',
};

const objectiveStatusLabels: Record<string, string> = {
  healthy: '健康',
  'at-risk': '有风险',
  failed: '失败',
};

/**
 * Live Workspace 的首屏只消费服务端读取到的投影。后续 W4-07 会把同一份视图
 * 接入客户端 EventStore，避免把页面布局与实时同步机制耦合在一起。
 */
export function LiveWorkspace({ run, participants }: LiveWorkspaceProps) {
  const overview = readRecord(run.data);
  const world = readRecord(overview.world);
  const service = readRecord(world.service);
  const impact = readRecord(world.impact);
  const response = readRecord(world.response);
  const objectives = readRecord(world.objectives);
  const pendingApprovalIds = readStringArray(overview.pendingApprovalIds);
  const activeParticipants = participants.filter(
    (participant) => participant.projection?.status !== 'inactive',
  ).length;

  const metrics = [
    {
      label: '支付成功率',
      value: formatPercent(service.paymentSuccessRate),
      detail: '支付链路当前成功率',
      tone: toRateTone(readNumber(service.paymentSuccessRate)),
    },
    {
      label: '错误率',
      value: formatPercent(service.errorRate),
      detail: '当前请求错误占比',
      tone: toErrorRateTone(readNumber(service.errorRate)),
    },
    {
      label: 'P95 延迟',
      value: formatMilliseconds(service.latencyP95Ms),
      detail: '支付服务 P95 响应延迟',
      tone: 'neutral',
    },
    {
      label: '受影响客户',
      value: formatInteger(impact.affectedCustomers),
      detail: '事件影响范围',
      tone: (readNumber(impact.affectedCustomers) ?? 0) > 0 ? 'risk' : 'neutral',
    },
  ];

  return (
    <main className="page-content live-page">
      <header className="live-header">
        <div>
          <p className="eyebrow">Live Runtime · 实时演练</p>
          <h1>运行工作台</h1>
          <p className="live-run-id">Run ID: {run.id}</p>
        </div>
        <div className="live-header-meta" aria-label="运行状态">
          <span className={`live-status-badge is-${run.status}`}>
            <Radio size={14} aria-hidden="true" />
            {runStatusLabels[run.status]}
          </span>
          <span className="live-meta-item">
            <Clock3 size={15} aria-hidden="true" />
            虚拟时间 T+{run.virtualTime} 分钟
          </span>
          <span className="live-meta-item">版本 {run.version}</span>
        </div>
      </header>

      <div className="live-workspace">
        <section className="live-summary" aria-labelledby="live-summary-heading">
          <div className="live-section-heading">
            <div>
              <p className="eyebrow">Overview</p>
              <h2 id="live-summary-heading">风险与业务摘要</h2>
            </div>
            <span className="live-sequence">事件游标 #{run.latestSequence}</span>
          </div>

          <div className="live-metric-grid">
            {metrics.map((metric) => (
              <article className={`live-metric is-${metric.tone}`} key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </article>
            ))}
          </div>

          <div className="live-summary-list">
            <article>
              <AlertTriangle size={17} aria-hidden="true" />
              <div>
                <span>事件等级</span>
                <strong>{formatSeverity(response.severity)}</strong>
              </div>
            </article>
            <article>
              <Activity size={17} aria-hidden="true" />
              <div>
                <span>预估营收损失</span>
                <strong>{formatCurrency(impact.estimatedRevenueLoss)}</strong>
              </div>
            </article>
            <article>
              <UsersRound size={17} aria-hidden="true" />
              <div>
                <span>待审批动作</span>
                <strong>{pendingApprovalIds.length} 项</strong>
              </div>
            </article>
          </div>

          <section className="live-objectives" aria-labelledby="live-objectives-heading">
            <div className="live-subheading">
              <h3 id="live-objectives-heading">演练目标</h3>
              <span>{Object.keys(objectives).length} 项</span>
            </div>
            {Object.entries(objectives).length > 0 ? (
              <ul>
                {Object.entries(objectives).map(([key, status]) => {
                  const normalizedStatus = typeof status === 'string' ? status : 'unknown';
                  return (
                    <li key={key}>
                      <span>{objectiveLabels[key] ?? key}</span>
                      <strong className={`objective-status is-${normalizedStatus}`}>
                        {objectiveStatusLabels[normalizedStatus] ?? '未知'}
                      </strong>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="live-empty-copy">尚未生成目标状态投影。</p>
            )}
          </section>
        </section>

        <section className="live-timeline" aria-labelledby="live-timeline-heading">
          <div className="live-section-heading">
            <div>
              <p className="eyebrow">Timeline</p>
              <h2 id="live-timeline-heading">运行时间线</h2>
            </div>
            <span className="live-connection-placeholder">等待实时连接</span>
          </div>
          <div className="live-timeline-placeholder">
            <Clock3 size={22} aria-hidden="true" />
            <strong>事件流准备加载</strong>
            <p>当前已持久化至事件 #{run.latestSequence}。实时订阅、补拉与去重将在下一阶段接入。</p>
          </div>
        </section>

        <aside className="live-inspector" aria-labelledby="live-inspector-heading">
          <div className="live-section-heading">
            <div>
              <p className="eyebrow">Participants</p>
              <h2 id="live-inspector-heading">参与方检查器</h2>
            </div>
            <span className="live-sequence">
              {activeParticipants}/{participants.length} 活跃
            </span>
          </div>
          <ul className="live-participant-list">
            {participants.map((participant) => (
              <li key={participant.id}>
                <div className="live-participant-title">
                  <div>
                    <strong>{participant.displayName}</strong>
                    <span>{controllerLabels[participant.controller]}</span>
                  </div>
                  <span
                    className={`participant-runtime-status is-${participant.projection?.status ?? 'inactive'}`}
                  >
                    {formatParticipantStatus(participant.projection?.status)}
                  </span>
                </div>
                <div className="live-participant-detail">
                  <span>能力</span>
                  <p>
                    {participant.capabilities.length
                      ? participant.capabilities.join(' · ')
                      : '无动作能力'}
                  </p>
                </div>
                <div className="live-participant-detail">
                  <span>负责目标</span>
                  <p>
                    {participant.objectives.length
                      ? participant.objectives
                          .map((objective) => objectiveLabels[objective] ?? objective)
                          .join(' · ')
                      : '未分配'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}

function readRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatPercent(value: unknown): string {
  const number = readNumber(value);
  return number === undefined ? '—' : `${(number * 100).toFixed(number < 0.1 ? 1 : 0)}%`;
}

function formatMilliseconds(value: unknown): string {
  const number = readNumber(value);
  return number === undefined ? '—' : `${Math.round(number)} ms`;
}

function formatInteger(value: unknown): string {
  const number = readNumber(value);
  return number === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(Math.round(number));
}

function formatCurrency(value: unknown): string {
  const number = readNumber(value);
  return number === undefined
    ? '—'
    : `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number)}`;
}

function formatSeverity(value: unknown): string {
  return typeof value === 'string' && value !== 'unknown' ? value.toUpperCase() : '未定级';
}

function formatParticipantStatus(value: string | undefined): string {
  if (value === 'active') {
    return '活跃';
  }
  if (value === 'waiting') {
    return '等待中';
  }
  if (value === 'completed') {
    return '已完成';
  }
  return '未激活';
}

function toRateTone(rate: number | undefined): 'healthy' | 'risk' | 'neutral' {
  if (rate === undefined) {
    return 'neutral';
  }
  return rate >= 0.99 ? 'healthy' : 'risk';
}

function toErrorRateTone(rate: number | undefined): 'healthy' | 'risk' | 'neutral' {
  if (rate === undefined) {
    return 'neutral';
  }
  return rate <= 0.01 ? 'healthy' : 'risk';
}
