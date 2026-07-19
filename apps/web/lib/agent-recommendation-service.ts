import { createHash } from 'node:crypto';
import {
  AgentDecisionType,
  AgentRecommendationStatus,
  Prisma,
  type PrismaClient,
} from '@readinessos/database';
import type { ActorRef } from '@readinessos/domain-events';
import { ApplicationError } from '@readinessos/domain-events';
import type { ProposedAction } from '@readinessos/application';
import type { ScenarioPack } from '@readinessos/scenario-sdk';

export type AgentDispatchRequestKind = 'automatic' | 'reanalyze' | 'compare';
export type AgentRecommendationDecision = 'adopt' | 'modify' | 'reject' | 'defer';

export type AgentQuestionOption = {
  id: string;
  label: string;
};

export type AgentRecommendationSummary = {
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
  eveSessionId: string | undefined;
  eveTraceIdentity: string | undefined;
  status: AgentRecommendationStatus;
  createdAt: string;
  updatedAt: string;
};

export type AgentActivitySummary = {
  id: string;
  sequence: number;
  type: string;
  dispatchId: string | undefined;
  recommendationId: string | undefined;
  data: Record<string, unknown>;
  createdAt: string;
};

export type AgentQuestionSummary = {
  id: string;
  dispatchId: string;
  requestId: string;
  prompt: string;
  options: readonly AgentQuestionOption[];
  allowFreeform: boolean;
  answer: Record<string, unknown> | undefined;
  answeredAt: string | undefined;
  createdAt: string;
};

export type AgentDispatchClaim = {
  id: string;
  runId: string;
  organizationId: string;
  advisorParticipantId: string;
  requestKind: AgentDispatchRequestKind;
  triggerEventTypes: readonly string[];
  triggerSequences: readonly number[];
  baseRunVersion: number;
  observationHash: string | undefined;
  attempts: number;
  answeredQuestion:
    | {
        id: string;
        requestId: string;
        answer: Record<string, unknown>;
      }
    | undefined;
};

type JsonRecord = Record<string, unknown>;

/**
 * 这个服务管理 Agent 的非权威审计层。它故意不写 run_events，也不持有
 * WorldState；Agent 的任何影响都必须回到既有 RunApplicationService 命令路径。
 */
export class AgentRecommendationService {
  constructor(private readonly client: PrismaClient) {}

