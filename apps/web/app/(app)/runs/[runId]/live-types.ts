import type { RunSummary } from '@readinessos/application';

export type LiveParticipant = {
  /**
   * 数据库 RunParticipant 的主键，用于读取参与方投影和关联 Agent Trace。
   */
  id: string;
  /**
   * Scenario Pack 中的参与方 ID，所有运行时 Command 和 DomainEvent 均使用该 ID。
   */
  runtimeParticipantId: string;
  key: string;
  displayName: string;
  controller: 'human' | 'agent' | 'system';
  capabilities: readonly string[];
  objectives: readonly string[];
  knowledgeScopes: readonly string[];
  projection: {
    status: string;
    data: unknown;
  } | null;
};

export type LiveAction = {
  key: string;
  label: string;
  risk: 'low' | 'high';
  approval: 'none' | 'required';
  participantIds: readonly string[];
};

export type LiveInject = {
  key: string;
  label: string;
};

/**
 * 这是 IC 修改建议时可选的动作白名单。它来自 Scenario Pack 的 agentPolicy，
 * 不是 Agent capability，也不是客户端自行推导的权限。
 */
export type LiveAdvisorAction = {
  targetParticipantId: string;
  targetDisplayName: string;
  actionType: string;
  actionLabel: string;
  risk: 'low' | 'high';
  approval: 'none' | 'required';
};

export type LiveAdvisor = {
  participantId: string;
  actions: readonly LiveAdvisorAction[];
};

export type LiveWorkspaceProps = {
  run: RunSummary;
  participants: readonly LiveParticipant[];
  actions: readonly LiveAction[];
  injects: readonly LiveInject[];
  advisors: readonly LiveAdvisor[];
};
