import type { RunSummary } from '@readinessos/application';
import type { LiveAdvisor, LiveParticipant } from './live-types';

export type AgentRecommendationStatus =
  'pending' | 'adopted' | 'modified' | 'rejected' | 'deferred' | 'superseded' | 'expired';

export type AgentRecommendation = {
  id: string;
  advisorParticipantId: string;
  advisorKey: string;
  advisorDisplayName: string;
  targetParticipantId: string;
  actionType: string;
  parameters: Record<string, unknown>;
  rationale: string;
  evidenceRefs: readonly string[];
  confidence: number;
  triggerEventTypes: readonly string[];
  triggerSequences: readonly number[];
  observationHash: string;
  baseRunVersion: number;
  baseVirtualTime: number;
  expiresAtVirtualTime: number;
  status: AgentRecommendationStatus;
  createdAt: string;
  updatedAt: string;
};

export type AgentActivity = {
  id: string;
  sequence: number;
  type: string;
  dispatchId?: string;
  recommendationId?: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type AgentQuestion = {
  id: string;
  dispatchId: string;
  requestId: string;
  prompt: string;
  options: readonly { id: string; label: string }[];
  allowFreeform: boolean;
  answer?: Record<string, unknown>;
  answeredAt?: string;
  createdAt: string;
};

export type RecommendationDecisionInput = {
  recommendationId: string;
  decision: 'adopt' | 'modify' | 'reject' | 'defer';
  rationale?: string;
  deferMinutes?: 1 | 3 | 5;
  modifiedAction?: {
    targetParticipantId: string;
    actionType: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentDecisionCenterProps = {
  run: RunSummary;
  participants: readonly LiveParticipant[];
  advisors: readonly LiveAdvisor[];
  recommendations: readonly AgentRecommendation[];
  questions: readonly AgentQuestion[];
  onRequestAnalysis(participantId: string, requestKind: 'reanalyze' | 'compare'): Promise<void>;
  onDecision(input: RecommendationDecisionInput): Promise<void>;
  onAnswerQuestion(input: { questionId: string; optionId?: string; text?: string }): Promise<void>;
};
