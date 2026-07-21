import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import {
  all,
  elapsedMinutesGte,
  eventOccurred,
  not,
  participantActionCountGte,
  stateEquals,
  stateNumberGte,
  type EvaluationDraft,
} from '@readinessos/simulation-kernel';
import { z } from 'zod';

export const saasIncidentPackKey = 'saas-incident';

export const saasIncidentParticipantIds = {
  incidentCommander: '018f4c8b-9ae2-7a72-86bd-4f867befede1',
  onCallEngineer: '018f4c8b-9ae2-7a72-86bd-4f867befede2',
  customerSupportLead: '018f4c8b-9ae2-7a72-86bd-4f867befede3',
  executiveStakeholder: '018f4c8b-9ae2-7a72-86bd-4f867befede4',
  monitoringSystem: '018f4c8b-9ae2-7a72-86bd-4f867befede5',
  paymentProvider: '018f4c8b-9ae2-7a72-86bd-4f867befede6',
} as const;

export const saasIncidentStateSchema = z.object({
  clock: z.object({
    elapsedMinutes: z.number().int().nonnegative(),
    status: z.enum(['idle', 'running', 'paused', 'completed']),
  }),
  service: z.object({
    paymentSuccessRate: z.number().min(0).max(1),
    errorRate: z.number().min(0).max(1),
    latencyP95Ms: z.number().int().nonnegative(),
    writesDisabled: z.boolean(),
    retryTrafficFrozen: z.boolean(),
    rollbackStarted: z.boolean(),
    providerIncidentConfirmed: z.boolean(),
    providerStatus: z.enum(['unknown', 'degraded', 'recovering', 'healthy']),
    recovered: z.boolean(),
  }),
  impact: z.object({
    affectedCustomers: z.number().int().nonnegative(),
    estimatedRevenueLoss: z.number().nonnegative(),
    duplicateChargesDetected: z.boolean(),
    duplicateChargeCount: z.number().int().nonnegative(),
    supportQueueDepth: z.number().int().nonnegative(),
  }),
  response: z.object({
    incidentDeclared: z.boolean(),
    severity: z.enum(['unknown', 'sev3', 'sev2', 'sev1']),
    // 旧 Run 的 JSON 快照没有该字段。默认值保证历史状态在下一次
    // Kernel 校验和重放时能够兼容，而不是因 schema 演进中断演练。
    ownerParticipantId: z.string().uuid().nullable().default(null),
    statusPagePublished: z.boolean(),
    customerCommsSent: z.boolean(),
    providerContacted: z.boolean(),
    executiveBriefed: z.boolean(),
    reconciliationStarted: z.boolean(),
    reconciliationCompleted: z.boolean(),
    recoveryVerified: z.boolean(),
  }),
  objectives: z.record(z.string(), z.enum(['healthy', 'at-risk', 'failed'])),
});

export type SaasIncidentState = z.infer<typeof saasIncidentStateSchema>;

const evidenceTypes = ['action.executed', 'inject.triggered'] as const;

