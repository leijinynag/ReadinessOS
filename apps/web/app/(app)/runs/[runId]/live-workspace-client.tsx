'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { createActor } from 'xstate';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  UsersRound,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunSummary, StreamEnvelope } from '@readinessos/application';
import {
  liveApprovalMachine,
  liveConnectionMachine,
  liveRunMachine,
} from '@/lib/live-runtime-actors';
import { RunEventStore, type RunEventStoreSnapshot } from '@/lib/run-event-store';
import type { LiveParticipant, LiveWorkspaceProps } from './live-types';

type JsonRecord = Record<string, unknown>;
type ConnectionState = 'connecting' | 'connected' | 'recovering' | 'offline';
type AgentTrace = {
  id: string;
  runParticipantId: string | null;
  eventType: string;
  recordedAt: string;
};
type Approval = {
  id: string;
  actionType: string;
  participantId: string;
  requestedSequence: number;
  parameters: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'stale';
  requestedAt: string;
  expiresAt: string;
  evidence: readonly {
    id: string;
    sequence: number;
    eventType: string;
    label: string;
    data: Record<string, unknown>;
  }[];
};
type TimelineItem =
  | { kind: 'event'; id: string; recordedAt: string; envelope: StreamEnvelope }
  | { kind: 'trace'; id: string; recordedAt: string; trace: AgentTrace };

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