  async listRecommendations(
    runId: string,
    organizationId: string,
  ): Promise<readonly AgentRecommendationSummary[]> {
    await this.requireRun(runId, organizationId);
    await this.expireDueRecommendations(runId, organizationId);
    const records = await this.client.agentRecommendation.findMany({
      where: { runId, organizationId },
      include: { advisor: { select: { key: true, displayName: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return records.map(toRecommendationSummary);
  }

  async listActivities(input: {
    runId: string;
    organizationId: string;
    after?: number;
    take?: number;
  }): Promise<readonly AgentActivitySummary[]> {
    await this.requireRun(input.runId, input.organizationId);
    const activities = await this.client.agentActivity.findMany({
      where: {
        runId: input.runId,
        ...(input.after === undefined ? {} : { sequence: { gt: input.after } }),
      },
      orderBy: { sequence: 'asc' },
      take: Math.min(Math.max(input.take ?? 100, 1), 500),
    });
    return activities.map(toActivitySummary);
  }

  async listQuestions(
    runId: string,
    organizationId: string,
  ): Promise<readonly AgentQuestionSummary[]> {
    await this.requireRun(runId, organizationId);
    const questions = await this.client.agentQuestion.findMany({
      where: { runId },
      orderBy: { createdAt: 'desc' },
    });
    return questions.map(toQuestionSummary);
  }

  /**
   * 同一 Run + advisor 永远只保留一个 active dispatch。多个领域事件抵达时
   * 合并触发信息，而不是并行调用模型，以免同一角色基于相近事实提出多条建议。
   */
  async enqueueDispatch(input: {
    runId: string;
    organizationId: string;
    advisorParticipantId: string;
    requestKind: AgentDispatchRequestKind;
    triggerEventTypes: readonly string[];
    triggerSequences: readonly number[];
    force?: boolean;
  }): Promise<{ dispatchId: string | undefined; merged: boolean }> {
    try {
      return await this.client.$transaction(async (tx) => {
      const run = await requireRunTx(tx, input.runId, input.organizationId);
      const advisor = await tx.runParticipant.findFirst({
        where: {
          id: input.advisorParticipantId,
          runId: input.runId,
          controller: 'agent',
        },
        select: { id: true },
      });
      if (!advisor) {
        throw new ApplicationError('NOT_FOUND', 'Agent advisor was not found for this run.');
      }

      await expireDueRecommendationsTx(tx, run);
      const activeKey = dispatchActiveKey(input.runId, input.advisorParticipantId);
      const existing = await tx.agentDispatch.findUnique({
        where: { activeKey },
        select: {
          id: true,
          triggerEventTypes: true,
          triggerSequences: true,
          requestKind: true,
          status: true,
        },
      });
      if (existing) {
        await tx.agentDispatch.update({
          where: { id: existing.id },
          data: {
            triggerEventTypes: toJson(
              mergeStrings(stringArray(existing.triggerEventTypes), input.triggerEventTypes),
            ),
            triggerSequences: toJson(
              mergeNumbers(numberArray(existing.triggerSequences), input.triggerSequences),
            ),
            requestKind:
              requestKindPriority(input.requestKind) > requestKindPriority(existing.requestKind)
                ? input.requestKind
                : existing.requestKind,
            ...(existing.status === 'pending' ? { nextAttemptAt: new Date() } : {}),
          },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.dispatch_merged',
          dispatchId: existing.id,
          data: {
            advisorParticipantId: input.advisorParticipantId,
            requestKind: input.requestKind,
            triggerSequences: input.triggerSequences,
          },
        });
        return { dispatchId: existing.id, merged: true };
      }

      const pendingRecommendation = await tx.agentRecommendation.findFirst({
        where: {
          runId: input.runId,
          advisorParticipantId: input.advisorParticipantId,
          status: { in: ['pending', 'deferred'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, triggerEventTypes: true, triggerSequences: true, status: true },
      });
      if (pendingRecommendation && !input.force) {
        // 已有可供 IC 裁决的建议时只归并新触发，不抢占用户的决策窗口。
        await tx.agentRecommendation.update({
          where: { id: pendingRecommendation.id },
          data: {
            triggerEventTypes: toJson(
              mergeStrings(
                stringArray(pendingRecommendation.triggerEventTypes),
                input.triggerEventTypes,
              ),
            ),
            triggerSequences: toJson(
              mergeNumbers(
                numberArray(pendingRecommendation.triggerSequences),
                input.triggerSequences,
              ),
            ),
          },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.trigger_merged',
          recommendationId: pendingRecommendation.id,
          data: {
            advisorParticipantId: input.advisorParticipantId,
            requestKind: input.requestKind,
            triggerSequences: input.triggerSequences,
          },
        });
        return { dispatchId: undefined, merged: true };
      }

      if (pendingRecommendation && input.force) {
        await tx.agentRecommendation.update({
          where: { id: pendingRecommendation.id },
          data: { status: 'superseded' },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.recommendation_superseded',
          recommendationId: pendingRecommendation.id,
          data: { reason: 'IC requested a fresh analysis.' },
        });
      }

      const dispatch = await tx.agentDispatch.create({
        data: {
          organizationId: input.organizationId,
          runId: input.runId,
          advisorParticipantId: input.advisorParticipantId,
          activeKey,
          requestKind: input.requestKind,
          triggerEventTypes: toJson(mergeStrings([], input.triggerEventTypes)),
          triggerSequences: toJson(mergeNumbers([], input.triggerSequences)),
          baseRunVersion: run.version,
          observationHash: dispatchObservationHash({
            runId: input.runId,
            advisorParticipantId: input.advisorParticipantId,
            version: run.version,
            virtualTime: run.virtualTime,
            triggerSequences: input.triggerSequences,
          }),
        },
      });
      await appendActivityTx(tx, input.runId, {
        type: 'agent.dispatch_queued',
        dispatchId: dispatch.id,
        data: {
          advisorParticipantId: input.advisorParticipantId,
          requestKind: input.requestKind,
          triggerSequences: input.triggerSequences,
        },
      });
      return { dispatchId: dispatch.id, merged: false };
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return this.client.$transaction(async (tx) => {
        const activeKey = dispatchActiveKey(input.runId, input.advisorParticipantId);
        // PostgreSQL 遇到唯一约束会中止当前事务，因此这里必须在事务外捕获后
        // 开启新事务。唯一 activeKey 仍是同一角色串行分析的最终裁决。
        const raced = await tx.agentDispatch.findUniqueOrThrow({ where: { activeKey } });
        await tx.agentDispatch.update({
          where: { id: raced.id },
          data: {
            triggerEventTypes: toJson(
              mergeStrings(stringArray(raced.triggerEventTypes), input.triggerEventTypes),
            ),
            triggerSequences: toJson(
              mergeNumbers(numberArray(raced.triggerSequences), input.triggerSequences),
            ),
            requestKind:
              requestKindPriority(input.requestKind) > requestKindPriority(raced.requestKind)
                ? input.requestKind
                : raced.requestKind,
            ...(raced.status === 'pending' ? { nextAttemptAt: new Date() } : {}),
          },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.dispatch_merged',
          dispatchId: raced.id,
          data: {
            advisorParticipantId: input.advisorParticipantId,
            requestKind: input.requestKind,
            triggerSequences: input.triggerSequences,
          },
        });
        return { dispatchId: raced.id, merged: true };
      });
    }
  }

  async claimNextDispatch(input: {
    runId?: string;
    organizationId?: string;
  }): Promise<AgentDispatchClaim | undefined> {
    const now = new Date();
    const candidate = await this.client.agentDispatch.findFirst({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: now },
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (!candidate) return undefined;

    const updated = await this.client.agentDispatch.updateMany({
      where: { id: candidate.id, status: 'pending', nextAttemptAt: { lte: now } },
      data: {
        status: 'running',
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (updated.count !== 1) return undefined;

    const dispatch = await this.client.agentDispatch.findUniqueOrThrow({
      where: { id: candidate.id },
      include: {
        questions: {
          // answeredAt 是本服务唯一写入的完成标记。JSON null 与数据库 NULL
          // 在 Prisma 查询中语义不同，避免用 JsonNull/DbNull 造成兼容性分支。
          where: { answeredAt: { not: null } },
          orderBy: { answeredAt: 'desc' },
          take: 1,
        },
      },
    });
    return toDispatchClaim(dispatch);
  }

  async claimDispatch(input: {
    dispatchId: string;
    runId: string;
    organizationId: string;
  }): Promise<AgentDispatchClaim | undefined> {
    const now = new Date();
    const updated = await this.client.agentDispatch.updateMany({
      where: {
        id: input.dispatchId,
        runId: input.runId,
        organizationId: input.organizationId,
        status: 'pending',
        nextAttemptAt: { lte: now },
      },
      data: {
        status: 'running',
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (updated.count !== 1) return undefined;

    const dispatch = await this.client.agentDispatch.findUniqueOrThrow({
      where: { id: input.dispatchId },
      include: {
        questions: {
          where: { answeredAt: { not: null } },
          orderBy: { answeredAt: 'desc' },
          take: 1,
        },
      },
    });
    return toDispatchClaim(dispatch);
  }

  async markDispatchCompleted(input: {
    dispatchId: string;
    runId: string;
    type?: string;
    data?: JsonRecord;
  }): Promise<void> {
    await this.client.$transaction(async (tx) => {
      const dispatch = await tx.agentDispatch.findUniqueOrThrow({
        where: { id: input.dispatchId },
        select: { runId: true },
      });
      if (dispatch.runId !== input.runId) {
        throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found for this run.');
      }
      await tx.agentDispatch.update({
        where: { id: input.dispatchId },
        data: {
          status: 'completed',
          activeKey: null,
          lockedAt: null,
          lastError: null,
        },
      });
      await appendActivityTx(tx, input.runId, {
        type: input.type ?? 'agent.analysis_completed',
        dispatchId: input.dispatchId,
        data: input.data ?? {},
      });
    });
  }

  async recordDispatchObservation(input: {
    dispatchId: string;
    runId: string;
    observationHash: string;
  }): Promise<void> {
    const updated = await this.client.agentDispatch.updateMany({
      where: { id: input.dispatchId, runId: input.runId },
      data: { observationHash: input.observationHash },
    });
    if (updated.count !== 1) {
      throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found for this run.');
    }
  }

  async requeueFromDispatch(input: {
    dispatchId: string;
    runId: string;
    organizationId: string;
  }): Promise<{ dispatchId: string | undefined; merged: boolean }> {
    const dispatch = await this.client.agentDispatch.findFirst({
      where: {
        id: input.dispatchId,
        runId: input.runId,
        organizationId: input.organizationId,
      },
      select: {
        advisorParticipantId: true,
        requestKind: true,
        triggerEventTypes: true,
        triggerSequences: true,
      },
    });
    if (!dispatch) {
      throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found for this run.');
    }
    return this.enqueueDispatch({
      runId: input.runId,
      organizationId: input.organizationId,
      advisorParticipantId: dispatch.advisorParticipantId,
      requestKind: parseRequestKind(dispatch.requestKind),
      triggerEventTypes: stringArray(dispatch.triggerEventTypes),
      triggerSequences: numberArray(dispatch.triggerSequences),
      // 这是模型返回时发现事实版本已变化的专用路径。旧建议已被标记为
      // superseded，新的 Dispatch 必须基于当前权威版本重新构造 Observation。
      force: true,
    });
  }

  async markDispatchWaiting(input: {
    dispatchId: string;
    runId: string;
    questions: readonly {
      requestId: string;
      prompt: string;
      options: readonly AgentQuestionOption[];
      allowFreeform: boolean;
    }[];
  }): Promise<void> {
    await this.client.$transaction(async (tx) => {
      const dispatch = await tx.agentDispatch.findUniqueOrThrow({
        where: { id: input.dispatchId },
        select: { runId: true },
      });
      if (dispatch.runId !== input.runId) {
        throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found for this run.');
      }
      await tx.agentDispatch.update({
        where: { id: input.dispatchId },
        data: { status: 'waiting_for_input', lockedAt: null },
      });
      for (const question of input.questions) {
        await tx.agentQuestion.upsert({
          where: { requestId: question.requestId },
          create: {
            runId: input.runId,
            dispatchId: input.dispatchId,
            requestId: question.requestId,
            prompt: question.prompt,
            options: toJson(question.options),
            allowFreeform: question.allowFreeform,
          },
          update: {},
        });
      }
      await appendActivityTx(tx, input.runId, {
        type: 'agent.question_asked',
        dispatchId: input.dispatchId,
        data: { count: input.questions.length },
      });
    });
  }

  async markDispatchRetry(input: {
    dispatchId: string;
    runId: string;
    error: unknown;
  }): Promise<{ nextAttemptAt: Date }> {
    return this.client.$transaction(async (tx) => {
      const dispatch = await tx.agentDispatch.findUniqueOrThrow({
        where: { id: input.dispatchId },
        select: { runId: true, attempts: true },
      });
      if (dispatch.runId !== input.runId) {
        throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found for this run.');
      }
      const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, dispatch.attempts - 1));
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);
      await tx.agentDispatch.update({
        where: { id: input.dispatchId },
        data: {
          status: 'pending',
          lockedAt: null,
          lastError: errorMessage(input.error),
          nextAttemptAt,
        },
      });
      await appendActivityTx(tx, input.runId, {
        type: 'agent.analysis_failed',
        dispatchId: input.dispatchId,
        data: { message: errorMessage(input.error), retryInSeconds: delaySeconds },
      });
      return { nextAttemptAt };
    });
  }

  async createRecommendation(input: {
    dispatchId: string;
    runId: string;
    organizationId: string;
    action: ProposedAction;
    observationHash: string;
    eveSessionId?: string;
    eveTraceIdentity?: string;
  }): Promise<AgentRecommendationSummary> {
    return this.client.$transaction(async (tx) => {
      const [dispatch, run] = await Promise.all([
        tx.agentDispatch.findFirst({
          where: { id: input.dispatchId, runId: input.runId, organizationId: input.organizationId },
        }),
        requireRunTx(tx, input.runId, input.organizationId),
      ]);
      if (!dispatch) {
        throw new ApplicationError('NOT_FOUND', 'Agent dispatch was not found.');
      }
      if (dispatch.advisorParticipantId !== input.action.advisorParticipantId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The recommendation advisor does not own this dispatch.',
        );
      }
      if (run.version !== dispatch.baseRunVersion) {
        // 模型推理期间权威事实变化，不能把旧观察包装成可采纳建议。
        await tx.agentDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'completed', activeKey: null, lockedAt: null },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.recommendation_superseded',
          dispatchId: dispatch.id,
          data: {
            reason: 'Run version changed during model analysis.',
            baseRunVersion: dispatch.baseRunVersion,
            currentRunVersion: run.version,
          },
        });
        return toRecommendationSummary(
          await createSupersededRecommendationTx(tx, {
            dispatch,
            run,
            action: input.action,
            observationHash: input.observationHash,
            eveSessionId: input.eveSessionId,
            eveTraceIdentity: input.eveTraceIdentity,
          }),
        );
      }

      const advisor = await tx.runParticipant.findUniqueOrThrow({
        where: { id: dispatch.advisorParticipantId },
        select: { key: true, displayName: true },
      });
      const record = await tx.agentRecommendation.create({
        data: {
          organizationId: input.organizationId,
          runId: input.runId,
          advisorParticipantId: input.action.advisorParticipantId,
          targetParticipantId: input.action.targetParticipantId,
          actionType: input.action.actionType,
          parameters: toJson(input.action.parameters),
          rationale: input.action.rationale,
          evidenceRefs: toJson(input.action.evidenceRefs),
          confidence: input.action.confidence,
          triggerEventTypes: toJson(stringArray(dispatch.triggerEventTypes)),
          triggerSequences: toJson(numberArray(dispatch.triggerSequences)),
          observationHash: input.observationHash,
          baseRunVersion: dispatch.baseRunVersion,
          baseVirtualTime: run.virtualTime,
          expiresAtVirtualTime: run.virtualTime + 5,
          eveSessionId: input.eveSessionId ?? null,
          eveTraceIdentity: input.eveTraceIdentity ?? null,
        },
        include: { advisor: { select: { key: true, displayName: true } } },
      });
      await tx.agentDispatch.update({
        where: { id: dispatch.id },
        data: { status: 'completed', activeKey: null, lockedAt: null, lastError: null },
      });
      await appendActivityTx(tx, input.runId, {
        type: 'agent.recommendation_created',
        dispatchId: dispatch.id,
        recommendationId: record.id,
        data: {
          advisorKey: advisor.key,
          targetParticipantId: record.targetParticipantId,
          actionType: record.actionType,
          confidence: record.confidence,
        },
      });
      return toRecommendationSummary(record);
    });
  }

  async answerQuestion(input: {
    runId: string;
    organizationId: string;
    questionId: string;
    actorId: string;
    optionId?: string;
    text?: string;
  }): Promise<{ dispatchId: string }> {
    return this.client.$transaction(async (tx) => {
      await requireRunTx(tx, input.runId, input.organizationId);
      const question = await tx.agentQuestion.findFirst({
        where: { id: input.questionId, runId: input.runId },
        include: { dispatch: { select: { status: true } } },
      });
      if (!question) throw new ApplicationError('NOT_FOUND', 'Agent question was not found.');
      if (question.answeredAt !== null) {
        throw new ApplicationError('VALIDATION_ERROR', 'The agent question has already been answered.');
      }
      if (question.dispatch.status !== 'waiting_for_input') {
        throw new ApplicationError('VALIDATION_ERROR', 'The Agent dispatch is not waiting for input.');
      }
      const options = questionOptions(question.options);
      if (input.optionId !== undefined && !options.some((option) => option.id === input.optionId)) {
        throw new ApplicationError('VALIDATION_ERROR', 'The selected answer is not offered by Eve.');
      }
      if (input.text !== undefined && !question.allowFreeform) {
        throw new ApplicationError('VALIDATION_ERROR', 'This Agent question does not accept freeform text.');
      }
      if (input.optionId === undefined && input.text === undefined) {
        throw new ApplicationError('VALIDATION_ERROR', 'An answer is required.');
      }
      const answer = {
        ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
        ...(input.text === undefined ? {} : { text: input.text }),
      };
      await tx.agentQuestion.update({
        where: { id: question.id },
        data: { answer: toJson(answer), answeredById: input.actorId, answeredAt: new Date() },
      });
      await tx.agentDispatch.update({
        where: { id: question.dispatchId },
        data: { status: 'pending', nextAttemptAt: new Date(), lockedAt: null },
      });
      await appendActivityTx(tx, input.runId, {
        type: 'agent.question_answered',
        dispatchId: question.dispatchId,
        ...(question.recommendationId === null
          ? {}
          : { recommendationId: question.recommendationId }),
        data: { questionId: question.id },
      });
      return { dispatchId: question.dispatchId };
    });
  }

  async decide(input: {
    runId: string;
    organizationId: string;
    recommendationId: string;
    actor: ActorRef;
    decision: AgentRecommendationDecision;
    rationale?: string;
    deferMinutes?: number;
    modifiedAction?: {
      targetParticipantId: string;
      actionType: string;
      parameters: Record<string, unknown>;
    };
    pack: ScenarioPack<unknown>;
    executeAction?: (action: {
      participantId: string;
      actionType: string;
      parameters: Record<string, unknown>;
      expectedRunVersion: number;
    }) => Promise<{
      commandId: string;
      latestSequence: number;
      rejected: boolean;
    }>;
  }): Promise<{ executionSequence?: number }> {
    if (input.decision === 'adopt') {
      const executeAction = input.executeAction;
      if (!executeAction) {
        throw new ApplicationError('INTERNAL_ERROR', 'Kernel action executor is required.');
      }
      return this.decideWithKernel({ ...input, decision: 'adopt', executeAction });
    }
    if (input.decision === 'modify') {
      const executeAction = input.executeAction;
      if (!executeAction) {
        throw new ApplicationError('INTERNAL_ERROR', 'Kernel action executor is required.');
      }
      return this.decideWithKernel({ ...input, decision: 'modify', executeAction });
    }
    if (input.decision === 'reject') {
      return this.decideWithoutKernel({ ...input, decision: 'reject' });
    }
    return this.decideWithoutKernel({ ...input, decision: 'defer' });
  }

  async expireDueRecommendations(
    runId: string,
    organizationId: string,
  ): Promise<readonly ExpiredRecommendationAdvisor[]> {
    return this.client.$transaction(async (tx) => {
      const run = await requireRunTx(tx, runId, organizationId);
      return expireDueRecommendationsTx(tx, run);
    });
  }

  private async decideWithoutKernel(input: {
    runId: string;
    organizationId: string;
    recommendationId: string;
    actor: ActorRef;
    decision: Extract<AgentRecommendationDecision, 'reject' | 'defer'>;
    rationale?: string;
    deferMinutes?: number;
  }): Promise<{ executionSequence?: number }> {
    return this.client.$transaction(async (tx) => {
      const run = await requireRunTx(tx, input.runId, input.organizationId);
      const recommendation = await requirePendingRecommendationTx(
        tx,
        input.recommendationId,
        input.runId,
        input.organizationId,
        run,
      );
      const status =
        input.decision === 'reject'
          ? AgentRecommendationStatus.rejected
          : AgentRecommendationStatus.deferred;
      const expiresAtVirtualTime =
        input.decision === 'defer'
          ? run.virtualTime + normalizeDeferMinutes(input.deferMinutes)
          : recommendation.expiresAtVirtualTime;
      await tx.agentRecommendation.update({
        where: { id: recommendation.id },
        data: { status, expiresAtVirtualTime },
      });
      await tx.decision.create({
        data: {
          runId: input.runId,
          recommendationId: recommendation.id,
          decision: input.decision,
          agentDecisionType:
            input.decision === 'reject' ? AgentDecisionType.reject : AgentDecisionType.defer,
          actorId: input.actor.id,
          actorName: input.actor.displayName ?? null,
          rationale: input.rationale?.trim() || null,
        },
      });
      await appendActivityTx(tx, input.runId, {
        type: input.decision === 'reject' ? 'agent.recommendation_rejected' : 'agent.recommendation_deferred',
        recommendationId: recommendation.id,
        data: {
          actorId: input.actor.id,
          rationale: input.rationale?.trim() || undefined,
          ...(input.decision === 'defer' ? { expiresAtVirtualTime } : {}),
        },
      });
      return {};
    });
  }

  private async decideWithKernel(input: {
    runId: string;
    organizationId: string;
    recommendationId: string;
    actor: ActorRef;
    decision: Extract<AgentRecommendationDecision, 'adopt' | 'modify'>;
    rationale?: string;
    modifiedAction?: {
      targetParticipantId: string;
      actionType: string;
      parameters: Record<string, unknown>;
    };
    pack: ScenarioPack<unknown>;
    executeAction: (action: {
      participantId: string;
      actionType: string;
      parameters: Record<string, unknown>;
      expectedRunVersion: number;
    }) => Promise<{ commandId: string; latestSequence: number; rejected: boolean }>;
  }): Promise<{ executionSequence?: number }> {
    const reservation = await this.client.$transaction(async (tx) => {
      const run = await requireRunTx(tx, input.runId, input.organizationId);
      const recommendation = await requirePendingRecommendationTx(
        tx,
        input.recommendationId,
        input.runId,
        input.organizationId,
        run,
      );
      const action =
        input.decision === 'modify'
          ? input.modifiedAction
          : {
              targetParticipantId: recommendation.targetParticipantId,
              actionType: recommendation.actionType,
              parameters: jsonRecord(recommendation.parameters),
            };
      if (!action) {
        throw new ApplicationError('VALIDATION_ERROR', 'A modified action is required.');
      }
      const advisor = await tx.runParticipant.findUniqueOrThrow({
        where: { id: recommendation.advisorParticipantId },
        select: { key: true },
      });
      const target = await tx.runParticipant.findFirst({
        where: {
          id: action.targetParticipantId,
          runId: input.runId,
        },
        select: { key: true },
      });
      if (!target) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The selected recommendation target is not part of this run.',
        );
      }
      assertAgentActionAuthorized(input.pack, advisor.key, {
        targetParticipantKey: target.key,
        actionType: action.actionType,
      });
      const runtimeTarget = input.pack.participants.find(
        (participant) => participant.key === target.key,
      );
      if (!runtimeTarget) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The selected recommendation target is unavailable in this scenario version.',
        );
      }

      const nextStatus =
        input.decision === 'adopt'
          ? AgentRecommendationStatus.adopted
          : AgentRecommendationStatus.modified;
      const decision = await tx.decision.create({
        data: {
          runId: input.runId,
          recommendationId: recommendation.id,
          decision: input.decision,
          agentDecisionType:
            input.decision === 'adopt' ? AgentDecisionType.adopt : AgentDecisionType.modify,
          actorId: input.actor.id,
          actorName: input.actor.displayName ?? null,
          rationale: input.rationale?.trim() || null,
          ...(input.decision === 'modify'
            ? {
                modifiedActionType: action.actionType,
                modifiedParameters: toJson(action.parameters),
              }
            : {}),
        },
      });
      const updated = await tx.agentRecommendation.updateMany({
        where: { id: recommendation.id, status: 'pending' },
        data: { status: nextStatus },
      });
      if (updated.count !== 1) {
        throw new ApplicationError('RUN_VERSION_CONFLICT', 'The recommendation was already decided.');
      }
      await appendActivityTx(tx, input.runId, {
        type:
          input.decision === 'adopt'
            ? 'agent.recommendation_adopted'
            : 'agent.recommendation_modified',
        recommendationId: recommendation.id,
        data: {
          actorId: input.actor.id,
          targetParticipantId: action.targetParticipantId,
          actionType: action.actionType,
        },
      });
      return {
        decisionId: decision.id,
        recommendationId: recommendation.id,
        action: {
          participantId: runtimeTarget.id,
          actionType: action.actionType,
          parameters: action.parameters,
        },
        baseRunVersion: recommendation.baseRunVersion,
      };
    });

    try {
      const execution = await input.executeAction({
        ...reservation.action,
        expectedRunVersion: reservation.baseRunVersion,
      });
      await this.client.$transaction(async (tx) => {
        await tx.decision.update({
          where: { id: reservation.decisionId },
          data: {
            kernelCommandId: execution.commandId,
            executionSequence: execution.latestSequence,
          },
        });
        await appendActivityTx(tx, input.runId, {
          type: execution.rejected
            ? 'agent.recommendation_kernel_rejected'
            : 'agent.recommendation_submitted_to_kernel',
          recommendationId: reservation.recommendationId,
          data: {
            commandId: execution.commandId,
            executionSequence: execution.latestSequence,
          },
        });
      });
      return { executionSequence: execution.latestSequence };
    } catch (error) {
      // Command 没有提交成功时，不能把“已采纳”伪装成造成业务后果；标记为
      // superseded，等待后续事件或 IC 的重新分析请求产生新的事实基线。
      await this.client.$transaction(async (tx) => {
        await tx.agentRecommendation.updateMany({
          where: {
            id: reservation.recommendationId,
            status: { in: ['adopted', 'modified'] },
          },
          data: { status: 'superseded' },
        });
        await appendActivityTx(tx, input.runId, {
          type: 'agent.recommendation_submission_failed',
          recommendationId: reservation.recommendationId,
          data: { message: errorMessage(error) },
        });
      });
      throw error;
    }
  }

  private async requireRun(runId: string, organizationId: string) {
    return requireRunTx(this.client, runId, organizationId);
  }
}

export function assertAgentActionAuthorized(
  pack: ScenarioPack<unknown>,
  advisorParticipantKey: string,
  action: {
    targetParticipantKey: string;
    actionType: string;
  },
): void {
  const advisor = pack.agentPolicy?.advisors.find(
    (policy) => policy.advisorParticipantKey === advisorParticipantKey,
  );
  const permitted = advisor?.recommendationPermissions.some(
    (permission) =>
      permission.targetParticipantKey === action.targetParticipantKey &&
      permission.actionType === action.actionType,
  );
  if (!permitted) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'This advisor is not authorized to recommend the selected action.',
    );
  }
}

async function requireRunTx(
  client: PrismaClient | Prisma.TransactionClient,
  runId: string,
  organizationId: string,
) {
  const run = await client.simulationRun.findFirst({
    where: { id: runId, organizationId },
    select: { id: true, organizationId: true, version: true, virtualTime: true, status: true },
  });
  if (!run) throw new ApplicationError('NOT_FOUND', 'Run was not found for this organization.');
  return run;
}

async function requirePendingRecommendationTx(
  tx: Prisma.TransactionClient,
  recommendationId: string,
  runId: string,
  organizationId: string,
  run: { version: number; virtualTime: number },
) {
  const recommendation = await tx.agentRecommendation.findFirst({
    where: { id: recommendationId, runId, organizationId },
  });
  if (!recommendation) throw new ApplicationError('NOT_FOUND', 'Agent recommendation was not found.');
  if (recommendation.status !== 'pending') {
    throw new ApplicationError('VALIDATION_ERROR', 'This recommendation is no longer pending.');
  }
  if (recommendation.baseRunVersion !== run.version) {
    await tx.agentRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'superseded' },
    });
    await appendActivityTx(tx, runId, {
      type: 'agent.recommendation_superseded',
      recommendationId: recommendation.id,
      data: {
        reason: 'Run version changed before IC decision.',
        baseRunVersion: recommendation.baseRunVersion,
        currentRunVersion: run.version,
      },
    });
    throw new ApplicationError('RUN_VERSION_CONFLICT', 'The recommendation is based on stale facts.');
  }
  if (recommendation.expiresAtVirtualTime <= run.virtualTime) {
    await tx.agentRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'expired' },
    });
    await appendActivityTx(tx, runId, {
      type: 'agent.recommendation_expired',
      recommendationId: recommendation.id,
      data: { expiresAtVirtualTime: recommendation.expiresAtVirtualTime },
    });
    throw new ApplicationError('VALIDATION_ERROR', 'The recommendation has expired in virtual time.');
  }
  return recommendation;
}

