import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import {
  all,
  elapsedMinutesGte,
  eventOccurred,
  not,
  participantActionCountGte,
  stateEquals,
  type EvaluationDraft,
} from '@readinessos/simulation-kernel';
import { z } from 'zod';

export const customerEscalationPackKey = 'customer-escalation';

export const customerEscalationParticipantIds = {
  accountExecutive: '018f4c8b-9ae2-7a72-86bd-4f867befee11',
  customerSuccessLead: '018f4c8b-9ae2-7a72-86bd-4f867befee12',
  engineeringLead: '018f4c8b-9ae2-7a72-86bd-4f867befee13',
  executiveSponsor: '018f4c8b-9ae2-7a72-86bd-4f867befee14',
  customerSignalSystem: '018f4c8b-9ae2-7a72-86bd-4f867befee15',
} as const;

export const customerEscalationStateSchema = z.object({
  clock: z.object({
    elapsedMinutes: z.number().int().nonnegative(),
    status: z.enum(['idle', 'running', 'paused', 'completed']),
  }),
  account: z.object({
    name: z.string().min(1),
    riskLevel: z.enum(['stable', 'at-risk', 'critical', 'recovered']),
    renewalValue: z.number().int().nonnegative(),
    renewalStatus: z.enum(['on-track', 'at-risk', 'critical', 'renewed']),
    executiveSponsorEngaged: z.boolean(),
    customerConfidence: z.number().int().min(0).max(100),
  }),
  case: z.object({
    escalationAcknowledged: z.boolean(),
    rootCauseConfirmed: z.boolean(),
    recoveryPlanShared: z.boolean(),
    remediationScheduled: z.boolean(),
    remediationCompleted: z.boolean(),
    customerValidated: z.boolean(),
  }),
  response: z.object({
    ownerParticipantId: z.string().uuid().optional(),
    executiveBriefed: z.boolean(),
    customerUpdateSent: z.boolean(),
    successPlanAgreed: z.boolean(),
  }),
  objectives: z.record(z.string(), z.enum(['healthy', 'at-risk', 'failed'])),
});

export type CustomerEscalationState = z.infer<typeof customerEscalationStateSchema>;

const evidenceTypes = ['action.executed', 'inject.triggered'] as const;

/**
 * Evaluator 只产出可由事件时间线验证的评分结果，不读取 Agent 的自由文本或外部系统。
 * 这样 Review 页面可以使用所有 Scenario Pack 共享的 Evidence 展示方式。
 */
function evaluation(evaluatorKey: string, score: number, summary: string): EvaluationDraft {
  return { evaluatorKey, score, summary, evidenceEventTypes: evidenceTypes };
}

function score(condition: boolean, partialCondition = false): number {
  if (condition) {
    return 100;
  }
  return partialCondition ? 60 : 0;
}

