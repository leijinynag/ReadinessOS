import type { ScenarioPack } from '@readinessos/scenario-sdk';
import type { Effect, ParticipantTemplate } from '@readinessos/simulation-kernel';

export type ScenarioGraphNodeKind = 'participant' | 'action' | 'signal' | 'inject';
export type ScenarioGraphRelationKind =
  'eligible' | 'emits' | 'delivers' | 'schedules' | 'changes-status';

export type ScenarioGraphNode = {
  id: string;
  kind: ScenarioGraphNodeKind;
  label: string;
  detail: string;
  position: { x: number; y: number };
};

export type ScenarioGraphRelation = {
  id: string;
  kind: ScenarioGraphRelationKind;
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  label: string;
};

export type ScenarioGraphDto = {
  packKey: string;
  nodes: ScenarioGraphNode[];
  relations: ScenarioGraphRelation[];
};

const laneX: Record<ScenarioGraphNodeKind, number> = {
  participant: 0,
  action: 300,
  signal: 600,
  inject: 900,
};

export function buildScenarioGraph(pack: ScenarioPack<unknown>): ScenarioGraphDto {
  const participantNodes = pack.participants.map((participant, index) => ({
    id: participantId(participant.id),
    kind: 'participant' as const,
    label: participant.displayName,
    detail: participant.controller,
    position: position('participant', index),
  }));
  const actionNodes = pack.actions.map((action, index) => ({
    id: actionId(action.key),
    kind: 'action' as const,
    label: action.label,
    detail: action.risk === 'high' ? '高风险动作' : '动作',
    position: position('action', index),
  }));
  const signalNodes = pack.signals.map((signal, index) => ({
    id: signalId(signal.key),
    kind: 'signal' as const,
    label: signal.label,
    detail: 'Signal',
    position: position('signal', index),
  }));
  const injectNodes = pack.injects.map((inject, index) => ({
    id: injectId(inject.key),
    kind: 'inject' as const,
    label: inject.key,
    detail: describeTrigger(inject.trigger),
    position: position('inject', index),
  }));
  const nodes = [...participantNodes, ...actionNodes, ...signalNodes, ...injectNodes];
  const nodeLabels = new Map(nodes.map((node) => [node.id, node.label]));
  const relations: ScenarioGraphRelation[] = [];

  for (const participant of pack.participants) {
    for (const action of pack.actions) {
      if (isEligible(participant, action)) {
        addRelation(relations, nodeLabels, {
          id: `eligible:${participant.id}:${action.key}`,
          kind: 'eligible',
          source: participantId(participant.id),
          target: actionId(action.key),
          label: '策略上可执行',
        });
      }
    }
  }

  pack.actions.forEach((action) => {
    addEffectRelations(
      relations,
      nodeLabels,
      actionId(action.key),
      `action:${action.key}`,
      action.effects,
    );
  });
  pack.injects.forEach((inject) => {
    addEffectRelations(
      relations,
      nodeLabels,
      injectId(inject.key),
      `inject:${inject.key}`,
      inject.effects,
    );
  });

  return { packKey: pack.key, nodes, relations };
}

function addEffectRelations(
  relations: ScenarioGraphRelation[],
  labels: ReadonlyMap<string, string>,
  ownerId: string,
  ownerKey: string,
  effects: readonly Effect[],
) {
  effects.forEach((effect, effectIndex) => {
    if (effect.kind === 'emit-signal') {
      const signal = signalId(effect.signalKey);
      addRelation(relations, labels, {
        id: `${ownerKey}:effect:${effectIndex}:emits:${effect.signalKey}`,
        kind: 'emits',
        source: ownerId,
        target: signal,
        label: '发出 Signal',
      });
      effect.recipients.forEach((recipient, recipientIndex) => {
        addRelation(relations, labels, {
          id: `${ownerKey}:effect:${effectIndex}:recipient:${recipientIndex}`,
          kind: 'delivers',
          source: signal,
          target: participantId(recipient),
          label: '投递给',
        });
      });
      return;
    }
    if (effect.kind === 'schedule-inject') {
      addRelation(relations, labels, {
        id: `${ownerKey}:effect:${effectIndex}:schedule:${effect.injectKey}`,
        kind: 'schedules',
        source: ownerId,
        target: injectId(effect.injectKey),
        label: `计划 ${effect.delayMinutes} 分钟后触发`,
      });
      return;
    }
    if (effect.kind === 'change-participant-status') {
      addRelation(relations, labels, {
        id: `${ownerKey}:effect:${effectIndex}:status:${effect.participantId}`,
        kind: 'changes-status',
        source: ownerId,
        target: participantId(effect.participantId),
        label: `状态改为 ${effect.status}`,
      });
    }
  });
}

function addRelation(
  relations: ScenarioGraphRelation[],
  labels: ReadonlyMap<string, string>,
  input: Omit<ScenarioGraphRelation, 'sourceLabel' | 'targetLabel'>,
) {
  const sourceLabel = labels.get(input.source);
  const targetLabel = labels.get(input.target);
  // Pack 通过契约校验后引用应完整；此处仍 fail closed，避免向 React Flow 发送悬空边。
  if (!sourceLabel || !targetLabel) return;
  relations.push({ ...input, sourceLabel, targetLabel });
}

function isEligible(
  participant: ParticipantTemplate,
  action: ScenarioPack<unknown>['actions'][number],
): boolean {
  return (
    containsAll(participant.capabilities, action.requiredCapabilities) &&
    containsAll(participant.permissions, action.requiredPermissions) &&
    containsAll(participant.knowledgeScopes, action.requiredKnowledgeScopes)
  );
}

function containsAll(actual: readonly string[], required: readonly string[] | undefined) {
  return (required ?? []).every((value) => actual.includes(value));
}

function position(kind: ScenarioGraphNodeKind, index: number) {
  return { x: laneX[kind], y: index * 116 };
}

function describeTrigger(trigger: ScenarioPack<unknown>['injects'][number]['trigger']) {
  if (!trigger) return '由动作计划触发';
  if (trigger.kind === 'elapsed-minutes-gte') return `运行 ${trigger.minutes} 分钟后`;
  if (trigger.kind === 'event-occurred') return `事件 ${trigger.eventType}`;
  return '满足场景条件时';
}

function participantId(id: string) {
  return `participant:${id}`;
}
function actionId(key: string) {
  return `action:${key}`;
}
function signalId(key: string) {
  return `signal:${key}`;
}
function injectId(key: string) {
  return `inject:${key}`;
}
