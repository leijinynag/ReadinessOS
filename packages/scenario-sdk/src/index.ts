import {
  type ActionDefinition,
  type EvaluatorDefinition,
  type InjectDefinition,
  type ParticipantTemplate,
  type ScenarioDefinition,
  type SignalDefinition,
  validateScenarioDefinition,
} from '@readinessos/simulation-kernel';
import { z } from 'zod';

export interface PackManifest {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly estimatedDurationMinutes: number;
}

export interface UIContribution {
  readonly key: string;
  readonly label: string;
  readonly statePath: readonly string[];
}

/**
 * Agent Policy 只说明角色可以建议什么，不会向 Agent 授予任何执行权限。
 * Kernel 仍会对目标参与方的权限、前置条件与审批策略做最终裁决。
 */
export interface AgentRecommendationPermission {
  readonly targetParticipantKey: string;
  readonly actionType: string;
}

export interface AgentAdvisorPolicy {
  readonly advisorParticipantKey: string;
  readonly triggerEventTypes: readonly string[];
  readonly recommendationPermissions: readonly AgentRecommendationPermission[];
}

export interface AgentPolicy {
  readonly advisors: readonly AgentAdvisorPolicy[];
}

export interface ScenarioPack<TState> extends ScenarioDefinition<TState> {
  readonly manifest: PackManifest;
  readonly stateSchema: z.ZodType<TState>;
  readonly participants: readonly ParticipantTemplate[];
  readonly actions: readonly ActionDefinition<TState>[];
  readonly signals: readonly SignalDefinition[];
  readonly injects: readonly InjectDefinition<TState>[];
  readonly evaluators: readonly EvaluatorDefinition<TState>[];
  readonly uiContributions: readonly UIContribution[];
  readonly agentPolicy?: AgentPolicy;
}

export interface ScenarioPackContractResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * 所有 Pack 在装载前都通过相同的契约检查。此处只检查声明和确定性边界，
 * 不读取数据库，也不允许引入 Web、Prisma 或 Agent Runtime。
 */
export function validateScenarioPack<TState>(
  pack: ScenarioPack<TState>,
): ScenarioPackContractResult {
  const runtimeValidation = validateScenarioDefinition(pack);
  const errors = [...runtimeValidation.errors];

  if (!pack.manifest.key || pack.manifest.key !== pack.key) {
    errors.push('manifest.key 必须与 Scenario Pack key 一致。');
  }
  if (!pack.manifest.name || pack.manifest.version <= 0) {
    errors.push('manifest 必须包含名称和正整数版本。');
  }
  if (
    !Number.isInteger(pack.manifest.estimatedDurationMinutes) ||
    pack.manifest.estimatedDurationMinutes <= 0
  ) {
    errors.push('manifest.estimatedDurationMinutes 必须是正整数。');
  }

  const contributionKeys = new Set<string>();
  const initialState = pack.initialState({});
  for (const contribution of pack.uiContributions) {
    if (contributionKeys.has(contribution.key)) {
      errors.push(`UI Contribution key 重复：${contribution.key}。`);
    }
    contributionKeys.add(contribution.key);
    if (!contribution.label) {
      errors.push(`UI Contribution ${contribution.key} 必须包含 label。`);
    }
    if (
      contribution.statePath.length === 0 ||
      contribution.statePath.some((part) => !isSafePathPart(part))
    ) {
      errors.push(`UI Contribution ${contribution.key} 包含不安全或为空的 State path。`);
    } else if (!hasPath(initialState, contribution.statePath)) {
      errors.push(
        `UI Contribution ${contribution.key} 引用了不存在的 State path：${contribution.statePath.join('.')}。`,
      );
    }
  }

  if (pack.agentPolicy) {
    const participants = new Map(pack.participants.map((participant) => [participant.key, participant]));
    const actions = new Map(pack.actions.map((action) => [action.key, action]));
    const advisors = new Set<string>();
    for (const advisor of pack.agentPolicy.advisors) {
      if (advisors.has(advisor.advisorParticipantKey)) {
        errors.push(`Agent advisor 重复：${advisor.advisorParticipantKey}。`);
      }
      advisors.add(advisor.advisorParticipantKey);

      const advisorParticipant = participants.get(advisor.advisorParticipantKey);
      if (!advisorParticipant) {
        errors.push(`Agent advisor 不存在：${advisor.advisorParticipantKey}。`);
      } else if (advisorParticipant.controller !== 'agent') {
        errors.push(`Agent advisor 必须是 agent 参与方：${advisor.advisorParticipantKey}。`);
      }
      if (advisor.triggerEventTypes.length === 0) {
        errors.push(`Agent advisor ${advisor.advisorParticipantKey} 必须声明触发事件。`);
      }

      const permissions = new Set<string>();
      for (const permission of advisor.recommendationPermissions) {
        const key = `${permission.targetParticipantKey}:${permission.actionType}`;
        if (permissions.has(key)) {
          errors.push(`Agent advisor ${advisor.advisorParticipantKey} 的建议动作重复：${key}。`);
        }
        permissions.add(key);

        const target = participants.get(permission.targetParticipantKey);
        const action = actions.get(permission.actionType);
        if (!target) {
          errors.push(`Agent 建议目标不存在：${permission.targetParticipantKey}。`);
          continue;
        }
        if (!action) {
          errors.push(`Agent 建议动作不存在：${permission.actionType}。`);
          continue;
        }
        if (!containsAll(target.capabilities, action.requiredCapabilities)) {
          errors.push(`建议目标 ${target.key} 没有动作 ${action.key} 所需 capability。`);
        }
        if (!containsAll(target.permissions, action.requiredPermissions)) {
          errors.push(`建议目标 ${target.key} 没有动作 ${action.key} 所需 permission。`);
        }
        if (!containsAll(target.knowledgeScopes, action.requiredKnowledgeScopes)) {
          errors.push(`建议目标 ${target.key} 没有动作 ${action.key} 所需 knowledge scope。`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertScenarioPack<TState>(pack: ScenarioPack<TState>): ScenarioPack<TState> {
  const result = validateScenarioPack(pack);
  if (!result.valid) {
    throw new Error(`Scenario Pack contract failed:\n${result.errors.join('\n')}`);
  }
  return pack;
}

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function isSafePathPart(part: string): boolean {
  return part.length > 0 && part !== '__proto__' && part !== 'prototype' && part !== 'constructor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsAll(values: readonly string[], required: readonly string[] | undefined): boolean {
  return required?.every((item) => values.includes(item)) ?? true;
}
