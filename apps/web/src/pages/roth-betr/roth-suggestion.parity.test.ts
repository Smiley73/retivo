/** The search's reference candidate reproduces the page's planned rows exactly. */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDemoProjection, resolvedDeathAges } from '../../lib/roth-suggestion/demo-fixture';
import { searchRothSuggestions } from '../../lib/roth-suggestion/search';
import type { RothSuggestionProjectionInput } from '../../lib/roth-suggestion/types';
import { buildRothBETRPageData } from './roth-betr-data';

const SCENARIO_IDS = [
  'demo-scenario-base',
  'demo-scenario-delay',
  'demo-scenario-early',
  'demo-scenario-early-no-contrib',
];
const TARGET_ROTH_ID = 'demo-account-john-roth-ira';

describe('roth suggestion reference candidate', () => {
  let projection: RothSuggestionProjectionInput;

  beforeAll(async () => {
    projection = await loadDemoProjection(SCENARIO_IDS[0]);
  });

  it.each(SCENARIO_IDS)(
    'reproduces the page planned rows exactly for %s when the death ages are the resolved ones',
    { timeout: 60_000 },
    async (scenarioId) => {
      const input = { ...projection, selectedScenarioId: scenarioId };
      const page = buildRothBETRPageData(input);
      expect(page).not.toBeNull();
      const result = await searchRothSuggestions({
        projection: input,
        targetRothAccountId: TARGET_ROTH_ID,
        leftoverTaxRate: 0.2,
        deathAges: resolvedDeathAges(input),
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok' || page === null) return;
      const reference = result.candidates[0];
      expect(reference.isReference).toBe(true);
      expect(reference.drawdownYears.length).toBeGreaterThan(0);
      expect(reference.drawdownYears).toEqual(page.drawdownYears);
      // The reference carries the scenario's own ladder, not one of ours.
      expect(reference.ladder).toEqual(page.parentCap?.windows ?? []);
    },
  );
});
