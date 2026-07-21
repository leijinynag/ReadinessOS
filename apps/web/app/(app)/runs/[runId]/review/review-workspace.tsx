'use client';

import { CheckCircle2, ExternalLink, GitBranch, RotateCcw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { ReviewSummary } from '@readinessos/application';

type ReviewWorkspaceProps = {
  initialReview: ReviewSummary;
};

export function ReviewWorkspace({ initialReview }: ReviewWorkspaceProps) {
  const [review, setReview] = useState(initialReview);
  const [selectedSequence, setSelectedSequence] = useState(review.run.latestSequence);
  const [replay, setReplay] = useState<Record<string, unknown> | null>(null);
  const [loadingReplay, setLoadingReplay] = useState(false);
  const [remediationTitle, setRemediationTitle] = useState('');
  const [remediationDescription, setRemediationDescription] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branching, setBranching] = useState(false);
  const [branchUrl, setBranchUrl] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const latestScores = useMemo(() => {
    const deduped = new Map<string, (typeof review.evaluations)[number]>();
    for (const evaluation of review.evaluations) {
      if (!deduped.has(evaluation.evaluatorKey)) deduped.set(evaluation.evaluatorKey, evaluation);
    }
    return [...deduped.values()];
  }, [review]);
  const timelineVirtualizer = useVirtualizer({
    count: review.timeline.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: () => 70,
    overscan: 10,
  });

  async function replayTo(sequence: number) {
    setSelectedSequence(sequence);
    setLoadingReplay(true);
    try {
      const response = await fetch(`/api/runs/${review.run.id}/replay?sequence=${sequence}`, {
        cache: 'no-store',
      });
      const body = (await response.json()) as { replay?: { state?: Record<string, unknown> } };
      if (response.ok && body.replay?.state) setReplay(body.replay.state);
    } finally {
      setLoadingReplay(false);
    }
  }

  async function createRemediation() {
    if (!remediationTitle.trim() || !remediationDescription.trim()) return;
    const response = await fetch(`/api/runs/${review.run.id}/remediations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: remediationTitle,
        description: remediationDescription,
      }),
    });
    if (!response.ok) return;
    setRemediationTitle('');
    setRemediationDescription('');
    const refreshed = await fetch(`/api/runs/${review.run.id}/review`, { cache: 'no-store' });
    const body = (await refreshed.json()) as { review?: ReviewSummary };
    if (body.review) setReview(body.review);
  }

  async function updateRemediation(itemId: string, status: 'open' | 'in_progress' | 'resolved') {
    await fetch(`/api/runs/${review.run.id}/remediations/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const refreshed = await fetch(`/api/runs/${review.run.id}/review`, { cache: 'no-store' });
    const body = (await refreshed.json()) as { review?: ReviewSummary };
    if (body.review) setReview(body.review);
  }

  async function createBranch() {
    if (!branchName.trim()) return;
    setBranching(true);
    setBranchUrl(null);
    try {
      const response = await fetch(`/api/runs/${review.run.id}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${review.run.version}"`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ sequence: selectedSequence, name: branchName }),
      });
      const body = (await response.json()) as { branch?: { id: string } };
      if (response.ok && body.branch) {
        setBranchUrl(`/runs/${body.branch.id}`);
        setBranchName('');
        const refreshed = await fetch(`/api/runs/${review.run.id}/review`, { cache: 'no-store' });
        const refreshedBody = (await refreshed.json()) as { review?: ReviewSummary };
        if (refreshedBody.review) setReview(refreshedBody.review);
      }
    } finally {
      setBranching(false);
    }
  }

  return (
    <main className="page-content review-page">
      <header className="review-header">
        <div>
          <p className="eyebrow">Review · 复盘工作台</p>
          <h1>演练复盘</h1>
          <p className="page-lede">
            评分、决策、审批与时间线均来自同一条权威事件流，可回放任意已持久化 sequence。
          </p>
        </div>
        <a className="button button-secondary" href={`/runs/${review.run.id}`}>
          返回实时运行 <ExternalLink size={15} aria-hidden="true" />
        </a>
      </header>

      <section className="review-score-grid" aria-label="评估评分">
        {latestScores.map((evaluation) => (
          <article key={evaluation.id}>
            <span>{evaluation.evaluatorKey}</span>
            <strong>{Math.round(evaluation.score)}</strong>
            <p>{evaluation.summary}</p>
            <div>
              {evaluation.evidence.map((evidence) => (
                <button
                  type="button"
                  key={evidence.id}
                  onClick={() => void replayTo(evidence.sequence)}
                  title={`回放到事件 #${evidence.sequence}`}
                >
                  证据 #{evidence.sequence}
                </button>
              ))}
            </div>
          </article>
        ))}
      </section>

      <section className="review-agent-causal-chain" aria-labelledby="review-agent-chain-heading">
        <div className="review-section-heading">
          <div>
            <p className="eyebrow">Agent Causality</p>
            <h2 id="review-agent-chain-heading">Agent 因果链</h2>
          </div>
          <span>Agent 审计层不参与 Kernel 回放</span>
        </div>
        {review.agentCausalChain.length === 0 ? (
          <p className="review-agent-empty">
            本次演练尚未形成 Agent 建议。启动运行并触发事件后，相关角色会形成可裁决的结构化建议。
          </p>
        ) : (
          <ol className="review-agent-chain-list">
            {review.agentCausalChain.map((item) => (
              <li key={item.recommendationId}>
                <article>
                  <header>
                    <div>
                      <span className="review-agent-role">{item.advisorDisplayName}</span>
                      <h3>{item.actionType}</h3>
                      <p>
                        建议 <strong>{item.targetDisplayName}</strong> 执行 · 置信度{' '}
                        {Math.round(item.confidence * 100)}%
                      </p>
                    </div>
                    <span className={`review-agent-status is-${item.status}`}>
                      {recommendationStatusLabel(item.status)}
                    </span>
                  </header>
                  <p className="review-agent-rationale">{item.rationale}</p>
                  <dl>
                    <div>
                      <dt>触发事实</dt>
                      <dd>
                        {item.triggerSequences.length > 0
                          ? item.triggerSequences.map((sequence) => (
                              <button
                                type="button"
                                key={sequence}
                                onClick={() => void replayTo(sequence)}
                              >
                                #{sequence}
                              </button>
                            ))
                          : item.triggerEventTypes.join(' · ') || 'IC 主动请求'}
                      </dd>
                    </div>
                    <div>
                      <dt>事实基线</dt>
                      <dd>
                        v{item.baseRunVersion} · T+{item.baseVirtualTime} · 到期 T+
                        {item.expiresAtVirtualTime}
                      </dd>
                    </div>
                    <div>
                      <dt>IC 裁决</dt>
                      <dd>
                        {item.decision ? (
                          <>
                            {agentDecisionLabel(item.decision.type)}
                            {item.decision.actorName ? ` · ${item.decision.actorName}` : ''}
                            {item.decision.executionSequence
                              ? ` · Kernel #${item.decision.executionSequence}`
                              : ' · 未改变 WorldState'}
                          </>
                        ) : (
                          '尚未裁决'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>后续结果</dt>
                      <dd>
                        {item.subsequentEvents.length > 0
                          ? item.subsequentEvents.slice(0, 4).map((event) => (
                              <button
                                type="button"
                                key={event.sequence}
                                onClick={() => void replayTo(event.sequence)}
                              >
                                #{event.sequence} {event.type}
                              </button>
                            ))
                          : '暂无领域后果'}
                      </dd>
                    </div>
                  </dl>
                  {item.decision?.rationale ? (
                    <p className="review-agent-decision-rationale">
                      IC 理由：{item.decision.rationale}
                    </p>
                  ) : null}
                  {item.subsequentEvaluations.length > 0 ? (
                    <p className="review-agent-evaluations">
                      后续评分：
                      {item.subsequentEvaluations
                        .slice(0, 3)
                        .map(
                          (evaluation) =>
                            ` ${evaluation.evaluatorKey} ${Math.round(evaluation.score)}`,
                        )
                        .join(' · ')}
                    </p>
                  ) : null}
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="review-grid">
        <section className="review-timeline" aria-labelledby="review-timeline-heading">
          <div className="review-section-heading">
            <div>
              <p className="eyebrow">Timeline</p>
              <h2 id="review-timeline-heading">事件与因果链</h2>
            </div>
            <span>#{review.timeline.length} events</span>
          </div>
          <div ref={timelineRef} className="review-timeline-scroll" aria-label="复盘事件时间线">
            <ol
              className="review-timeline-virtual"
              style={{ height: `${timelineVirtualizer.getTotalSize()}px` }}
            >
              {timelineVirtualizer.getVirtualItems().map((virtualItem) => {
                const event = review.timeline[virtualItem.index];
                if (!event) return null;

                return (
                  <li
                    key={event.sequence}
                    className={selectedSequence === event.sequence ? 'is-selected' : ''}
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <button type="button" onClick={() => void replayTo(event.sequence)}>
                      <span>#{event.sequence}</span>
                      <strong>{event.type}</strong>
                      <small>
                        {event.source} · T+{new Date(event.simulatedAt).toISOString()}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <aside className="review-inspector">
          <section>
            <div className="review-section-heading">
              <div>
                <p className="eyebrow">Replay</p>
                <h2>状态检查器</h2>
              </div>
              <RotateCcw size={17} aria-hidden="true" />
            </div>
            <p>当前 sequence #{selectedSequence}</p>
            <pre>
              {loadingReplay
                ? '正在回放…'
                : JSON.stringify(replay, null, 2) || '选择时间线事件查看状态。'}
            </pre>
          </section>

          <section>
            <div className="review-section-heading">
              <div>
                <p className="eyebrow">Decisions</p>
                <h2>审批与决策</h2>
              </div>
              <CheckCircle2 size={17} aria-hidden="true" />
            </div>
            <ul className="review-decision-list">
              {review.decisions.map((decision) => (
                <li key={decision.id}>
                  <strong>{decision.decision}</strong>
                  <span>
                    #{decision.sequence} · {decision.actorName ?? '系统'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="review-section-heading">
              <div>
                <p className="eyebrow">Branch</p>
                <h2>分支关系</h2>
              </div>
              <GitBranch size={17} aria-hidden="true" />
            </div>
            <p>
              {review.branch.parentRunId
                ? `来源 Run：${review.branch.parentRunId} · #${review.branch.branchFromSequence}`
                : `已创建 ${review.branch.childRunIds.length} 个分支`}
            </p>
            {!review.branch.parentRunId ? (
              <div className="review-branch-form">
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder={`从 #${selectedSequence} 创建分支`}
                />
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void createBranch()}
                  disabled={branching || !branchName.trim()}
                >
                  <GitBranch size={15} aria-hidden="true" /> 创建分支
                </button>
                {branchUrl ? <a href={branchUrl}>打开新分支</a> : null}
              </div>
            ) : null}
            {review.branch.comparison ? (
              <div className="review-branch-diff">
                <p>
                  与父 Run 对比：T {review.branch.comparison.virtualTime.parent} →{' '}
                  {review.branch.comparison.virtualTime.branch}，事件{' '}
                  {review.branch.comparison.eventCounts.parentAfterBranch} →{' '}
                  {review.branch.comparison.eventCounts.branch}。
                </p>
                <ul>
                  {review.branch.comparison.significantEvents.map((event) => (
                    <li key={event.type}>
                      {event.type}: {event.parentCount} → {event.branchCount}
                    </li>
                  ))}
                </ul>
                <ul>
                  {review.branch.comparison.evaluationChanges.map((score) => (
                    <li key={score.evaluatorKey}>
                      {score.evaluatorKey}: {score.parentScore ?? '-'} → {score.branchScore ?? '-'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="review-remediations">
            <div className="review-section-heading">
              <div>
                <p className="eyebrow">Remediation</p>
                <h2>整改项</h2>
              </div>
            </div>
            <div className="review-remediation-form">
              <input
                value={remediationTitle}
                onChange={(event) => setRemediationTitle(event.target.value)}
                placeholder="整改标题"
              />
              <textarea
                value={remediationDescription}
                onChange={(event) => setRemediationDescription(event.target.value)}
                placeholder="整改说明"
              />
              <button
                className="button button-primary"
                type="button"
                onClick={() => void createRemediation()}
              >
                新增整改
              </button>
            </div>
            <ul className="review-remediation-list">
              {review.remediationItems.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                  </div>
                  <select
                    aria-label={`${item.title} 的状态`}
                    value={item.status}
                    onChange={(event) =>
                      void updateRemediation(
                        item.id,
                        event.target.value as 'open' | 'in_progress' | 'resolved',
                      )
                    }
                  >
                    <option value="open">待处理</option>
                    <option value="in_progress">进行中</option>
                    <option value="resolved">已完成</option>
                  </select>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}

function recommendationStatusLabel(status: string): string {
  return {
    pending: '待裁决',
    adopted: '已采纳',
    modified: '已修改',
    rejected: '已拒绝',
    deferred: '已延后',
    superseded: '事实已变化',
    expired: '已到期',
  }[status] ?? status;
}

function agentDecisionLabel(type: 'adopt' | 'modify' | 'reject' | 'defer'): string {
  return {
    adopt: '采纳',
    modify: '修改后采纳',
    reject: '拒绝',
    defer: '延后',
  }[type];
}