async function expireDueRecommendationsTx(
  tx: Prisma.TransactionClient,
  run: { id: string; virtualTime: number },
): Promise<readonly ExpiredRecommendationAdvisor[]> {
  const due = await tx.agentRecommendation.findMany({
    where: {
      runId: run.id,
      status: { in: ['pending', 'deferred'] },
      expiresAtVirtualTime: { lte: run.virtualTime },
    },
    select: { id: true, status: true, advisorParticipantId: true },
  });
  for (const recommendation of due) {
    await tx.agentRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'expired' },
    });
    await appendActivityTx(tx, run.id, {
      type: 'agent.recommendation_expired',
      recommendationId: recommendation.id,
      data: { previousStatus: recommendation.status },
    });
  }
  return due.map((recommendation) => ({
    advisorParticipantId: recommendation.advisorParticipantId,
    previousStatus: recommendation.status,
  }));
}

type ExpiredRecommendationAdvisor = {
  advisorParticipantId: string;
  previousStatus: AgentRecommendationStatus;
};

async function createSupersededRecommendationTx(
  tx: Prisma.TransactionClient,
  input: {
    dispatch: {
      organizationId: string;
      runId: string;
      advisorParticipantId: string;
      baseRunVersion: number;
      triggerEventTypes: Prisma.JsonValue;
      triggerSequences: Prisma.JsonValue;
    };
    run: { virtualTime: number };
    action: ProposedAction;
    observationHash: string;
    eveSessionId?: string | undefined;
    eveTraceIdentity?: string | undefined;
  },
) {
  return tx.agentRecommendation.create({
    data: {
      organizationId: input.dispatch.organizationId,
      runId: input.dispatch.runId,
      advisorParticipantId: input.action.advisorParticipantId,
      targetParticipantId: input.action.targetParticipantId,
      actionType: input.action.actionType,
      parameters: toJson(input.action.parameters),
      rationale: input.action.rationale,
      evidenceRefs: toJson(input.action.evidenceRefs),
      confidence: input.action.confidence,
      triggerEventTypes: toJson(stringArray(input.dispatch.triggerEventTypes)),
      triggerSequences: toJson(numberArray(input.dispatch.triggerSequences)),
      observationHash: input.observationHash,
      baseRunVersion: input.dispatch.baseRunVersion,
      baseVirtualTime: input.run.virtualTime,
      expiresAtVirtualTime: input.run.virtualTime,
      eveSessionId: input.eveSessionId ?? null,
      eveTraceIdentity: input.eveTraceIdentity ?? null,
      status: 'superseded',
    },
    include: { advisor: { select: { key: true, displayName: true } } },
  });
}

