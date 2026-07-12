import { describe, expect, it } from 'vitest';
import { assertScenarioPack, validateScenarioPack } from '../src/index.js';
import { z } from 'zod';

describe('scenario pack contract', () => {
  it('rejects a pack whose manifest key differs from its runtime key', () => {
    const result = validateScenarioPack({
      key: 'runtime-key',
      manifest: {
        key: 'manifest-key',
        name: 'Invalid pack',
        description: 'Invalid test fixture',
        version: 1,
        estimatedDurationMinutes: 10,
      },
      stateSchema: z.object({ count: z.number() }),
      initialState: () => ({ count: 0 }),
      participants: [],
      actions: [],
      signals: [],
      injects: [],
      evaluators: [],
      uiContributions: [],
    });

    expect(result.valid).toBe(false);
    expect(() =>
      assertScenarioPack({
        key: 'runtime-key',
        manifest: {
          key: 'manifest-key',
          name: 'Invalid pack',
          description: 'Invalid test fixture',
          version: 1,
          estimatedDurationMinutes: 10,
        },
        stateSchema: z.object({ count: z.number() }),
        initialState: () => ({ count: 0 }),
        participants: [],
        actions: [],
        signals: [],
        injects: [],
        evaluators: [],
        uiContributions: [],
      }),
    ).toThrow('manifest.key');
  });

  it('rejects a UI contribution that points to an unknown state path', () => {
    const result = validateScenarioPack({
      key: 'invalid-ui-path',
      manifest: {
        key: 'invalid-ui-path',
        name: 'Invalid UI path',
        description: 'Invalid test fixture',
        version: 1,
        estimatedDurationMinutes: 10,
      },
      stateSchema: z.object({ count: z.number() }),
      initialState: () => ({ count: 0 }),
      participants: [],
      actions: [],
      signals: [],
      injects: [],
      evaluators: [],
      uiContributions: [{ key: 'unknown', label: 'Unknown', statePath: ['missing'] }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('UI Contribution unknown 引用了不存在的 State path：missing。');
  });
});