export const customerEscalationPack: ScenarioPack<CustomerEscalationState> = assertScenarioPack({
  key: customerEscalationPackKey,
  manifest: {
    key: customerEscalationPackKey,
    name: 'Critical Customer Escalation',
    description: '关键客户续约风险、跨团队修复协调与客户信心恢复的确定性演练。',
    version: 1,
    estimatedDurationMinutes: 10,
  },
  stateSchema: customerEscalationStateSchema,
  initialState: () => ({
    clock: {
      elapsedMinutes: 0,
      status: 'idle',
    },
    account: {
      name: 'Northstar Health',
      riskLevel: 'stable',
      renewalValue: 240_000,
      renewalStatus: 'on-track',
      executiveSponsorEngaged: false,
      customerConfidence: 86,
    },
    case: {
      escalationAcknowledged: false,
      rootCauseConfirmed: false,
      recoveryPlanShared: false,
      remediationScheduled: false,
      remediationCompleted: false,
      customerValidated: false,
    },
    response: {
      ownerParticipantId: undefined,
      executiveBriefed: false,
      customerUpdateSent: false,
      successPlanAgreed: false,
    },
    objectives: {
      customerRecovery: 'healthy',
      executiveAlignment: 'healthy',
      deliveryConfidence: 'healthy',
    },
  }),
  participants: [
    {
      id: customerEscalationParticipantIds.accountExecutive,
      key: 'account-executive',
      displayName: 'Account Executive',
      controller: 'human',
      capabilities: ['acknowledge-escalation', 'brief-executive-sponsor', 'close-escalation'],
      permissions: ['write:account-response', 'write:executive-briefing', 'write:escalation'],
      knowledgeScopes: ['account', 'customer-comms', 'executive'],
      objectives: ['customerRecovery', 'executiveAlignment'],
    },
    {
      id: customerEscalationParticipantIds.customerSuccessLead,
      key: 'customer-success-lead',
      displayName: 'Customer Success Lead',
      controller: 'agent',
      capabilities: ['send-customer-update', 'share-recovery-plan', 'validate-customer-recovery'],
      permissions: ['write:customer-comms', 'write:success-plan', 'write:customer-validation'],
      knowledgeScopes: ['account', 'customer-comms'],
      objectives: ['customerRecovery', 'deliveryConfidence'],
    },
    {
      id: customerEscalationParticipantIds.engineeringLead,
      key: 'engineering-lead',
      displayName: 'Engineering Lead',
      controller: 'agent',
      capabilities: ['investigate-root-cause', 'schedule-remediation'],
      permissions: ['read:engineering-investigation', 'write:remediation-plan'],
      knowledgeScopes: ['account', 'engineering'],
      objectives: ['deliveryConfidence'],
    },
    {
      id: customerEscalationParticipantIds.executiveSponsor,
      key: 'executive-sponsor',
      displayName: 'Executive Sponsor',
      controller: 'agent',
      capabilities: ['review-account-risk'],
      permissions: ['read:executive-briefing'],
      knowledgeScopes: ['account', 'executive'],
      objectives: ['executiveAlignment'],
    },
    {
      id: customerEscalationParticipantIds.customerSignalSystem,
      key: 'customer-signal-system',
      displayName: 'Customer Signal System',
      controller: 'system',
      capabilities: [],
      permissions: [],
      knowledgeScopes: ['account', 'customer-comms'],
      objectives: ['customerRecovery'],
    },
  ],
  signals: [
    {
      key: 'customer-escalation-opened',
      label: 'Critical customer escalation opened',
      requiredKnowledgeScopes: ['account'],
    },
    {
      key: 'root-cause-confirmed',
      label: 'Engineering root cause confirmed',
      requiredKnowledgeScopes: ['engineering'],
    },
    {
      key: 'executive-risk-alert',
      label: 'Executive risk update required',
      requiredKnowledgeScopes: ['executive'],
    },
    {
      key: 'customer-confidence-drop',
      label: 'Customer confidence is declining',
      requiredKnowledgeScopes: ['customer-comms'],
    },
    {
      key: 'customer-update-sent',
      label: 'Customer update sent',
      requiredKnowledgeScopes: ['customer-comms'],
    },
    {
      key: 'recovery-plan-shared',
      label: 'Recovery plan shared with customer',
      requiredKnowledgeScopes: ['account'],
    },
    {
      key: 'remediation-scheduled',
      label: 'Production remediation scheduled',
      requiredKnowledgeScopes: ['engineering'],
    },
    {
      key: 'remediation-complete',
      label: 'Production remediation complete',
      requiredKnowledgeScopes: ['account'],
    },
    {
      key: 'renewal-risk-escalated',
      label: 'Renewal risk escalated',
      requiredKnowledgeScopes: ['account'],
    },
    {
      key: 'customer-recovery-validated',
      label: 'Customer recovery validated',
      requiredKnowledgeScopes: ['customer-comms'],
    },
  ],
  actions: [
    {
      key: 'acknowledge-escalation',
      label: 'Acknowledge customer escalation',
      requiredCapabilities: ['acknowledge-escalation'],
      requiredPermissions: ['write:account-response'],
      requiredKnowledgeScopes: ['account'],
      risk: 'low',
      approval: 'none',
      effects: [
        { kind: 'set-state', path: ['case', 'escalationAcknowledged'], value: true },
        {
          kind: 'set-state',
          path: ['response', 'ownerParticipantId'],
          value: customerEscalationParticipantIds.accountExecutive,
        },
      ],
    },
    {
      key: 'investigate-root-cause',
      label: 'Investigate technical root cause',
      requiredCapabilities: ['investigate-root-cause'],
      requiredPermissions: ['read:engineering-investigation'],
      requiredKnowledgeScopes: ['engineering'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<CustomerEscalationState>(['case', 'escalationAcknowledged'], true),
      effects: [{ kind: 'record-metric', metricKey: 'root_cause_confidence', value: 0.92 }],
    },
    {
      key: 'brief-executive-sponsor',
      label: 'Brief executive sponsor',
      requiredCapabilities: ['brief-executive-sponsor'],
      requiredPermissions: ['write:executive-briefing'],
      requiredKnowledgeScopes: ['executive'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<CustomerEscalationState>(['case', 'escalationAcknowledged'], true),
      effects: [
        { kind: 'set-state', path: ['response', 'executiveBriefed'], value: true },
        { kind: 'set-state', path: ['account', 'executiveSponsorEngaged'], value: true },
        { kind: 'set-state', path: ['objectives', 'executiveAlignment'], value: 'healthy' },
      ],
    },
    {
      key: 'send-customer-update',
      label: 'Send customer update',
      requiredCapabilities: ['send-customer-update'],
      requiredPermissions: ['write:customer-comms'],
      requiredKnowledgeScopes: ['customer-comms'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<CustomerEscalationState>(['case', 'escalationAcknowledged'], true),
      effects: [
        { kind: 'set-state', path: ['response', 'customerUpdateSent'], value: true },
        { kind: 'set-state', path: ['account', 'customerConfidence'], value: 58 },
        {
          kind: 'emit-signal',
          signalKey: 'customer-update-sent',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'share-recovery-plan',
      label: 'Share recovery plan',
      requiredCapabilities: ['share-recovery-plan'],
      requiredPermissions: ['write:success-plan'],
      requiredKnowledgeScopes: ['customer-comms'],
      risk: 'low',
      approval: 'none',
      precondition: all(
        stateEquals<CustomerEscalationState>(['case', 'rootCauseConfirmed'], true),
        stateEquals<CustomerEscalationState>(['response', 'customerUpdateSent'], true),
      ),
      effects: [
        { kind: 'set-state', path: ['case', 'recoveryPlanShared'], value: true },
        { kind: 'set-state', path: ['response', 'successPlanAgreed'], value: true },
        { kind: 'set-state', path: ['account', 'customerConfidence'], value: 72 },
        {
          kind: 'emit-signal',
          signalKey: 'recovery-plan-shared',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.engineeringLead,
            customerEscalationParticipantIds.executiveSponsor,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'schedule-remediation',
      label: 'Schedule production remediation',
      requiredCapabilities: ['schedule-remediation'],
      requiredPermissions: ['write:remediation-plan'],
      requiredKnowledgeScopes: ['engineering'],
      risk: 'high',
      approval: 'required',
      precondition: all(
        stateEquals<CustomerEscalationState>(['case', 'rootCauseConfirmed'], true),
        stateEquals<CustomerEscalationState>(['response', 'executiveBriefed'], true),
        stateEquals<CustomerEscalationState>(['case', 'recoveryPlanShared'], true),
      ),
      effects: [
        { kind: 'set-state', path: ['case', 'remediationScheduled'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'remediation-scheduled',
          recipients: [customerEscalationParticipantIds.engineeringLead],
        },
        { kind: 'schedule-inject', injectKey: 'remediation-complete', delayMinutes: 2 },
      ],
    },
    {
      key: 'validate-customer-recovery',
      label: 'Validate customer recovery',
      requiredCapabilities: ['validate-customer-recovery'],
      requiredPermissions: ['write:customer-validation'],
      requiredKnowledgeScopes: ['customer-comms'],
      risk: 'low',
      approval: 'none',
      precondition: all(
        stateEquals<CustomerEscalationState>(['case', 'remediationCompleted'], true),
        stateEquals<CustomerEscalationState>(['case', 'recoveryPlanShared'], true),
      ),
      effects: [
        { kind: 'set-state', path: ['case', 'customerValidated'], value: true },
        { kind: 'set-state', path: ['account', 'customerConfidence'], value: 91 },
        { kind: 'set-state', path: ['account', 'riskLevel'], value: 'recovered' },
        { kind: 'set-state', path: ['account', 'renewalStatus'], value: 'on-track' },
        { kind: 'set-state', path: ['objectives', 'customerRecovery'], value: 'healthy' },
        {
          kind: 'emit-signal',
          signalKey: 'customer-recovery-validated',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'close-escalation',
      label: 'Close customer escalation',
      requiredCapabilities: ['close-escalation'],
      requiredPermissions: ['write:escalation'],
      requiredKnowledgeScopes: ['account'],
      risk: 'low',
      approval: 'none',
      precondition: all(
        stateEquals<CustomerEscalationState>(['case', 'customerValidated'], true),
        stateEquals<CustomerEscalationState>(['response', 'executiveBriefed'], true),
        stateEquals<CustomerEscalationState>(['response', 'customerUpdateSent'], true),
        stateEquals<CustomerEscalationState>(['case', 'remediationCompleted'], true),
      ),
      effects: [
        {
          kind: 'complete-run',
          reason:
            'customer recovery has been validated after the remediation and executive alignment',
        },
      ],
    },
  ],
  injects: [
    {
      key: 'customer-escalation-opened',
      trigger: eventOccurred<CustomerEscalationState>('run.started'),
      effects: [
        { kind: 'set-state', path: ['account', 'riskLevel'], value: 'critical' },
        { kind: 'set-state', path: ['account', 'renewalStatus'], value: 'at-risk' },
        { kind: 'set-state', path: ['account', 'customerConfidence'], value: 38 },
        { kind: 'set-state', path: ['objectives', 'customerRecovery'], value: 'at-risk' },
        { kind: 'set-state', path: ['objectives', 'executiveAlignment'], value: 'at-risk' },
        { kind: 'set-state', path: ['objectives', 'deliveryConfidence'], value: 'failed' },
        {
          kind: 'emit-signal',
          signalKey: 'customer-escalation-opened',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.engineeringLead,
            customerEscalationParticipantIds.executiveSponsor,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'root-cause-confirmed',
      trigger: participantActionCountGte<CustomerEscalationState>(
        customerEscalationParticipantIds.engineeringLead,
        'investigate-root-cause',
        1,
      ),
      effects: [
        { kind: 'set-state', path: ['case', 'rootCauseConfirmed'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'root-cause-confirmed',
          recipients: [customerEscalationParticipantIds.engineeringLead],
        },
      ],
    },
    {
      key: 'executive-risk-alert',
      trigger: all(
        elapsedMinutesGte<CustomerEscalationState>(2),
        not(stateEquals<CustomerEscalationState>(['response', 'executiveBriefed'], true)),
      ),
      effects: [
        {
          kind: 'emit-signal',
          signalKey: 'executive-risk-alert',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.executiveSponsor,
          ],
        },
      ],
    },
    {
      key: 'customer-confidence-drop',
      trigger: all(
        elapsedMinutesGte<CustomerEscalationState>(3),
        not(stateEquals<CustomerEscalationState>(['response', 'customerUpdateSent'], true)),
      ),
      effects: [
        { kind: 'set-state', path: ['account', 'customerConfidence'], value: 20 },
        {
          kind: 'emit-signal',
          signalKey: 'customer-confidence-drop',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'renewal-risk-escalation',
      trigger: all(
        elapsedMinutesGte<CustomerEscalationState>(4),
        not(stateEquals<CustomerEscalationState>(['case', 'recoveryPlanShared'], true)),
      ),
      effects: [
        { kind: 'set-state', path: ['account', 'renewalStatus'], value: 'critical' },
        {
          kind: 'emit-signal',
          signalKey: 'renewal-risk-escalated',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.engineeringLead,
            customerEscalationParticipantIds.executiveSponsor,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
    {
      key: 'remediation-complete',
      effects: [
        { kind: 'set-state', path: ['case', 'remediationCompleted'], value: true },
        { kind: 'set-state', path: ['objectives', 'deliveryConfidence'], value: 'healthy' },
        {
          kind: 'emit-signal',
          signalKey: 'remediation-complete',
          recipients: [
            customerEscalationParticipantIds.accountExecutive,
            customerEscalationParticipantIds.customerSuccessLead,
            customerEscalationParticipantIds.engineeringLead,
            customerEscalationParticipantIds.executiveSponsor,
            customerEscalationParticipantIds.customerSignalSystem,
          ],
        },
      ],
    },
  ],
  evaluators: [
    {
      key: 'response-ownership',
      evaluate: ({ state }) =>
        evaluation(
          'response-ownership',
          score(
            state.world.case.escalationAcknowledged &&
              Boolean(state.world.response.ownerParticipantId),
            state.world.case.escalationAcknowledged,
          ),
          state.world.response.ownerParticipantId
            ? '客户升级已确认，并分配了明确的业务负责人。'
            : '尚未确认升级或明确响应负责人。',
        ),
    },
    {
      key: 'executive-alignment',
      evaluate: ({ state }) =>
        evaluation(
          'executive-alignment',
          score(
            state.world.response.executiveBriefed && state.world.account.executiveSponsorEngaged,
            state.world.response.executiveBriefed,
          ),
          state.world.account.executiveSponsorEngaged
            ? '已向管理层同步风险，并建立执行赞助。'
            : '尚未完成管理层风险对齐。',
        ),
    },
    {
      key: 'customer-communication',
      evaluate: ({ state }) =>
        evaluation(
          'customer-communication',
          score(
            state.world.response.customerUpdateSent &&
              state.world.case.recoveryPlanShared &&
              state.world.case.customerValidated,
            state.world.response.customerUpdateSent || state.world.case.recoveryPlanShared,
          ),
          state.world.case.customerValidated
            ? '客户已收到更新、恢复计划，并完成恢复确认。'
            : '客户沟通节奏或恢复计划仍不完整。',
        ),
    },
    {
      key: 'remediation-execution',
      evaluate: ({ state }) =>
        evaluation(
          'remediation-execution',
          score(
            state.world.case.rootCauseConfirmed &&
              state.world.case.remediationScheduled &&
              state.world.case.remediationCompleted,
            state.world.case.rootCauseConfirmed || state.world.case.remediationScheduled,
          ),
          state.world.case.remediationCompleted
            ? '根因、修复排期和生产修复均已完成。'
            : '尚未完成受控的生产修复闭环。',
        ),
    },
    {
      key: 'recovery-validation',
      evaluate: ({ state }) =>
        evaluation(
          'recovery-validation',
          score(
            state.world.account.riskLevel === 'recovered' &&
              state.world.account.customerConfidence >= 90 &&
              state.world.case.customerValidated,
            state.world.case.customerValidated,
          ),
          state.world.case.customerValidated
            ? '客户恢复已验证，续约风险已回到可控状态。'
            : '尚未验证客户恢复结果。',
        ),
    },
  ],
  uiContributions: [
    { key: 'account-risk-level', label: 'Account risk level', statePath: ['account', 'riskLevel'] },
    { key: 'renewal-value', label: 'Renewal value', statePath: ['account', 'renewalValue'] },
    {
      key: 'customer-confidence',
      label: 'Customer confidence',
      statePath: ['account', 'customerConfidence'],
    },
    {
      key: 'remediation-status',
      label: 'Remediation complete',
      statePath: ['case', 'remediationCompleted'],
    },
    {
      key: 'renewal-status',
      label: 'Renewal status',
      statePath: ['account', 'renewalStatus'],
    },
  ],
  runtimeBindings: {
    statusPath: ['clock', 'status'],
    elapsedMinutesPath: ['clock', 'elapsedMinutes'],
  },
});
