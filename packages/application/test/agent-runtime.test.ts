import { describe, expect, it } from 'vitest';
import { observationSchema, proposedActionSchema, validateProposedAction } from '../src/index.js';

const observation = observationSchema.parse({
  organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef00',
  runId: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  participant: {
    id: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
    key: 'support',
    displayName: 'Support',
    objectives: ['communicate'],
  },
  virtualTimeMinutes: 1,
  visibleState: { status: 'active' },
  visibleSignals: [],
  recentEvents: [],
  availableActions: [{ type: 'publish_status', label: 'Publish', parameterSchema: {} }],
  budget: { remainingTurns: 1, remainingTokens: 1000 },
});

const proposal = {
  participantId: observation.participant.id,
  actionType: 'publish_status',
  parameters: { message: 'Investigating' },
  rationale: 'Customers need an update.',
  evidenceRefs: [],
  confidence: 0.8,
  clientRequestId: 'proposal-1',
};

describe('Agent runtime contracts', () => {
  it('接受属于当前参与方的可用动作', () => {
    expect(validateProposedAction(observation, proposal)).toEqual(proposal);
  });

  it('拒绝未知动作和其他参与方动作', () => {
    expect(() =>
      validateProposedAction(observation, { ...proposal, actionType: 'delete_run' }),
    ).toThrow('not available');
    expect(() =>
      validateProposedAction(observation, {
        ...proposal,
        participantId: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
      }),
    ).toThrow('does not match');
  });

  it('严格拒绝领域命令或 WorldState patch 字段', () => {
    expect(
      proposedActionSchema.safeParse({ ...proposal, commandId: 'command', worldPatch: {} }).success,
    ).toBe(false);
  });
});
