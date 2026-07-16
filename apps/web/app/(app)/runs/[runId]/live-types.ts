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

export type LiveWorkspaceProps = {
  run: RunSummary;
  participants: readonly LiveParticipant[];
  actions: readonly LiveAction[];
  injects: readonly LiveInject[];
};