export function LiveWorkspaceClient({
  run: initialRun,
  participants,
  actions,
  injects,
}: LiveWorkspaceProps) {
  const eventStoreRef = useRef(new RunEventStore());
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const traceCursorRef = useRef<string | undefined>(undefined);
  const recoveringRef = useRef(false);
  const [run, setRun] = useState(initialRun);
  const [eventSnapshot, setEventSnapshot] = useState<RunEventStoreSnapshot>(
    eventStoreRef.current.snapshot(),
  );
  const [traces, setTraces] = useState<readonly AgentTrace[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [commandError, setCommandError] = useState<string | null>(null);
  const runActorRef = useRef(createActor(liveRunMachine, { input: toRunContext(initialRun) }));
  const connectionActorRef = useRef(createActor(liveConnectionMachine));
  const approvalActorRef = useRef(
    createActor(liveApprovalMachine, { input: { count: pendingApprovalCount(initialRun) } }),
  );

  const updateEventSnapshot = useCallback(() => {
    setEventSnapshot(eventStoreRef.current.snapshot());
  }, []);

  const syncRun = useCallback((nextRun: RunSummary) => {
    setRun(nextRun);
    runActorRef.current.send({ type: 'sync', run: toRunContext(nextRun) });
    approvalActorRef.current.send({ type: 'sync', count: pendingApprovalCount(nextRun) });
  }, []);

  const refreshRun = useCallback(async () => {
    const response = await fetch(`/api/runs/${initialRun.id}`, { cache: 'no-store' });
    const body = (await response.json()) as { run?: RunSummary; error?: { message?: string } };
    if (!response.ok || !body.run) {
      throw new Error(body.error?.message ?? '无法刷新运行状态。');
    }
    syncRun(body.run);
    return body.run;
  }, [initialRun.id, syncRun]);

  const fetchTraces = useCallback(async () => {
    const query = traceCursorRef.current
      ? `?after=${encodeURIComponent(traceCursorRef.current)}`
      : '';
    const response = await fetch(`/api/runs/${initialRun.id}/agent-traces${query}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as {
      agentTraces?: AgentTrace[];
      nextTraceCursor?: string;
    };
    if (body.agentTraces?.length) {
      setTraces((current) => dedupeTraces([...current, ...body.agentTraces!]));
    }
    traceCursorRef.current = body.nextTraceCursor;
  }, [initialRun.id]);

  const fetchApprovals = useCallback(async () => {
    const response = await fetch(`/api/runs/${initialRun.id}/approvals`, { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { approvals?: Approval[] };
    setApprovals(body.approvals ?? []);
  }, [initialRun.id]);

  const recoverEvents = useCallback(async () => {
    if (recoveringRef.current) {
      return;
    }
    recoveringRef.current = true;
    connectionActorRef.current.send({ type: 'recover' });
    setConnectionState('recovering');
    try {
      let cursor = eventStoreRef.current.snapshot().cursor;
      while (true) {
        const response = await fetch(
          `/api/runs/${initialRun.id}/events?after=${cursor}&take=1000`,
          {
            cache: 'no-store',
          },
        );
        const body = (await response.json()) as {
          events?: StreamEnvelope[];
          nextCursor?: number;
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(body.error?.message ?? '无法恢复事件流。');
        }
        eventStoreRef.current.ingestMany(body.events ?? []);
        updateEventSnapshot();
        const nextCursor = body.nextCursor ?? cursor;
        if ((body.events?.length ?? 0) < 1000 || nextCursor <= cursor) {
          break;
        }
        cursor = nextCursor;
      }
      await Promise.all([refreshRun(), fetchTraces(), fetchApprovals()]);
    } finally {
      recoveringRef.current = false;
    }
  }, [fetchApprovals, fetchTraces, initialRun.id, refreshRun, updateEventSnapshot]);

  useEffect(() => {
    const runActor = runActorRef.current;
    const connectionActor = connectionActorRef.current;
    const approvalActor = approvalActorRef.current;
    runActor.start();
    connectionActor.start();
    approvalActor.start();

    const connectionSubscription = connectionActor.subscribe((snapshot) => {
      setConnectionState(snapshot.value as ConnectionState);
    });

    let disposed = false;
    const connect = async () => {
      try {
        // 从离线恢复时，旧 EventSource 可能仍在浏览器内部重试。
        // 建立新订阅前先释放它，避免同一事件被两个连接重复推送。
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        await recoverEvents();
        if (disposed) {
          return;
        }
        const cursor = eventStoreRef.current.snapshot().cursor;
        if (typeof EventSource === 'undefined') {
          connectionActor.send({ type: 'offline' });
          return;
        }
        const source = new EventSource(`/api/runs/${initialRun.id}/stream?after=${cursor}`);
        eventSourceRef.current = source;
        source.addEventListener('run.event', (message) => {
          const parsed = parseEnvelope((message as MessageEvent<string>).data);
          if (!parsed) {
            return;
          }
          const result = eventStoreRef.current.ingest(parsed);
          updateEventSnapshot();
          if (result.gap) {
            void recoverEvents();
            return;
          }
          void refreshRun().catch(() => undefined);
          if (parsed.event.source === 'agent' || parsed.event.type.startsWith('action.')) {
            void fetchTraces();
          }
          if (parsed.event.type.startsWith('action.approval')) {
            void fetchApprovals();
          }
        });
        source.onopen = () => connectionActor.send({ type: 'open' });
        source.onerror = () => {
          if (!navigator.onLine) {
            connectionActor.send({ type: 'offline' });
            return;
          }
          void recoverEvents().catch(() => undefined);
        };
      } catch {
        connectionActor.send({ type: 'offline' });
      }
    };

    const handleOnline = () => {
      connectionActor.send({ type: 'connect' });
      void connect();
    };
    const handleOffline = () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      connectionActor.send({ type: 'offline' });
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void connect();

    return () => {
      disposed = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      connectionSubscription.unsubscribe();
      runActor.stop();
      connectionActor.stop();
      approvalActor.stop();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [fetchApprovals, fetchTraces, initialRun.id, recoverEvents, refreshRun, updateEventSnapshot]);

  const submitCommand = useCallback(
    async (input: { endpoint: string; body: Record<string, unknown>; label: string }) => {
      const id = newCommandId();
      eventStoreRef.current.enqueueCommand({ id, label: input.label });
      updateEventSnapshot();
      setCommandError(null);
      try {
        const response = await fetch(`/api/runs/${initialRun.id}/${input.endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': `"${run.version}"`,
            'Idempotency-Key': id,
          },
          body: JSON.stringify(input.body),
        });
        const body = (await response.json()) as { error?: { message?: string } };
        if (!response.ok) {
          const message = body.error?.message ?? '命令未被运行时接受。';
          eventStoreRef.current.resolveCommand(id, 'rejected', message);
          updateEventSnapshot();
          setCommandError(message);
          if (response.status === 409) {
            await recoverEvents();
          }
          return;
        }
        eventStoreRef.current.resolveCommand(id, 'accepted');
        updateEventSnapshot();
        await recoverEvents();
      } catch {
        const message = '网络不可用，命令尚未提交。';
        eventStoreRef.current.resolveCommand(id, 'rejected', message);
        updateEventSnapshot();
        setCommandError(message);
      }
    },
    [initialRun.id, recoverEvents, run.version, updateEventSnapshot],
  );

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
  const timelineItems = useMemo(
    () =>
      [
        ...eventSnapshot.events.map((envelope): TimelineItem => ({
          kind: 'event',
          id: `event:${envelope.cursor}`,
          recordedAt: envelope.event.recordedAt,
          envelope,
        })),
        ...traces.map((trace): TimelineItem => ({
          kind: 'trace',
          id: `trace:${trace.id}`,
          recordedAt: trace.recordedAt,
          trace,
        })),
      ].sort((left, right) => {
        const time = left.recordedAt.localeCompare(right.recordedAt);
        return time === 0 ? left.id.localeCompare(right.id) : time;
      }),
    [eventSnapshot.events, traces],
  );
  const virtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: () => 88,
    overscan: 8,
    // 首次提交时滚动容器 ref 尚未可用。提供与 CSS 一致的初始视口，
    // 既避免首帧空白，也让无布局引擎的测试环境能够覆盖时间线渲染。
    initialRect: { width: 960, height: 374 },
  });
  const isRunnable = run.status === 'running';
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  const resolveApproval = useCallback(
    async (approval: Approval, decision: 'approved' | 'denied') => {
      await submitCommand({
        endpoint: `approvals/${approval.id}`,
        body: { decision },
        label: `${decision === 'approved' ? '批准' : '拒绝'}动作: ${approval.actionType}`,
      });
      await fetchApprovals();
    },
    [fetchApprovals, submitCommand],
  );

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
          <ConnectionBadge state={connectionState} hasGap={eventSnapshot.hasGap} />
        </div>
      </header>

      <div className="live-workspace">
        <section className="live-summary" aria-labelledby="live-summary-heading">
          <div className="live-section-heading">
            <div>
              <p className="eyebrow">Overview</p>
              <h2 id="live-summary-heading">风险与业务摘要</h2>
            </div>
            <span className="live-sequence">事件游标 #{eventSnapshot.cursor}</span>
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
                <strong>{Math.max(pendingApprovalIds.length, pendingApprovals.length)} 项</strong>
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

          <section className="live-control-section" aria-labelledby="live-actions-heading">
            <div className="live-subheading">
              <h3 id="live-actions-heading">运行控制</h3>
              <span>命令使用乐观并发控制</span>
            </div>
            <div className="live-control-buttons">
              {run.status === 'running' ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="暂停运行"
                  title="暂停运行"
                  onClick={() =>
                    void submitCommand({ endpoint: 'pause', body: {}, label: '暂停运行' })
                  }
                >
                  <Pause size={16} aria-hidden="true" />
                </button>
              ) : run.status === 'paused' ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="继续运行"
                  title="继续运行"
                  onClick={() =>
                    void submitCommand({ endpoint: 'resume', body: {}, label: '继续运行' })
                  }
                >
                  <Play size={16} aria-hidden="true" />
                </button>
              ) : null}
              <button
                className="icon-button"
                type="button"
                aria-label="重新同步事件流"
                title="重新同步事件流"
                onClick={() => void recoverEvents()}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </div>
            {injects.length > 0 ? (
              <label className="live-inject-control">
                <span>Director Inject</span>
                <select
                  aria-label="Director Inject"
                  defaultValue=""
                  disabled={!isRunnable}
                  onChange={(event) => {
                    const injectKey = event.currentTarget.value;
                    if (!injectKey) {
                      return;
                    }
                    event.currentTarget.value = '';
                    void submitCommand({
                      endpoint: 'inject',
                      body: { injectKey },
                      label: `Director Inject: ${injectKey}`,
                    });
                  }}
                >
                  <option value="">选择注入</option>
                  {injects.map((inject) => (
                    <option key={inject.key} value={inject.key}>
                      {inject.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </section>
        </section>

        <section className="live-timeline" aria-labelledby="live-timeline-heading">
          <div className="live-section-heading">
            <div>
              <p className="eyebrow">Timeline</p>
              <h2 id="live-timeline-heading">运行时间线</h2>
            </div>
            <ConnectionBadge state={connectionState} hasGap={eventSnapshot.hasGap} />
          </div>
          {eventSnapshot.hasGap ? (
            <p className="live-gap-notice" role="status">
              检测到事件游标缺口，正在从权威事件流补拉。
            </p>
          ) : null}
          <div className="live-timeline-scroll" ref={timelineRef} aria-label="运行事件时间线">
            {timelineItems.length === 0 ? (
              <div className="live-timeline-placeholder">
                <Clock3 size={22} aria-hidden="true" />
                <strong>等待运行事件</strong>
                <p>实时连接建立后，已持久化事件会按 cursor 顺序显示在这里。</p>
              </div>
            ) : (
              <div
                className="live-timeline-virtual"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const timelineItem = timelineItems[item.index];
                  if (!timelineItem) {
                    return null;
                  }
                  return (
                    <div
                      className="live-timeline-row"
                      data-index={item.index}
                      key={timelineItem.id}
                      ref={virtualizer.measureElement}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <TimelineEntry item={timelineItem} participants={participants} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <section className="live-action-panel" aria-labelledby="live-human-actions-heading">
            <div className="live-subheading">
              <h3 id="live-human-actions-heading">Human 动作</h3>
              <span>{isRunnable ? '可提交' : '运行未激活'}</span>
            </div>
            {actions.length === 0 ? (
              <p className="live-empty-copy">当前没有可由 Human 控制的动作。</p>
            ) : (
              <div className="live-action-list">
                {actions.map((action) => (
                  <div className="live-action-row" key={action.key}>
                    <div>
                      <strong>{action.label}</strong>
                      <span>
                        {action.risk === 'high' ? '高风险，需审批' : '低风险'}
                        {action.approval === 'required' ? ' · 将进入审批队列' : ''}
                      </span>
                    </div>
                    <select
                      aria-label={`${action.label} 的执行参与方`}
                      disabled={!isRunnable}
                      defaultValue={action.participantIds[0]}
                      onChange={(event) => {
                        event.currentTarget.dataset.participantId = event.currentTarget.value;
                      }}
                    >
                      {action.participantIds.map((participantId) => (
                        <option key={participantId} value={participantId}>
                          {participantName(participants, participantId)}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`提交动作 ${action.label}`}
                      title={`提交动作 ${action.label}`}
                      disabled={!isRunnable}
                      onClick={(event) => {
                        const select = event.currentTarget
                          .previousElementSibling as HTMLSelectElement;
                        void submitCommand({
                          endpoint: 'actions',
                          body: {
                            actionType: action.key,
                            participantId: select.value,
                            parameters: {},
                          },
                          label: `提交动作: ${action.label}`,
                        });
                      }}
                    >
                      <Send size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {eventSnapshot.pendingCommands.length > 0 ? (
              <ul className="live-command-list" aria-label="命令状态">
                {eventSnapshot.pendingCommands.slice(-4).map((command) => (
                  <li className={`is-${command.status}`} key={command.id}>
                    <span>{command.label}</span>
                    <strong>
                      {command.status === 'pending'
                        ? '处理中'
                        : command.status === 'accepted'
                          ? '已接受'
                          : '已拒绝'}
                    </strong>
                    {command.message ? <small>{command.message}</small> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {commandError ? (
              <p className="field-error" role="alert">
                {commandError}
              </p>
            ) : null}
          </section>

          <section className="live-approval-panel" aria-labelledby="live-approvals-heading">
            <div className="live-subheading">
              <h3 id="live-approvals-heading">审批队列</h3>
              <span>{pendingApprovals.length} 项待处理</span>
            </div>
            {approvals.length === 0 ? (
              <p className="live-empty-copy">暂无高风险动作等待审批。</p>
            ) : (
              <ul className="live-approval-list">
                {approvals.slice(0, 6).map((approval) => (
                  <li key={approval.id}>
                    <div className="live-approval-title">
                      <div>
                        <strong>{approval.actionType}</strong>
                        <span>
                          {participantName(participants, approval.participantId)} · #
                          {approval.requestedSequence}
                        </span>
                      </div>
                      <strong className={`approval-status is-${approval.status}`}>
                        {approvalStatusLabel(approval.status)}
                      </strong>
                    </div>
                    <p>
                      参数：
                      {Object.keys(approval.parameters).length
                        ? JSON.stringify(approval.parameters)
                        : '无'}
                    </p>
                    <p>
                      证据：
                      {approval.evidence.length
                        ? approval.evidence.map((evidence) => ` #${evidence.sequence}`).join('')
                        : ' 暂无'}
                    </p>
                    {approval.status === 'pending' ? (
                      <div className="live-approval-actions">
                        <button
                          className="button button-primary"
                          type="button"
                          onClick={() => void resolveApproval(approval, 'approved')}
                        >
                          批准
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => void resolveApproval(approval, 'denied')}
                        >
                          拒绝
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
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
                  <span>知识范围</span>
                  <p>
                    {participant.knowledgeScopes.length
                      ? participant.knowledgeScopes.join(' · ')
                      : '无'}
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

function ConnectionBadge({ state, hasGap }: { state: ConnectionState; hasGap: boolean }) {
  const label = hasGap
    ? '正在补齐事件'
    : state === 'connected'
      ? '实时已连接'
      : state === 'recovering'
        ? '正在恢复'
        : state === 'offline'
          ? '离线'
          : '正在连接';
  const Icon = state === 'offline' ? WifiOff : state === 'connected' ? Wifi : RefreshCw;
  return (
    <span className={`live-connection-placeholder is-${state}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

function TimelineEntry({
  item,
  participants,
}: {
  item: TimelineItem;
  participants: readonly LiveParticipant[];
}) {
  if (item.kind === 'trace') {
    return (
      <article className={`timeline-entry is-agent-trace ${traceTone(item.trace.eventType)}`}>
        <span className="timeline-entry-icon">
          <Zap size={15} aria-hidden="true" />
        </span>
        <div>
          <strong>{traceLabel(item.trace.eventType)}</strong>
          <p>
            {item.trace.runParticipantId
              ? participantName(participants, item.trace.runParticipantId)
              : 'Agent Runtime'}
          </p>
        </div>
        <time dateTime={item.trace.recordedAt}>{formatTime(item.trace.recordedAt)}</time>
      </article>
    );
  }

  const event = item.envelope.event;
  const style = eventTone(event.type, event.source);
  return (
    <article className={`timeline-entry ${style}`}>
      <span className="timeline-entry-icon">
        {event.type === 'action.executed' ? (
          <CheckCircle2 size={15} aria-hidden="true" />
        ) : event.type === 'action.proposed' ? (
          <ShieldAlert size={15} aria-hidden="true" />
        ) : (
          <Activity size={15} aria-hidden="true" />
        )}
      </span>
      <div>
        <strong>{eventLabel(event.type)}</strong>
        <p>
          {event.participantId ? `${participantName(participants, event.participantId)} · ` : ''}
          {event.source === 'agent' ? 'Agent' : event.source === 'human' ? 'Human' : '系统'} · #
          {item.envelope.cursor}
        </p>
      </div>
      <time dateTime={event.recordedAt}>{formatTime(event.recordedAt)}</time>
    </article>
  );
}

function toRunContext(run: RunSummary) {
  return {
    status: run.status,
    version: run.version,
    virtualTime: run.virtualTime,
    latestSequence: run.latestSequence,
  };
}

function parseEnvelope(value: string): StreamEnvelope | null {
  try {
    const parsed = JSON.parse(value) as StreamEnvelope;
    return typeof parsed.cursor === 'number' && parsed.event ? parsed : null;
  } catch {
    return null;
  }
}

function pendingApprovalCount(run: RunSummary): number {
  return readStringArray(readRecord(run.data).pendingApprovalIds).length;
}

function approvalStatusLabel(status: Approval['status']): string {
  return {
    pending: '待审批',
    approved: '已批准',
    denied: '已拒绝',
    expired: '已过期',
    stale: '已失效',
  }[status];
}

function newCommandId(): string {
  return crypto.randomUUID();
}

function dedupeTraces(traces: readonly AgentTrace[]): AgentTrace[] {
  const unique = new Map(traces.map((trace) => [trace.id, trace]));
  return [...unique.values()].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt),
  );
}

function participantName(participants: readonly LiveParticipant[], id: string): string {
  return (
    participants.find(
      (participant) => participant.id === id || participant.runtimeParticipantId === id,
    )?.displayName ?? '未知参与方'
  );
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'run.started': '运行已启动',
    'run.paused': '运行已暂停',
    'run.resumed': '运行已继续',
    'clock.advanced': '虚拟时间推进',
    'action.proposed': '动作提议',
    'action.approval_requested': '动作等待审批',
    'action.executed': '动作已执行',
    'action.rejected': '动作被拒绝',
    'inject.triggered': 'Director / 场景注入触发',
    'signal.emitted': '场景信号发出',
    'state.changed': '运行状态更新',
  };
  return labels[type] ?? type;
}

function eventTone(type: string, source: string): string {
  if (type === 'action.executed') return 'is-execution';
  if (type === 'action.proposed' || type === 'action.approval_requested') return 'is-proposal';
  if (source === 'agent') return 'is-agent';
  return 'is-system';
}

function traceLabel(type: string): string {
  if (type.includes('proposal')) return 'Agent 动作提议';
  if (type.includes('message') || type.includes('text')) return 'Agent 发言';
  if (type.includes('validation')) return 'Agent 提议校验';
  return `Agent 轨迹 · ${type}`;
}

function traceTone(type: string): string {
  return type.includes('proposal') ? 'is-proposal' : 'is-agent';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '时间未知'
    : new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date);
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
  if (value === 'active') return '活跃';
  if (value === 'blocked') return '受阻';
  if (value === 'completed') return '已完成';
  return '未激活';
}

function toRateTone(rate: number | undefined): 'healthy' | 'risk' | 'neutral' {
  if (rate === undefined) return 'neutral';
  return rate >= 0.99 ? 'healthy' : 'risk';
}

function toErrorRateTone(rate: number | undefined): 'healthy' | 'risk' | 'neutral' {
  if (rate === undefined) return 'neutral';
  return rate <= 0.01 ? 'healthy' : 'risk';
}
