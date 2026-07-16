import { describe, expect, it } from 'vitest';
import { assertScenarioPack, type ScenarioPack } from '@readinessos/scenario-sdk';
import { SimulationKernel, participantActionCountGte } from '@readinessos/simulation-kernel';
import { z } from 'zod';
import { specializeScenarioPack } from '../src/index.js';

const participantIds = {
  human: '018f4c8b-9ae2-7a72-86bd-4f867befef01',
  agent: '018f4c8b-9ae2-7a72-86bd-4f867befef02',
} as const;

const pack: ScenarioPack<{ phase: 'ready' }> = assertScenarioPack({
  key: 'runtime-specialization-test',
  manifest: {
    key: 'runtime-specialization-test',
    name: 'Runtime specialization test',
    description: '验证 Studio 参与方覆盖不会污染可信静态 Pack。',
    version: 1,
    estimatedDurationMinutes: 5,
  },
  stateSchema: z.object({ phase: z.literal('ready') }),
  initialState: () => ({ phase: 'ready' }),
  participants: [
    {
      id: participantIds.human,
      key: 'operator',
      displayName: 'Operator',
      controller: 'human',
      capabilities: ['operate'],
      permissions: ['write:run'],
      knowledgeScopes: ['run'],
      objectives: [],
    },
    {
      id: participantIds.agent,
      key: 'agent',
      displayName: 'Agent',
      controller: 'agent',
      capabilities: ['observe'],
      permissions: ['read:run'],
      knowledgeScopes: ['run'],
      objectives: [],
    },
  ],
  actions: [
    {
      key: 'notify',
      label: 'Notify',
      risk: 'low',
      approval: 'none',
      effects: [
        {
          kind: 'emit-signal',
          signalKey: 'run-update',
          recipients: [participantIds.human, participantIds.agent],
        },
        {
          kind: 'change-participant-status',
          participantId: participantIds.agent,
          status: 'blocked',
        },
      ],
    },
    {
      key: 'agent-dependent-action',
      label: 'Agent dependent action',
      risk: 'low',
      approval: 'none',
      precondition: participantActionCountGte(participantIds.agent, 'notify', 1),
      effects: [],
    },
  ],
  signals: [{ key: 'run-update', label: 'Run update', requiredKnowledgeScopes: ['run'] }],
  injects: [
    {
      key: 'agent-dependent-inject',
      trigger: participantActionCountGte(participantIds.agent, 'notify', 1),
      effects: [],
    },
  ],
  evaluators: [],
  uiContributions: [],
});

describe('specializeScenarioPack', () => {
  it('兼容没有 participants 覆盖的历史 ScenarioVersion', () => {
    expect(specializeScenarioPack(pack, { packKey: pack.key })).toBe(pack);
  });

  it('只覆写 controller，并清除被停用参与方的运行时引用', () => {
    const specialized = specializeScenarioPack(pack, {
      packKey: pack.key,
      participants: [
        {
          id: participantIds.human,
          enabled: true,
          controller: 'system',
        },
      ],
    });

    expect(specialized).not.toBe(pack);
    expect(specialized.participants).toEqual([
      expect.objectContaining({
        id: participantIds.human,
        controller: 'system',
        capabilities: ['operate'],
        permissions: ['write:run'],
        knowledgeScopes: ['run'],
      }),
    ]);
    expect(specialized.actions.map((action) => action.key)).toEqual(['notify']);
    expect(specialized.injects).toHaveLength(0);
    expect(specialized.actions[0]?.effects).toEqual([
      {
        kind: 'emit-signal',
        signalKey: 'run-update',
        recipients: [participantIds.human],
      },
    ]);

    // 内核构造会重新校验所有 effects，证明专门化后不存在悬空参与方引用。
    const kernel = new SimulationKernel(specialized);
    const created = kernel.initialize({
      organizationId: '018f4c8b-9ae2-7a72-86bd-4f867befef03',
      runId: '018f4c8b-9ae2-7a72-86bd-4f867befef04',
      seed: 1,
      simulatedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(created.participants).toEqual(
      expect.objectContaining({
        [participantIds.human]: expect.objectContaining({ controller: 'system' }),
      }),
    );
    expect(created.participants[participantIds.agent]).toBeUndefined();
    expect(pack.participants).toHaveLength(2);
  });

  it.each([
    {
      participants: [
        {
          id: '018f4c8b-9ae2-7a72-86bd-4f867befef09',
          enabled: true,
          controller: 'human',
        },
      ],
    },
    {
      participants: [
        { id: participantIds.human, enabled: true, controller: 'human' },
        { id: participantIds.human, enabled: true, controller: 'agent' },
      ],
    },
  ])('拒绝未知或重复参与方覆盖', ({ participants }) => {
    expect(() =>
      specializeScenarioPack(pack, {
        packKey: pack.key,
        participants,
      }),
    ).toThrow(/unknown participant|duplicate participant/i);
  });
});