/**
 * 当前 Evaluator 契约只能按事件类型引用 Evidence。每项评分都要求至少一项
 * 关键动作或场景 Inject，因此 Review 侧可稳定定位到对应运行时间线。
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

export const saasIncidentPack: ScenarioPack<SaasIncidentState> = assertScenarioPack({
  key: saasIncidentPackKey,
  manifest: {
    key: saasIncidentPackKey,
    name: 'SaaS Payment Service Incident',
    description: '支付服务故障、重复扣费风险与跨职能响应的确定性演练。',
    version: 2,
    estimatedDurationMinutes: 15,
  },
  stateSchema: saasIncidentStateSchema,
  initialState: () => ({
    clock: {
      elapsedMinutes: 0,
      status: 'idle',
    },
    service: {
      paymentSuccessRate: 0.998,
      errorRate: 0.002,
      latencyP95Ms: 280,
      writesDisabled: false,
      retryTrafficFrozen: false,
      rollbackStarted: false,
      providerIncidentConfirmed: false,
      providerStatus: 'unknown',
      recovered: false,
    },
    impact: {
      affectedCustomers: 0,
      estimatedRevenueLoss: 0,
      duplicateChargesDetected: false,
      duplicateChargeCount: 0,
      supportQueueDepth: 0,
    },
    response: {
      incidentDeclared: false,
      severity: 'unknown',
      // Run 状态会以 JSON 写入数据库。使用 null 保留路径，避免后续
      // declare-incident 的 set-state effect 在恢复运行后找不到该字段。
      ownerParticipantId: null,
      statusPagePublished: false,
      customerCommsSent: false,
      providerContacted: false,
      executiveBriefed: false,
      reconciliationStarted: false,
      reconciliationCompleted: false,
      recoveryVerified: false,
    },
    objectives: {
      serviceAvailability: 'healthy',
      customerTrust: 'healthy',
      financialIntegrity: 'healthy',
    },
  }),
  participants: [
    {
      id: saasIncidentParticipantIds.incidentCommander,
      key: 'incident-commander',
      displayName: 'Incident Commander',
      controller: 'human',
      capabilities: [
        'declare-incident',
        'coordinate-response',
        'brief-executives',
        'close-incident',
      ],
      permissions: ['write:incident', 'write:status-page', 'write:executive-briefing'],
      knowledgeScopes: ['incident', 'metrics', 'customer-impact'],
      objectives: ['serviceAvailability', 'customerTrust'],
    },
    {
      id: saasIncidentParticipantIds.onCallEngineer,
      key: 'on-call-engineer',
      displayName: 'On-call Engineer',
      controller: 'agent',
      capabilities: [
        'inspect-metrics',
        'mitigate-service',
        'freeze-payment-retries',
        'start-rollback',
        'contact-provider',
        'verify-recovery',
      ],
      permissions: [
        'read:metrics',
        'write:payment-writes',
        'write:payment-retries',
        'write:deployment',
        'write:provider-ticket',
      ],
      knowledgeScopes: ['incident', 'metrics', 'provider'],
      objectives: ['serviceAvailability', 'financialIntegrity'],
    },
    {
      id: saasIncidentParticipantIds.customerSupportLead,
      key: 'customer-support-lead',
      displayName: 'Customer Support Lead',
      controller: 'agent',
      capabilities: ['publish-status', 'notify-customers', 'reconcile-duplicate-charges'],
      permissions: ['write:status-page', 'write:customer-comms', 'write:financial-remediation'],
      knowledgeScopes: ['incident', 'customer-impact'],
      objectives: ['customerTrust', 'financialIntegrity'],
    },
    {
      id: saasIncidentParticipantIds.executiveStakeholder,
      key: 'executive-stakeholder',
      displayName: 'Executive Stakeholder',
      controller: 'agent',
      capabilities: ['review-impact'],
      permissions: ['read:incident'],
      knowledgeScopes: ['incident', 'customer-impact'],
      objectives: ['customerTrust', 'financialIntegrity'],
    },
    {
      id: saasIncidentParticipantIds.monitoringSystem,
      key: 'monitoring-system',
      displayName: 'Monitoring System',
      controller: 'system',
      capabilities: [],
      permissions: [],
      knowledgeScopes: ['metrics', 'incident'],
      objectives: ['serviceAvailability'],
    },
    {
      id: saasIncidentParticipantIds.paymentProvider,
      key: 'payment-provider',
      displayName: 'Payment Provider',
      controller: 'agent',
      capabilities: ['provide-provider-update'],
      permissions: ['read:provider'],
      knowledgeScopes: ['provider', 'incident'],
      objectives: ['serviceAvailability'],
    },
  ],
  agentPolicy: {
    advisors: [
      {
        advisorParticipantKey: 'on-call-engineer',
        triggerEventTypes: [
          'run.started',
          'inject.triggered',
          'signal.emitted',
          'action.executed',
          'action.rejected',
          'action.approved',
          'action.denied',
          'action.approval_expired',
          'clock.advanced',
        ],
        recommendationPermissions: [
          {
            targetParticipantKey: 'incident-commander',
            actionType: 'declare-incident',
          },
          { targetParticipantKey: 'on-call-engineer', actionType: 'inspect-metrics' },
          { targetParticipantKey: 'on-call-engineer', actionType: 'freeze-payment-retries' },
          { targetParticipantKey: 'on-call-engineer', actionType: 'disable-payment-writes' },
          { targetParticipantKey: 'on-call-engineer', actionType: 'contact-provider' },
          { targetParticipantKey: 'on-call-engineer', actionType: 'start-rollback' },
          { targetParticipantKey: 'on-call-engineer', actionType: 'verify-recovery' },
        ],
      },
      {
        advisorParticipantKey: 'customer-support-lead',
        triggerEventTypes: [
          'run.started',
          'inject.triggered',
          'signal.emitted',
          'action.executed',
          'action.approved',
          'action.denied',
          'action.approval_expired',
        ],
        recommendationPermissions: [
          { targetParticipantKey: 'customer-support-lead', actionType: 'publish-status' },
          { targetParticipantKey: 'customer-support-lead', actionType: 'notify-customers' },
          {
            targetParticipantKey: 'customer-support-lead',
            actionType: 'start-duplicate-charge-reconciliation',
          },
        ],
      },
      {
        advisorParticipantKey: 'executive-stakeholder',
        triggerEventTypes: [
          'run.started',
          'inject.triggered',
          'signal.emitted',
          'action.approved',
          'action.denied',
          'clock.advanced',
        ],
        recommendationPermissions: [
          { targetParticipantKey: 'incident-commander', actionType: 'brief-executives' },
        ],
      },
      {
        advisorParticipantKey: 'payment-provider',
        // Provider 只有在已被联系或明确给出恢复进度后才应介入。初始 outage
        // 触发时让它提出“验证恢复”既没有事实基础，也会干扰 IC 的处置优先级。
        triggerEventTypes: ['signal.emitted', 'inject.triggered'],
        triggerInjectKeys: ['provider-status-update'],
        triggerSignalKeys: ['provider-contacted', 'provider-recovery-update'],
        recommendationPermissions: [
          { targetParticipantKey: 'on-call-engineer', actionType: 'verify-recovery' },
        ],
      },
    ],
  },
  signals: [
    {
      key: 'payment-service-outage',
      label: 'Payment service outage detected',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'monitoring-confirmed',
      label: 'Monitoring confirms payment error spike',
      requiredKnowledgeScopes: ['metrics'],
    },
    {
      key: 'retry-traffic-surge',
      label: 'Automatic retries are increasing payment load',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'provider-response-delayed',
      label: 'Payment provider response is delayed',
      requiredKnowledgeScopes: ['provider'],
    },
    {
      key: 'support-queue-spike',
      label: 'Customer support queue is escalating',
      requiredKnowledgeScopes: ['customer-impact'],
    },
    {
      key: 'duplicate-charge-risk',
      label: 'Duplicate charge risk detected',
      requiredKnowledgeScopes: ['customer-impact'],
    },
    {
      key: 'executive-escalation',
      label: 'Executive update is required',
      requiredKnowledgeScopes: ['customer-impact'],
    },
    {
      key: 'provider-contacted',
      label: 'Payment provider contacted',
      requiredKnowledgeScopes: ['provider'],
    },
    {
      key: 'provider-recovery-update',
      label: 'Payment provider reports recovery in progress',
      requiredKnowledgeScopes: ['provider'],
    },
    {
      key: 'payment-writes-disabled',
      label: 'Payment writes disabled',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'payment-retries-frozen',
      label: 'Automatic payment retries frozen',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'reconciliation-started',
      label: 'Duplicate charge reconciliation started',
      requiredKnowledgeScopes: ['customer-impact'],
    },
    {
      key: 'recovery-verified',
      label: 'Service recovery verified',
      requiredKnowledgeScopes: ['incident'],
    },
  ],
  actions: [
    {
      key: 'declare-incident',
      label: 'Declare incident',
      requiredCapabilities: ['declare-incident'],
      requiredPermissions: ['write:incident'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'low',
      approval: 'none',
      effects: [
        { kind: 'set-state', path: ['response', 'incidentDeclared'], value: true },
        { kind: 'set-state', path: ['response', 'severity'], value: 'sev1' },
        {
          kind: 'set-state',
          path: ['response', 'ownerParticipantId'],
          value: saasIncidentParticipantIds.incidentCommander,
        },
      ],
    },
    {
      key: 'inspect-metrics',
      label: 'Inspect payment metrics',
      requiredCapabilities: ['inspect-metrics'],
      requiredPermissions: ['read:metrics'],
      requiredKnowledgeScopes: ['metrics'],
      // 首次观测会触发 monitoring-confirmation Inject；确认上游故障后，
      // 重复拉取同一组指标不再构成有效的下一步，避免 Agent 循环推荐。
      precondition: not(
        stateEquals<SaasIncidentState>(['service', 'providerIncidentConfirmed'], true),
      ),
      risk: 'low',
      approval: 'none',
      effects: [{ kind: 'record-metric', metricKey: 'payment_error_rate', value: 0.47 }],
    },
    {
      key: 'freeze-payment-retries',
      label: 'Freeze automatic payment retries',
      requiredCapabilities: ['freeze-payment-retries'],
      requiredPermissions: ['write:payment-retries'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'high',
      approval: 'required',
      precondition: stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
      effects: [
        { kind: 'set-state', path: ['service', 'retryTrafficFrozen'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'payment-retries-frozen',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.customerSupportLead,
          ],
        },
      ],
    },
    {
      key: 'disable-payment-writes',
      label: 'Disable payment writes',
      requiredCapabilities: ['mitigate-service'],
      requiredPermissions: ['write:payment-writes'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'high',
      approval: 'required',
      precondition: stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
      effects: [
        { kind: 'set-state', path: ['service', 'writesDisabled'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'payment-writes-disabled',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.customerSupportLead,
            saasIncidentParticipantIds.executiveStakeholder,
          ],
        },
      ],
    },
    {
      key: 'start-rollback',
      label: 'Start rollback',
      requiredCapabilities: ['start-rollback'],
      requiredPermissions: ['write:deployment'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'high',
      approval: 'required',
      precondition: all(
        stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
        stateEquals<SaasIncidentState>(['service', 'writesDisabled'], true),
      ),
      effects: [
        { kind: 'set-state', path: ['service', 'rollbackStarted'], value: true },
        { kind: 'set-state', path: ['service', 'providerStatus'], value: 'recovering' },
        { kind: 'schedule-inject', injectKey: 'recovery-complete', delayMinutes: 2 },
      ],
    },
    {
      key: 'contact-provider',
      label: 'Contact payment provider',
      requiredCapabilities: ['contact-provider'],
      requiredPermissions: ['write:provider-ticket'],
      requiredKnowledgeScopes: ['provider'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
      effects: [
        { kind: 'set-state', path: ['response', 'providerContacted'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'provider-contacted',
          recipients: [
            saasIncidentParticipantIds.onCallEngineer,
            saasIncidentParticipantIds.paymentProvider,
          ],
        },
        { kind: 'schedule-inject', injectKey: 'provider-status-update', delayMinutes: 1 },
      ],
    },
    {
      key: 'publish-status',
      label: 'Publish service status',
      requiredCapabilities: ['publish-status'],
      requiredPermissions: ['write:status-page'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
      effects: [{ kind: 'set-state', path: ['response', 'statusPagePublished'], value: true }],
    },
    {
      key: 'notify-customers',
      label: 'Notify affected customers',
      requiredCapabilities: ['notify-customers'],
      requiredPermissions: ['write:customer-comms'],
      requiredKnowledgeScopes: ['customer-impact'],
      risk: 'low',
      approval: 'none',
      precondition: all(
        stateEquals<SaasIncidentState>(['response', 'statusPagePublished'], true),
        stateNumberGte<SaasIncidentState>(['impact', 'affectedCustomers'], 4_800),
      ),
      effects: [{ kind: 'set-state', path: ['response', 'customerCommsSent'], value: true }],
    },
    {
      key: 'brief-executives',
      label: 'Brief executive stakeholders',
      requiredCapabilities: ['brief-executives'],
      requiredPermissions: ['write:executive-briefing'],
      requiredKnowledgeScopes: ['customer-impact'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<SaasIncidentState>(['response', 'incidentDeclared'], true),
      effects: [{ kind: 'set-state', path: ['response', 'executiveBriefed'], value: true }],
    },
    {
      key: 'start-duplicate-charge-reconciliation',
      label: 'Start duplicate charge reconciliation',
      requiredCapabilities: ['reconcile-duplicate-charges'],
      requiredPermissions: ['write:financial-remediation'],
      requiredKnowledgeScopes: ['customer-impact'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<SaasIncidentState>(['impact', 'duplicateChargesDetected'], true),
      effects: [
        { kind: 'set-state', path: ['response', 'reconciliationStarted'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'reconciliation-started',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.executiveStakeholder,
          ],
        },
        { kind: 'schedule-inject', injectKey: 'reconciliation-complete', delayMinutes: 1 },
      ],
    },
    {
      key: 'verify-recovery',
      label: 'Verify recovery',
      requiredCapabilities: ['verify-recovery'],
      requiredPermissions: ['read:metrics'],
      requiredKnowledgeScopes: ['metrics'],
      risk: 'low',
      approval: 'none',
      precondition: stateEquals<SaasIncidentState>(['service', 'recovered'], true),
      effects: [
        { kind: 'set-state', path: ['response', 'recoveryVerified'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'recovery-verified',
          recipients: [saasIncidentParticipantIds.incidentCommander],
        },
        { kind: 'set-state', path: ['objectives', 'serviceAvailability'], value: 'healthy' },
      ],
    },
    {
      key: 'close-incident',
      label: 'Close incident',
      requiredCapabilities: ['close-incident'],
      requiredPermissions: ['write:incident'],
      requiredKnowledgeScopes: ['incident'],
      risk: 'low',
      approval: 'none',
      precondition: all(
        stateEquals<SaasIncidentState>(['service', 'recovered'], true),
        stateEquals<SaasIncidentState>(['response', 'recoveryVerified'], true),
        stateEquals<SaasIncidentState>(['response', 'statusPagePublished'], true),
        stateEquals<SaasIncidentState>(['response', 'customerCommsSent'], true),
        stateEquals<SaasIncidentState>(['response', 'executiveBriefed'], true),
        stateEquals<SaasIncidentState>(['response', 'reconciliationCompleted'], true),
      ),
      effects: [
        {
          kind: 'complete-run',
          reason: 'payment service recovered, customers informed, and duplicate charges reconciled',
        },
      ],
    },
  ],
  injects: [
    {
      key: 'payment-service-outage',
      trigger: eventOccurred<SaasIncidentState>('run.started'),
      effects: [
        { kind: 'set-state', path: ['service', 'paymentSuccessRate'], value: 0.53 },
        { kind: 'set-state', path: ['service', 'errorRate'], value: 0.47 },
        { kind: 'set-state', path: ['service', 'latencyP95Ms'], value: 5_800 },
        { kind: 'set-state', path: ['service', 'providerStatus'], value: 'degraded' },
        { kind: 'set-state', path: ['impact', 'affectedCustomers'], value: 4_800 },
        { kind: 'set-state', path: ['impact', 'estimatedRevenueLoss'], value: 38_000 },
        { kind: 'set-state', path: ['objectives', 'serviceAvailability'], value: 'failed' },
        { kind: 'set-state', path: ['objectives', 'customerTrust'], value: 'at-risk' },
        {
          kind: 'emit-signal',
          signalKey: 'payment-service-outage',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.onCallEngineer,
            saasIncidentParticipantIds.customerSupportLead,
            saasIncidentParticipantIds.executiveStakeholder,
          ],
        },
      ],
    },
    {
      key: 'monitoring-confirmation',
      trigger: participantActionCountGte<SaasIncidentState>(
        saasIncidentParticipantIds.onCallEngineer,
        'inspect-metrics',
        1,
      ),
      effects: [
        { kind: 'set-state', path: ['service', 'providerIncidentConfirmed'], value: true },
        {
          kind: 'emit-signal',
          signalKey: 'monitoring-confirmed',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.onCallEngineer,
          ],
        },
      ],
    },
    {
      key: 'retry-traffic-surge',
      trigger: all(
        elapsedMinutesGte<SaasIncidentState>(2),
        not(stateEquals<SaasIncidentState>(['service', 'retryTrafficFrozen'], true)),
      ),
      effects: [
        { kind: 'increment-state', path: ['impact', 'affectedCustomers'], amount: 1_200 },
        { kind: 'increment-state', path: ['impact', 'estimatedRevenueLoss'], amount: 14_000 },
        {
          kind: 'emit-signal',
          signalKey: 'retry-traffic-surge',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.onCallEngineer,
          ],
        },
      ],
    },
    {
      key: 'provider-response-delay',
      trigger: all(
        elapsedMinutesGte<SaasIncidentState>(3),
        not(stateEquals<SaasIncidentState>(['response', 'providerContacted'], true)),
      ),
      effects: [
        { kind: 'increment-state', path: ['impact', 'estimatedRevenueLoss'], amount: 9_000 },
        {
          kind: 'emit-signal',
          signalKey: 'provider-response-delayed',
          recipients: [saasIncidentParticipantIds.onCallEngineer],
        },
      ],
    },
    {
      key: 'support-queue-spike',
      trigger: elapsedMinutesGte<SaasIncidentState>(4),
      effects: [
        { kind: 'set-state', path: ['impact', 'supportQueueDepth'], value: 640 },
        {
          kind: 'emit-signal',
          signalKey: 'support-queue-spike',
          recipients: [
            saasIncidentParticipantIds.customerSupportLead,
            saasIncidentParticipantIds.incidentCommander,
          ],
        },
      ],
    },
    {
      key: 'duplicate-charge-escalation',
      trigger: elapsedMinutesGte<SaasIncidentState>(5),
      effects: [
        { kind: 'set-state', path: ['impact', 'duplicateChargesDetected'], value: true },
        { kind: 'set-state', path: ['impact', 'duplicateChargeCount'], value: 87 },
        { kind: 'set-state', path: ['objectives', 'financialIntegrity'], value: 'at-risk' },
        {
          kind: 'emit-signal',
          signalKey: 'duplicate-charge-risk',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.customerSupportLead,
            saasIncidentParticipantIds.executiveStakeholder,
          ],
        },
      ],
    },
    {
      key: 'executive-escalation',
      trigger: all(
        elapsedMinutesGte<SaasIncidentState>(6),
        not(stateEquals<SaasIncidentState>(['response', 'executiveBriefed'], true)),
      ),
      effects: [
        {
          kind: 'emit-signal',
          signalKey: 'executive-escalation',
          recipients: [
            saasIncidentParticipantIds.incidentCommander,
            saasIncidentParticipantIds.executiveStakeholder,
          ],
        },
      ],
    },
    {
      key: 'provider-status-update',
      effects: [
        { kind: 'set-state', path: ['service', 'providerStatus'], value: 'recovering' },
        {
          kind: 'emit-signal',
          signalKey: 'provider-recovery-update',
          recipients: [saasIncidentParticipantIds.onCallEngineer],
        },
      ],
    },
    {
      key: 'recovery-complete',
      effects: [
        { kind: 'set-state', path: ['service', 'paymentSuccessRate'], value: 0.999 },
        { kind: 'set-state', path: ['service', 'errorRate'], value: 0.001 },
        { kind: 'set-state', path: ['service', 'latencyP95Ms'], value: 310 },
        { kind: 'set-state', path: ['service', 'providerStatus'], value: 'healthy' },
        { kind: 'set-state', path: ['service', 'recovered'], value: true },
      ],
    },
    {
      key: 'reconciliation-complete',
      effects: [
        { kind: 'set-state', path: ['response', 'reconciliationCompleted'], value: true },
        { kind: 'set-state', path: ['objectives', 'financialIntegrity'], value: 'healthy' },
      ],
    },
  ],
  evaluators: [
    {
      key: 'detection-speed',
      evaluate: ({ state }) =>
        evaluation(
          'detection-speed',
          score(
            state.world.response.incidentDeclared && state.world.service.providerIncidentConfirmed,
            state.world.response.incidentDeclared,
          ),
          state.world.response.incidentDeclared && state.world.service.providerIncidentConfirmed
            ? '已声明 SEV1 并通过监控确认支付故障。'
            : state.world.response.incidentDeclared
              ? '已声明事件，但尚未完成监控确认。'
              : '尚未声明支付服务事件。',
        ),
    },
    {
      key: 'escalation-quality',
      evaluate: ({ state }) =>
        evaluation(
          'escalation-quality',
          score(
            state.world.response.statusPagePublished && state.world.response.executiveBriefed,
            state.world.response.statusPagePublished,
          ),
          state.world.response.statusPagePublished && state.world.response.executiveBriefed
            ? '状态页与管理层沟通均已完成。'
            : state.world.response.statusPagePublished
              ? '已发布状态页，但尚未完成管理层同步。'
              : '尚未建立对外升级沟通。',
        ),
    },
    {
      key: 'decision-leadership',
      evaluate: ({ state }) =>
        evaluation(
          'decision-leadership',
          score(
            Boolean(state.world.response.ownerParticipantId) &&
              state.world.service.retryTrafficFrozen &&
              state.world.service.writesDisabled,
            Boolean(state.world.response.ownerParticipantId),
          ),
          state.world.service.retryTrafficFrozen && state.world.service.writesDisabled
            ? '负责人已明确，并完成重试冻结和写入隔离。'
            : state.world.response.ownerParticipantId
              ? '已明确负责人，但关键风险决策尚未全部执行。'
              : '尚未形成明确的事件指挥责任。',
        ),
    },
    {
      key: 'mitigation-speed',
      evaluate: ({ state }) =>
        evaluation(
          'mitigation-speed',
          score(
            state.world.service.writesDisabled &&
              state.world.service.rollbackStarted &&
              state.world.service.recovered,
            state.world.service.writesDisabled || state.world.service.rollbackStarted,
          ),
          state.world.service.recovered
            ? '隔离、回滚和服务恢复均已完成。'
            : '服务缓解动作尚未形成恢复闭环。',
        ),
    },
    {
      key: 'customer-communication',
      evaluate: ({ state }) =>
        evaluation(
          'customer-communication',
          score(
            state.world.response.statusPagePublished &&
              state.world.response.customerCommsSent &&
              state.world.response.reconciliationStarted,
            state.world.response.statusPagePublished || state.world.response.customerCommsSent,
          ),
          state.world.response.customerCommsSent && state.world.response.reconciliationStarted
            ? '客户通知和重复扣费处置均已启动。'
            : '客户影响沟通或财务补救尚未完整覆盖。',
        ),
    },
    {
      key: 'recovery-verification',
      evaluate: ({ state }) =>
        evaluation(
          'recovery-verification',
          score(
            state.world.service.recovered &&
              state.world.response.recoveryVerified &&
              state.world.response.reconciliationCompleted,
            state.world.service.recovered,
          ),
          state.world.response.recoveryVerified && state.world.response.reconciliationCompleted
            ? '恢复指标已验证，重复扣费对账已完成。'
            : '尚未完成可审计的恢复验证与后续处置。',
        ),
    },
  ],
  uiContributions: [
    {
      key: 'payment-success-rate',
      label: 'Payment success rate',
      statePath: ['service', 'paymentSuccessRate'],
    },
    {
      key: 'provider-status',
      label: 'Provider status',
      statePath: ['service', 'providerStatus'],
    },
    {
      key: 'affected-customers',
      label: 'Affected customers',
      statePath: ['impact', 'affectedCustomers'],
    },
    {
      key: 'support-queue-depth',
      label: 'Support queue depth',
      statePath: ['impact', 'supportQueueDepth'],
    },
    { key: 'incident-severity', label: 'Incident severity', statePath: ['response', 'severity'] },
  ],
  runtimeBindings: {
    statusPath: ['clock', 'status'],
    elapsedMinutesPath: ['clock', 'elapsedMinutes'],
  },
});
