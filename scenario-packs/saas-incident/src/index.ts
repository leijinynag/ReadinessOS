import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import {
  all,
  elapsedMinutesGte,
  eventOccurred,
  stateEquals,
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
    rollbackStarted: z.boolean(),
    recovered: z.boolean(),
  }),
  impact: z.object({
    affectedCustomers: z.number().int().nonnegative(),
    estimatedRevenueLoss: z.number().nonnegative(),
    duplicateChargesDetected: z.boolean(),
  }),
  response: z.object({
    incidentDeclared: z.boolean(),
    severity: z.enum(['unknown', 'sev3', 'sev2', 'sev1']),
    ownerParticipantId: z.string().uuid().optional(),
    statusPagePublished: z.boolean(),
    customerCommsSent: z.boolean(),
  }),
  objectives: z.record(z.string(), z.enum(['healthy', 'at-risk', 'failed'])),
});

export type SaasIncidentState = z.infer<typeof saasIncidentStateSchema>;

const evidenceTypes = ['action.executed', 'inject.triggered'] as const;

function evaluation(evaluatorKey: string, score: number, summary: string): EvaluationDraft {
  return { evaluatorKey, score, summary, evidenceEventTypes: evidenceTypes };
}

export const saasIncidentPack: ScenarioPack<SaasIncidentState> = assertScenarioPack({
  key: saasIncidentPackKey,
  manifest: {
    key: saasIncidentPackKey,
    name: 'SaaS Payment Service Incident',
    description: '支付服务故障与重复扣费风险的最小确定性演练。',
    version: 1,
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
      rollbackStarted: false,
      recovered: false,
    },
    impact: {
      affectedCustomers: 0,
      estimatedRevenueLoss: 0,
      duplicateChargesDetected: false,
    },
    response: {
      incidentDeclared: false,
      severity: 'unknown',
      ownerParticipantId: undefined,
      statusPagePublished: false,
      customerCommsSent: false,
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
      capabilities: ['declare-incident', 'coordinate-response', 'close-incident'],
      permissions: ['write:incident', 'write:status-page'],
      knowledgeScopes: ['incident', 'metrics', 'customer-impact'],
      objectives: ['serviceAvailability', 'customerTrust'],
    },
    {
      id: saasIncidentParticipantIds.onCallEngineer,
      key: 'on-call-engineer',
      displayName: 'On-call Engineer',
      controller: 'agent',
      capabilities: ['inspect-metrics', 'mitigate-service', 'start-rollback', 'verify-recovery'],
      permissions: ['read:metrics', 'write:payment-writes', 'write:deployment'],
      knowledgeScopes: ['incident', 'metrics', 'provider'],
      objectives: ['serviceAvailability', 'financialIntegrity'],
    },
    {
      id: saasIncidentParticipantIds.customerSupportLead,
      key: 'customer-support-lead',
      displayName: 'Customer Support Lead',
      controller: 'agent',
      capabilities: ['publish-status', 'notify-customers'],
      permissions: ['write:status-page', 'write:customer-comms'],
      knowledgeScopes: ['incident', 'customer-impact'],
      objectives: ['customerTrust'],
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
  signals: [
    {
      key: 'payment-service-outage',
      label: 'Payment service outage detected',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'duplicate-charge-risk',
      label: 'Duplicate charge risk detected',
      requiredKnowledgeScopes: ['customer-impact'],
    },
    {
      key: 'payment-writes-disabled',
      label: 'Payment writes disabled',
      requiredKnowledgeScopes: ['incident'],
    },
    {
      key: 'provider-contacted',
      label: 'Payment provider contacted',
      requiredKnowledgeScopes: ['provider'],
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
      risk: 'low',
      approval: 'none',
      effects: [{ kind: 'record-metric', metricKey: 'payment_error_rate', value: 0.47 }],
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
        { kind: 'schedule-inject', injectKey: 'recovery-complete', delayMinutes: 2 },
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
      precondition: stateEquals<SaasIncidentState>(['impact', 'affectedCustomers'], 4800),
      effects: [{ kind: 'set-state', path: ['response', 'customerCommsSent'], value: true }],
    },
    {
      key: 'contact-provider',
      label: 'Contact payment provider',
      requiredCapabilities: ['provide-provider-update'],
      requiredPermissions: ['read:provider'],
      requiredKnowledgeScopes: ['provider'],
      risk: 'low',
      approval: 'none',
      effects: [
        {
          kind: 'emit-signal',
          signalKey: 'provider-contacted',
          recipients: [saasIncidentParticipantIds.onCallEngineer],
        },
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
        stateEquals<SaasIncidentState>(['response', 'statusPagePublished'], true),
        stateEquals<SaasIncidentState>(['response', 'customerCommsSent'], true),
      ),
      effects: [
        { kind: 'complete-run', reason: 'payment service recovered and customers notified' },
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
      key: 'duplicate-charge-escalation',
      trigger: elapsedMinutesGte<SaasIncidentState>(5),
      effects: [
        { kind: 'set-state', path: ['impact', 'duplicateChargesDetected'], value: true },
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
      key: 'recovery-complete',
      effects: [
        { kind: 'set-state', path: ['service', 'paymentSuccessRate'], value: 0.999 },
        { kind: 'set-state', path: ['service', 'errorRate'], value: 0.001 },
        { kind: 'set-state', path: ['service', 'latencyP95Ms'], value: 310 },
        { kind: 'set-state', path: ['service', 'recovered'], value: true },
        { kind: 'set-state', path: ['objectives', 'serviceAvailability'], value: 'healthy' },
      ],
    },
  ],
  evaluators: [
    {
      key: 'detection-speed',
      evaluate: ({ state }) =>
        evaluation(
          'detection-speed',
          state.world.response.incidentDeclared ? 100 : 0,
          state.world.response.incidentDeclared ? '已完成事件声明。' : '尚未声明事件。',
        ),
    },
    {
      key: 'escalation-quality',
      evaluate: ({ state }) =>
        evaluation(
          'escalation-quality',
          state.world.response.statusPagePublished ? 100 : 0,
          state.world.response.statusPagePublished ? '状态页已发布。' : '状态页尚未发布。',
        ),
    },
    {
      key: 'decision-leadership',
      evaluate: ({ state }) =>
        evaluation(
          'decision-leadership',
          state.world.response.ownerParticipantId ? 100 : 0,
          state.world.response.ownerParticipantId ? '已建立事件负责人。' : '尚未指定事件负责人。',
        ),
    },
    {
      key: 'mitigation-speed',
      evaluate: ({ state }) =>
        evaluation(
          'mitigation-speed',
          state.world.service.writesDisabled && state.world.service.rollbackStarted ? 100 : 0,
          state.world.service.writesDisabled && state.world.service.rollbackStarted
            ? '已完成写入隔离和回滚。'
            : '缓解措施尚未完成。',
        ),
    },
    {
      key: 'customer-communication',
      evaluate: ({ state }) =>
        evaluation(
          'customer-communication',
          state.world.response.customerCommsSent ? 100 : 0,
          state.world.response.customerCommsSent ? '已通知受影响客户。' : '尚未发送客户通知。',
        ),
    },
    {
      key: 'recovery-verification',
      evaluate: ({ state }) =>
        evaluation(
          'recovery-verification',
          state.world.service.recovered ? 100 : 0,
          state.world.service.recovered ? '已验证服务恢复。' : '尚未验证服务恢复。',
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
      key: 'affected-customers',
      label: 'Affected customers',
      statePath: ['impact', 'affectedCustomers'],
    },
    { key: 'incident-severity', label: 'Incident severity', statePath: ['response', 'severity'] },
  ],
  runtimeBindings: {
    statusPath: ['clock', 'status'],
    elapsedMinutesPath: ['clock', 'elapsedMinutes'],
  },
});
