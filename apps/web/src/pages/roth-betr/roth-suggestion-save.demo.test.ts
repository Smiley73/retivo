/**
 * Saving a ranked plan on the demo household reproduces the row: the page's
 * planned projection on the saved scenario converts what the candidate did.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSuggestionCap } from '../../lib/roth-betr-apply-helpers';
import { loadDemoProjection, resolvedDeathAges } from '../../lib/roth-suggestion/demo-fixture';
import { searchRothSuggestions } from '../../lib/roth-suggestion/search';
import type {
  RothCandidate,
  RothSuggestionOk,
  RothSuggestionProjectionInput,
} from '../../lib/roth-suggestion/types';
import { resolveScenario } from '../../lib/scenario-resolution';
import { magiCapWindowsSaveError, resolveScenarioRetirementAnchor } from '../scenario-withdrawal-strategy-magi-cap-validation';
import { buildRothBETRPageData } from './roth-betr-data';

const SCENARIO_ID = 'demo-scenario-early';
const TARGET_ROTH_ID = 'demo-account-john-roth-ira';

describe('saving a ranked plan on the demo household', () => {
  let projection: RothSuggestionProjectionInput;
  let result: RothSuggestionOk;
  let candidate: RothCandidate;
  let saved: RothSuggestionProjectionInput;

  beforeAll(async () => {
    projection = await loadDemoProjection(SCENARIO_ID);
    const searched = await searchRothSuggestions({
      projection,
      targetRothAccountId: TARGET_ROTH_ID,
      leftoverTaxRate: 0.22,
      deathAges: resolvedDeathAges(projection),
    });
    if (searched.kind !== 'ok') throw new Error(`expected an ok search, got ${searched.kind}`);
    result = searched;
    const found = result.candidates.find(
      (c) => !c.isReference && c.rank !== null && c.totals.totalConvertedTodayDollars > 0,
    );
    if (found === undefined) throw new Error('no ranked plan converts anything');
    candidate = found;
    const page = buildRothBETRPageData(projection);
    if (page === null) throw new Error('demo page data is null');
    const scenario = projection.scenarios.find((s) => s.id === SCENARIO_ID);
    if (scenario === undefined) throw new Error('demo scenario missing');
    const fragment = buildSuggestionCap({
      ladder: candidate.ladder,
      localOverrides: scenario.payload.overrides,
      parentCap: page.parentCap,
    });
    saved = {
      ...projection,
      scenarios: projection.scenarios.map((s) =>
        s.id === SCENARIO_ID
          ? { ...s, payload: { ...s.payload, overrides: { ...s.payload.overrides, ...fragment } } }
          : s,
      ),
    };
  }, 60_000);

  it('re-runs to the candidate: the same conversion every year and the same balance at the horizon', () => {
    const page = buildRothBETRPageData(saved);
    expect(page).not.toBeNull();
    const rows = page?.drawdownYears ?? [];
    const converted = (years: readonly { year: number; rothConvertedCents?: number }[]) =>
      years.map((y) => [y.year, y.rothConvertedCents ?? 0]);
    expect(converted(rows)).toEqual(converted(candidate.drawdownYears));
    // The test would pass vacuously on a plan that converts nothing.
    expect(converted(rows).some(([, cents]) => cents > 0)).toBe(true);
    expect(rows[rows.length - 1].balance).toBe(
      candidate.drawdownYears[candidate.drawdownYears.length - 1].balance,
    );
  });

  it('stores one Fill window per searched year, and the editor save gate accepts it', () => {
    const cap = resolveScenario(SCENARIO_ID, [...saved.scenarios]).magiCap;
    if (cap === undefined || 'disabled' in cap) throw new Error('no saved cap');
    expect(cap.windows).toEqual(candidate.ladder);
    expect(cap.windows).toHaveLength(result.window.endYear - result.window.startYear + 1);
    const scenario = saved.scenarios.find((s) => s.id === SCENARIO_ID);
    if (scenario === undefined) throw new Error('demo scenario missing');
    const anchor = resolveScenarioRetirementAnchor(scenario, saved.scenarios, saved.members);
    expect(magiCapWindowsSaveError(cap.windows, saved.members, anchor)).toBeNull();
  });
});
