'use client';

import { useMemo, useRef, useState } from 'react';
import { Play, Clock3, Gauge, Hash, RotateCcw, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatDuration } from '@/lib/format';
import type { ScenarioGraphDto } from '@/lib/scenario-graph';
import type { StudioScenarioConfig } from '@/lib/scenario-query';
import { ScenarioGraph } from './scenario-graph';

type StudioDraftProps = {
  scenarioId: string;
  version: number;
  baseline: StudioScenarioConfig;
  graph: ScenarioGraphDto | null;
};

type DraftParticipant = StudioScenarioConfig['participants'][number];
type DraftState = {
  difficulty: StudioScenarioConfig['difficulty'];
  seed: string;
  selectedObjectiveKeys: string[];
  participants: DraftParticipant[];
};

const difficultyOptions = [
  { value: 'beginner', label: '入门' },
  { value: 'intermediate', label: '进阶' },
  { value: 'advanced', label: '高阶' },
] as const;

const controllerOptions = [
  { value: 'human', label: 'Human' },
  { value: 'agent', label: 'Agent' },
  { value: 'system', label: 'System' },
] as const;

export function StudioDraft({ scenarioId, version, baseline, graph }: StudioDraftProps) {
  const router = useRouter();
  const initialDraft = useMemo(() => createDraft(baseline), [baseline]);
  const [draft, setDraft] = useState(initialDraft);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const dirty = !draftEquals(draft, initialDraft);
  const seedError = validateSeed(draft.seed);
  const hasEnabledHuman = draft.participants.some(
    (participant) => participant.enabled && participant.controller === 'human',
  );
  const canStart = seedError === null && hasEnabledHuman && !isStarting;
  const objectiveLabels = new Map(
    baseline.objectives.map((objective) => [objective.key, objective.label]),
  );

  function updateParticipant(
    id: string,
    update: (participant: DraftParticipant) => DraftParticipant,
  ) {
    // 所有编辑仅替换浏览器内草稿；已发布 ScenarioVersion 始终作为只读基线。
    setDraft((current) => ({
      ...current,
      participants: current.participants.map((participant) =>
        participant.id === id ? update(participant) : participant,
      ),
    }));
  }

  async function startRun() {
    if (!canStart) return;

    setSubmitError(null);
    setIsStarting(true);
    const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    try {
      const response = await fetch(`/api/scenarios/${scenarioId}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          difficulty: draft.difficulty,
          seed: Number(draft.seed),
          selectedObjectiveKeys: draft.selectedObjectiveKeys,
          participants: draft.participants.map(({ id, enabled, controller }) => ({
            id,
            enabled,
            controller,
          })),
        }),
      });
      const body = (await response.json()) as {
        run?: { id: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.run) {
        throw new Error(body.error?.message ?? '创建演练失败，请重试。');
      }
      router.push(`/runs/${body.run.id}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '创建演练失败，请重试。');
      setIsStarting(false);
    }
  }

  return (
    <div className="studio-workspace">
      <div className={`draft-status ${dirty ? 'is-dirty' : ''}`} role="status" aria-live="polite">
        <div>
          <strong>{dirty ? '未保存草稿' : `基于已发布 v${version}`}</strong>
          <p>
            {dirty
              ? '修改仅保存在当前浏览器内存中，刷新页面会丢失；尚未创建新的场景版本。'
              : '当前控件与已发布版本一致。开始编辑后，修改不会写入该版本。'}
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={!dirty}
          onClick={() => setDraft(createDraft(baseline))}
        >
          <RotateCcw size={15} aria-hidden="true" /> 重置为已发布版本
        </button>
      </div>
      <div className="studio-run-actions">
        <div>
          <strong>准备开始演练</strong>
          <p>
            {hasEnabledHuman
              ? '开始后会创建新的不可变场景版本并启动一条真实 Run。'
              : '至少需要保留一名已启用的 Human 参与方。'}
          </p>
          {submitError ? (
            <p className="field-error" role="alert">
              {submitError}
            </p>
          ) : null}
        </div>
        <button
          className="button button-primary"
          type="button"
          disabled={!canStart}
          onClick={() => void startRun()}
        >
          <Play size={16} aria-hidden="true" />
          {isStarting ? '正在启动' : '开始演练'}
        </button>
      </div>

      <section aria-labelledby="configuration-heading">
        <h2 className="section-heading" id="configuration-heading">
          演练配置
        </h2>
        <div className="studio-config-grid">
          <div className="studio-control studio-duration">
            <span className="fact-icon">
              <Clock3 size={18} aria-hidden="true" />
            </span>
            <div>
              <span className="control-label">预计时长</span>
              <strong>{formatDuration(baseline.defaultDurationMinutes)}</strong>
            </div>
          </div>

          <fieldset className="studio-control difficulty-control">
            <legend>
              <Gauge size={18} aria-hidden="true" /> 难度
            </legend>
            <div className="segmented-control">
              {difficultyOptions.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="difficulty"
                    value={option.value}
                    checked={draft.difficulty === option.value}
                    onChange={() =>
                      setDraft((current) => ({ ...current, difficulty: option.value }))
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="studio-control seed-control">
            <label htmlFor="studio-seed">
              <Hash size={18} aria-hidden="true" /> 随机种子
            </label>
            <input
              id="studio-seed"
              aria-label="随机种子"
              type="number"
              min="0"
              max="2147483647"
              step="1"
              value={draft.seed}
              aria-describedby={seedError ? 'studio-seed-error' : 'studio-seed-help'}
              aria-invalid={seedError !== null}
              onChange={(event) => {
                const seed = event.currentTarget.value;
                setDraft((current) => ({ ...current, seed }));
              }}
            />
            {seedError ? (
              <span className="field-error" id="studio-seed-error">
                {seedError}
              </span>
            ) : (
              <span className="field-help" id="studio-seed-help">
                使用相同种子可复现确定性演练。
              </span>
            )}
          </div>

          <div className="studio-control studio-participant-count">
            <span className="fact-icon">
              <Users size={18} aria-hidden="true" />
            </span>
            <div>
              <span className="control-label">已启用参与方</span>
              <strong>
                {draft.participants.filter((participant) => participant.enabled).length} /{' '}
                {draft.participants.length}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="objectives-heading">
        <h2 className="section-heading" id="objectives-heading">
          演练目标
        </h2>
        {baseline.objectives.length === 0 ? (
          <div className="empty-state">该场景版本暂未配置演练目标。</div>
        ) : (
          <fieldset className="objective-options">
            <legend className="sr-only">选择演练目标</legend>
            {baseline.objectives.map((objective, index) => {
              const checked = draft.selectedObjectiveKeys.includes(objective.key);
              return (
                <label className="objective-option" key={objective.key}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setDraft((current) => ({
                        ...current,
                        selectedObjectiveKeys: checked
                          ? [...current.selectedObjectiveKeys, objective.key]
                          : current.selectedObjectiveKeys.filter((key) => key !== objective.key),
                      }));
                    }}
                  />
                  <span className="objective-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span>
                    <strong>{objective.label}</strong>
                    {objective.description ? <small>{objective.description}</small> : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
      </section>

      <section aria-labelledby="participants-heading">
        <div className="section-title-row">
          <div>
            <h2 className="section-heading" id="participants-heading">
              参与方草稿配置
            </h2>
            <p>启停与 Controller 修改仅属于当前未保存草稿，权限和可见范围保持只读。</p>
          </div>
          <span className="detail-count">{draft.participants.length} 个参与方</span>
        </div>

        {draft.participants.length === 0 ? (
          <div className="empty-state">该场景版本暂未配置参与方。</div>
        ) : (
          <div className="participant-list">
            {draft.participants.map((participant) => (
              <article
                className={`participant-card participant-editor ${participant.enabled ? '' : 'is-disabled'}`}
                key={participant.id}
              >
                <header>
                  <div>
                    <h3>{participant.displayName}</h3>
                    <p>{participant.key}</p>
                  </div>
                  <label className="participant-toggle">
                    <input
                      type="checkbox"
                      checked={participant.enabled}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        updateParticipant(participant.id, (current) => ({
                          ...current,
                          enabled,
                        }));
                      }}
                    />
                    <span>{participant.enabled ? '已启用' : '已停用'}</span>
                  </label>
                </header>

                <div className="participant-controller">
                  <label htmlFor={`controller-${participant.id}`}>Controller</label>
                  <select
                    id={`controller-${participant.id}`}
                    value={participant.controller}
                    onChange={(event) => {
                      const controller = event.currentTarget
                        .value as DraftParticipant['controller'];
                      updateParticipant(participant.id, (current) => ({ ...current, controller }));
                    }}
                  >
                    {controllerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <DetailTags label="目标" values={participant.objectives} labels={objectiveLabels} />
                <DetailTags label="Capabilities" values={participant.capabilities} />
                <DetailTags label="Knowledge Scopes" values={participant.knowledgeScopes} />
                <DetailTags label="Permissions" values={participant.permissions} />
              </article>
            ))}
          </div>
        )}
      </section>

      <ScenarioGraph graph={graph} />
    </div>
  );
}

function createDraft(baseline: StudioScenarioConfig): DraftState {
  return {
    difficulty: baseline.difficulty,
    seed: String(baseline.defaultSeed),
    selectedObjectiveKeys: baseline.objectives.map((objective) => objective.key),
    participants: baseline.participants.map((participant) => ({
      ...participant,
      capabilities: [...participant.capabilities],
      permissions: [...participant.permissions],
      knowledgeScopes: [...participant.knowledgeScopes],
      objectives: [...participant.objectives],
    })),
  };
}

function draftEquals(left: DraftState, right: DraftState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSeed(seed: string): string | null {
  if (seed.trim() === '') return '请输入随机种子。';
  const value = Number(seed);
  if (!Number.isInteger(value)) return '随机种子必须是整数。';
  if (value < 0 || value > 2_147_483_647) return '随机种子必须介于 0 和 2147483647 之间。';
  return null;
}

function DetailTags({
  label,
  values,
  labels,
}: Readonly<{ label: string; values: string[]; labels?: ReadonlyMap<string, string> }>) {
  return (
    <div className="participant-detail">
      <h4>{label}</h4>
      {values.length === 0 ? (
        <span className="muted-value">无</span>
      ) : (
        <ul className="tag-list" aria-label={`${label} 列表`}>
          {values.map((value) => (
            <li key={value}>{labels?.get(value) ?? value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
