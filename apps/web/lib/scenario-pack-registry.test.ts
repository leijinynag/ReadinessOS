import { describe, expect, it } from 'vitest';
import {
  customerEscalationPack,
  customerEscalationPackKey,
} from '@readinessos/scenario-pack-customer-escalation';
import { saasIncidentPack, saasIncidentPackKey } from '@readinessos/scenario-pack-saas-incident';
import { validateScenarioPack } from '@readinessos/scenario-sdk';
import { buildScenarioGraph } from './scenario-graph';
import { scenarioPackRegistry } from './scenario-pack-registry';

describe('scenarioPackRegistry', () => {
  it('allows Studio, Live and Review to switch between both contract-valid packs', () => {
    const packs = [
      [saasIncidentPackKey, saasIncidentPack],
      [customerEscalationPackKey, customerEscalationPack],
    ] as const;

    for (const [key, expectedPack] of packs) {
      const resolvedPack = scenarioPackRegistry.get(key);

      expect(resolvedPack).toBe(expectedPack);
      expect(resolvedPack).toBeDefined();
      expect(validateScenarioPack(resolvedPack!).valid).toBe(true);
      expect(JSON.parse(JSON.stringify(buildScenarioGraph(resolvedPack!))).packKey).toBe(key);
    }

    expect(scenarioPackRegistry.get('unknown-pack')).toBeUndefined();
  });
});
