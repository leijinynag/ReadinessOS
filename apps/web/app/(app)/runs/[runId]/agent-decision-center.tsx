'use client';

import {
  Check,
  ChevronDown,
  Clock3,
  GitCompareArrows,
  HelpCircle,
  Pencil,
  RefreshCw,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  AgentDecisionCenterProps,
  AgentQuestion,
  AgentRecommendation,
  RecommendationDecisionInput,
} from './live-agent-types';

export function AgentDecisionCenter({
  run,
  participants,
  advisors,
  recommendations,
  questions,
  onRequestAnalysis,
  onDecision,
  onAnswerQuestion,
}: AgentDecisionCenterProps) {
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [editingRecommendationId, setEditingRecommendationId] = useState<string | null>(null);
  const [selectedActionIds, setSelectedActionIds] = useState<Record<string, string>>({});
  const [parameterTexts, setParameterTexts] = useState<Record<string, string>>({});
  const [questionInputs, setQuestionInputs] = useState<
    Record<string, { optionId?: string; text?: string }>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pendingRecommendations = useMemo(
    () => recommendations.filter((recommendation) => recommendation.status === 'pending'),
    [recommendations],
  );
  const unansweredQuestions = useMemo(
    () => questions.filter((question) => question.answeredAt === undefined),
    [questions],
  );
  const advisorActions = useMemo(
    () => new Map(advisors.map((advisor) => [advisor.participantId, advisor.actions])),
    [advisors],
  );

  async function runBusy(id: string, callback: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await callback();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求未完成。');
    } finally {
      setBusyId(null);
    }
  }

  async function decide(input: RecommendationDecisionInput) {
    await runBusy(`decision:${input.recommendationId}`, () => onDecision(input));
  }

  function openModification(recommendation: AgentRecommendation) {
    const permitted = advisorActions.get(recommendation.advisorParticipantId) ?? [];
    const current = permitted.find(
      (action) =>
        action.targetParticipantId === recommendation.targetParticipantId &&
        action.actionType === recommendation.actionType,
    );
    setSelectedActionIds((currentValues) => ({
      ...currentValues,
      [recommendation.id]: current ? actionId(current) : actionId(permitted[0]),
    }));
    setParameterTexts((currentValues) => ({
      ...currentValues,
      [recommendation.id]: JSON.stringify(recommendation.parameters, null, 2),
    }));
    setEditingRecommendationId(recommendation.id);
    setError(null);
  }

  async function submitModification(recommendation: AgentRecommendation) {
    const actions = advisorActions.get(recommendation.advisorParticipantId) ?? [];
    const selectedId = selectedActionIds[recommendation.id] ?? actionId(actions[0]);
    const action = actions.find((candidate) => actionId(candidate) === selectedId);
    if (!action) {
      setError('该角色当前没有可修改为的授权动作。');
      return;
    }
    let parameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(parameterTexts[recommendation.id] ?? '{}') as unknown;
      if (!isRecord(parsed)) throw new Error('not a record');
      parameters = parsed;
    } catch {
      setError('动作参数必须是合法的 JSON 对象。');
      return;
    }
    await decide({
      recommendationId: recommendation.id,
      decision: 'modify',
      ...optionalRationale(rationales[recommendation.id]),
      modifiedAction: {
        targetParticipantId: action.targetParticipantId,
        actionType: action.actionType,
        parameters,
      },
    });
    setEditingRecommendationId(null);
  }

  return (
    <section className="agent-decision-center" aria-labelledby="agent-decision-heading">
      <header className="agent-decision-header">
        <div>
          <p className="eyebrow">IC Decision Center</p>
          <h2 id="agent-decision-heading">Agent 建议与裁决</h2>
          <p>
            Agent 只基于角色可见事实提出一项建议。只有 IC 采纳后，当前 Human 才会通过 Kernel
            提交动作；高风险动作仍进入审批。
          </p>
        </div>
        <div className="agent-decision-counts" aria-label="Agent 决策状态">
          <span>{pendingRecommendations.length} 项待裁决</span>
          <span>{unansweredQuestions.length} 项待补充</span>
        </div>
      </header>

      {error ? (
        <p className="field-error agent-decision-error" role="alert">
          {error}
        </p>
      ) : null}

      {unansweredQuestions.length > 0 ? (
        <section className="agent-question-list" aria-labelledby="agent-questions-heading">
          <div className="agent-subheading">
            <HelpCircle size={16} aria-hidden="true" />
            <h3 id="agent-questions-heading">Agent 请求补充事实</h3>
          </div>
          {unansweredQuestions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              input={questionInputs[question.id] ?? {}}
              busy={busyId === `question:${question.id}`}
              onChange={(next) =>
                setQuestionInputs((current) => ({
                  ...current,
                  [question.id]: { ...current[question.id], ...next },
                }))
              }
              onSubmit={() =>
                runBusy(`question:${question.id}`, async () => {
                  const answer = questionInputs[question.id] ?? {};
                  if (!answer.optionId && !answer.text?.trim()) {
                    throw new Error('请选择或填写对该问题的回答。');
                  }
                  await onAnswerQuestion({
                    questionId: question.id,
                    ...(answer.optionId === undefined ? {} : { optionId: answer.optionId }),
                    ...(answer.text?.trim() ? { text: answer.text.trim() } : {}),
                  });
                })
              }
            />
          ))}
        </section>
      ) : null}

      <div className="agent-recommendation-list">
        {recommendations.length === 0 ? (
          <div className="agent-decision-empty">
            <ShieldAlert size={20} aria-hidden="true" />
            <strong>等待 Agent 分析</strong>
            <p>
              启动演练或触发场景事件后，相关角色会依次基于当前事实提出建议。也可在参与方检查器中手动请求分析。
            </p>
          </div>
        ) : (
          recommendations.map((recommendation) => {
            const isPending = recommendation.status === 'pending';
            const target = participants.find(
              (participant) => participant.id === recommendation.targetParticipantId,
            );
            const allowedActions = advisorActions.get(recommendation.advisorParticipantId) ?? [];
            const action = allowedActions.find(
              (candidate) =>
                candidate.targetParticipantId === recommendation.targetParticipantId &&
                candidate.actionType === recommendation.actionType,
            );
            const editing = editingRecommendationId === recommendation.id;
            return (
              <article
                className={`agent-recommendation-card is-${recommendation.status}`}
                key={recommendation.id}
              >
                <div className="agent-recommendation-title">
                  <div>
                    <span className="agent-role-label">{recommendation.advisorDisplayName}</span>
                    <h3>{action?.actionLabel ?? recommendation.actionType}</h3>
                    <p>
                      建议由 <strong>{target?.displayName ?? '未知参与方'}</strong> 执行
                      {action?.approval === 'required' ? '，采纳后需进入审批队列。' : '。'}
                    </p>
                  </div>
                  <span className={`agent-recommendation-status is-${recommendation.status}`}>
                    {statusLabel(recommendation.status)}
                  </span>
                </div>

                <p className="agent-recommendation-rationale">{recommendation.rationale}</p>
                <dl className="agent-recommendation-facts">
                  <div>
                    <dt>置信度</dt>
                    <dd>{Math.round(recommendation.confidence * 100)}%</dd>
                  </div>
                  <div>
                    <dt>事实版本</dt>
                    <dd>
                      v{recommendation.baseRunVersion} · T+{recommendation.baseVirtualTime}
                    </dd>
                  </div>
                  <div>
                    <dt>失效时间</dt>
                    <dd>T+{recommendation.expiresAtVirtualTime}</dd>
                  </div>
                  <div>
                    <dt>触发证据</dt>
                    <dd>
                      {recommendation.triggerSequences.length
                        ? recommendation.triggerSequences
                            .map((sequence) => `#${sequence}`)
                            .join(' ')
                        : recommendation.triggerEventTypes.join(' · ') || 'IC 主动请求'}
                    </dd>
                  </div>
                </dl>
                {recommendation.evidenceRefs.length > 0 ? (
                  <p className="agent-evidence">证据：{recommendation.evidenceRefs.join(' · ')}</p>
                ) : null}
                {Object.keys(recommendation.parameters).length > 0 ? (
                  <details className="agent-parameters">
                    <summary>
                      查看动作参数 <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <pre>{JSON.stringify(recommendation.parameters, null, 2)}</pre>
                  </details>
                ) : null}

                {isPending ? (
                  <div className="agent-decision-controls">
                    <label>
                      <span>IC 裁决说明</span>
                      <textarea
                        value={rationales[recommendation.id] ?? ''}
                        onChange={(event) =>
                          setRationales((current) => ({
                            ...current,
                            [recommendation.id]: event.target.value,
                          }))
                        }
                        placeholder="记录采纳、修改、拒绝或延后的理由"
                      />
                    </label>
                    <div className="agent-decision-actions">
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={busyId !== null || run.status !== 'running'}
                        onClick={() =>
                          void decide({
                            recommendationId: recommendation.id,
                            decision: 'adopt',
                            ...optionalRationale(rationales[recommendation.id]),
                          })
                        }
                      >
                        <Check size={15} aria-hidden="true" /> 采纳并提交
                      </button>
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busyId !== null || allowedActions.length === 0}
                        onClick={() => openModification(recommendation)}
                      >
                        <Pencil size={15} aria-hidden="true" /> 修改
                      </button>
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busyId !== null}
                        onClick={() =>
                          void decide({
                            recommendationId: recommendation.id,
                            decision: 'reject',
                            ...optionalRationale(rationales[recommendation.id]),
                          })
                        }
                      >
                        <X size={15} aria-hidden="true" /> 拒绝
                      </button>
                      <span className="agent-defer-label">
                        <Clock3 size={14} aria-hidden="true" /> 延后
                      </span>
                      {([1, 3, 5] as const).map((minutes) => (
                        <button
                          className="agent-defer-button"
                          type="button"
                          key={minutes}
                          disabled={busyId !== null}
                          onClick={() =>
                            void decide({
                              recommendationId: recommendation.id,
                              decision: 'defer',
                              deferMinutes: minutes,
                              ...optionalRationale(rationales[recommendation.id]),
                            })
                          }
                        >
                          {minutes} 分
                        </button>
                      ))}
                    </div>
                    {editing ? (
                      <section className="agent-modification-form" aria-label="修改建议动作">
                        <div className="agent-subheading">
                          <Pencil size={15} aria-hidden="true" />
                          <h4>修改后的动作</h4>
                        </div>
                        <label>
                          <span>授权动作</span>
                          <select
                            value={
                              selectedActionIds[recommendation.id] ?? actionId(allowedActions[0])
                            }
                            onChange={(event) =>
                              setSelectedActionIds((current) => ({
                                ...current,
                                [recommendation.id]: event.target.value,
                              }))
                            }
                          >
                            {allowedActions.map((candidate) => (
                              <option value={actionId(candidate)} key={actionId(candidate)}>
                                {candidate.targetDisplayName} · {candidate.actionLabel}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>动作参数（JSON 对象）</span>
                          <textarea
                            className="agent-parameter-input"
                            value={
                              parameterTexts[recommendation.id] ??
                              JSON.stringify(recommendation.parameters, null, 2)
                            }
                            onChange={(event) =>
                              setParameterTexts((current) => ({
                                ...current,
                                [recommendation.id]: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <div>
                          <button
                            className="button button-primary"
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void submitModification(recommendation)}
                          >
                            <Send size={15} aria-hidden="true" /> 提交修改后的动作
                          </button>
                          <button
                            className="button button-secondary"
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => setEditingRecommendationId(null)}
                          >
                            取消
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      <div className="agent-analysis-shortcuts" aria-label="Agent 分析操作">
        {advisors.map((advisor) => {
          const participant = participants.find(
            (candidate) => candidate.id === advisor.participantId,
          );
          return (
            <div key={advisor.participantId}>
              <span>{participant?.displayName ?? 'Agent 顾问'}</span>
              <button
                className="icon-button"
                type="button"
                title={`请求 ${participant?.displayName ?? 'Agent'} 重新分析`}
                aria-label={`请求 ${participant?.displayName ?? 'Agent'} 重新分析`}
                disabled={busyId !== null || run.status !== 'running'}
                onClick={() =>
                  void runBusy(`reanalyze:${advisor.participantId}`, () =>
                    onRequestAnalysis(advisor.participantId, 'reanalyze'),
                  )
                }
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                type="button"
                title={`请求 ${participant?.displayName ?? 'Agent'} 比较方案`}
                aria-label={`请求 ${participant?.displayName ?? 'Agent'} 比较方案`}
                disabled={busyId !== null || run.status !== 'running'}
                onClick={() =>
                  void runBusy(`compare:${advisor.participantId}`, () =>
                    onRequestAnalysis(advisor.participantId, 'compare'),
                  )
                }
              >
                <GitCompareArrows size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function QuestionCard({
  question,
  input,
  busy,
  onChange,
  onSubmit,
}: {
  question: AgentQuestion;
  input: { optionId?: string; text?: string };
  busy: boolean;
  onChange(input: { optionId?: string; text?: string }): void;
  onSubmit(): void;
}) {
  return (
    <article className="agent-question-card">
      <p>{question.prompt}</p>
      {question.options.length > 0 ? (
        <div className="agent-question-options">
          {question.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name={question.id}
                checked={input.optionId === option.id}
                onChange={() => onChange({ optionId: option.id })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
      {question.allowFreeform ? (
        <textarea
          value={input.text ?? ''}
          onChange={(event) => onChange({ text: event.target.value })}
          placeholder="补充关键事实"
        />
      ) : null}
      <button className="button button-secondary" type="button" disabled={busy} onClick={onSubmit}>
        <Send size={14} aria-hidden="true" /> 发送事实补充
      </button>
    </article>
  );
}

function statusLabel(status: AgentRecommendation['status']): string {
  return {
    pending: '待裁决',
    adopted: '已采纳',
    modified: '已修改',
    rejected: '已拒绝',
    deferred: '已延后',
    superseded: '事实已变化',
    expired: '已过期',
  }[status];
}

function actionId(value: { targetParticipantId: string; actionType: string } | undefined): string {
  return value ? `${value.targetParticipantId}:${value.actionType}` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalRationale(
  value: string | undefined,
): Pick<RecommendationDecisionInput, 'rationale'> {
  const rationale = value?.trim();
  return rationale ? { rationale } : {};
}