async function appendActivityTx(
  tx: Prisma.TransactionClient,
  runId: string,
  input: {
    type: string;
    dispatchId?: string;
    recommendationId?: string;
    data: JsonRecord;
  },
) {
  // increment 在同一 SQL 更新内完成，PostgreSQL 会串行化同一个 Run 的活动游标，
  // 所以审计流不依赖 run_events 的 sequence，也不会破坏领域事件重放。
  const run = await tx.simulationRun.update({
    where: { id: runId },
    data: { agentActivitySequence: { increment: 1 } },
    select: { agentActivitySequence: true },
  });
  return tx.agentActivity.create({
    data: {
      runId,
      sequence: run.agentActivitySequence,
      type: input.type,
      dispatchId: input.dispatchId ?? null,
      recommendationId: input.recommendationId ?? null,
      data: toJson(input.data),
    },
  });
}

function toRecommendationSummary(record: {
  id: string;
  advisorParticipantId: string;
  targetParticipantId: string;
  actionType: string;
  parameters: Prisma.JsonValue;
  rationale: string;
  evidenceRefs: Prisma.JsonValue;
  confidence: number;
  triggerEventTypes: Prisma.JsonValue;
  triggerSequences: Prisma.JsonValue;
  observationHash: string;
  baseRunVersion: number;
  baseVirtualTime: number;
  expiresAtVirtualTime: number;
  eveSessionId: string | null;
  eveTraceIdentity: string | null;
  status: AgentRecommendationStatus;
  createdAt: Date;
  updatedAt: Date;
  advisor: { key: string; displayName: string };
}): AgentRecommendationSummary {
  return {
    id: record.id,
    advisorParticipantId: record.advisorParticipantId,
    advisorKey: record.advisor.key,
    advisorDisplayName: record.advisor.displayName,
    targetParticipantId: record.targetParticipantId,
    actionType: record.actionType,
    parameters: jsonRecord(record.parameters),
    rationale: record.rationale,
    evidenceRefs: stringArray(record.evidenceRefs),
    confidence: record.confidence,
    triggerEventTypes: stringArray(record.triggerEventTypes),
    triggerSequences: numberArray(record.triggerSequences),
    observationHash: record.observationHash,
    baseRunVersion: record.baseRunVersion,
    baseVirtualTime: record.baseVirtualTime,
    expiresAtVirtualTime: record.expiresAtVirtualTime,
    eveSessionId: record.eveSessionId ?? undefined,
    eveTraceIdentity: record.eveTraceIdentity ?? undefined,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toActivitySummary(record: {
  id: string;
  sequence: number;
  type: string;
  dispatchId: string | null;
  recommendationId: string | null;
  data: Prisma.JsonValue;
  createdAt: Date;
}): AgentActivitySummary {
  return {
    id: record.id,
    sequence: record.sequence,
    type: record.type,
    dispatchId: record.dispatchId ?? undefined,
    recommendationId: record.recommendationId ?? undefined,
    data: jsonRecord(record.data),
    createdAt: record.createdAt.toISOString(),
  };
}

function toDispatchClaim(record: {
  id: string;
  runId: string;
  organizationId: string;
  advisorParticipantId: string;
  requestKind: string;
  triggerEventTypes: Prisma.JsonValue;
  triggerSequences: Prisma.JsonValue;
  baseRunVersion: number;
  observationHash: string | null;
  attempts: number;
  questions: readonly {
    id: string;
    requestId: string;
    answer: Prisma.JsonValue | null;
  }[];
}): AgentDispatchClaim {
  const question = record.questions[0];
  return {
    id: record.id,
    runId: record.runId,
    organizationId: record.organizationId,
    advisorParticipantId: record.advisorParticipantId,
    requestKind: parseRequestKind(record.requestKind),
    triggerEventTypes: stringArray(record.triggerEventTypes),
    triggerSequences: numberArray(record.triggerSequences),
    baseRunVersion: record.baseRunVersion,
    observationHash: record.observationHash ?? undefined,
    attempts: record.attempts,
    answeredQuestion:
      question === undefined
        ? undefined
        : {
            id: question.id,
            requestId: question.requestId,
            answer: jsonRecord(question.answer),
          },
  };
}

function toQuestionSummary(record: {
  id: string;
  dispatchId: string;
  requestId: string;
  prompt: string;
  options: Prisma.JsonValue;
  allowFreeform: boolean;
  answer: Prisma.JsonValue | null;
  answeredAt: Date | null;
  createdAt: Date;
}): AgentQuestionSummary {
  return {
    id: record.id,
    dispatchId: record.dispatchId,
    requestId: record.requestId,
    prompt: record.prompt,
    options: questionOptions(record.options),
    allowFreeform: record.allowFreeform,
    answer: record.answer === null ? undefined : jsonRecord(record.answer),
    answeredAt: record.answeredAt?.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function dispatchActiveKey(runId: string, advisorParticipantId: string): string {
  return `${runId}:${advisorParticipantId}`;
}

function dispatchObservationHash(input: {
  runId: string;
  advisorParticipantId: string;
  version: number;
  virtualTime: number;
  triggerSequences: readonly number[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function normalizeDeferMinutes(value: number | undefined): number {
  if (value === 1 || value === 3 || value === 5) return value;
  throw new ApplicationError('VALIDATION_ERROR', 'Defer duration must be 1, 3, or 5 virtual minutes.');
}

function parseRequestKind(value: string): AgentDispatchRequestKind {
  return value === 'reanalyze' || value === 'compare' ? value : 'automatic';
}

function requestKindPriority(value: string): number {
  return value === 'compare' ? 3 : value === 'reanalyze' ? 2 : 1;
}

function questionOptions(value: unknown): AgentQuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = jsonRecord(item);
    return typeof option.id === 'string' && typeof option.label === 'string'
      ? [{ id: option.id, label: option.label }]
      : [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
    : [];
}

function mergeStrings(current: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...current, ...incoming])];
}

function mergeNumbers(current: readonly number[], incoming: readonly number[]): number[] {
  return [...new Set([...current, ...incoming])].sort((left, right) => left - right);
}

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000);
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
