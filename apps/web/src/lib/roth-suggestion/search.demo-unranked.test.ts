/**
 * Candidates that cannot be ranked, on the demo scenario whose spending runs
 * the portfolio out: a plan whose cap was not met is returned with the reason
 * and no rank. (A guarded plan that still crosses a guarded line is covered on
 * a toy household: the guards are held to zero conversion, which this
 * household's guarded plans no longer cross.)
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TARGET_ROTH_ID, loadDemoProjection, resolvedDeathAges } from './demo-fixture';
import { searchRothSuggestions } from './search';
import type { RothSuggestionOk } from './types';

describe('unranked candidates on the funds-run-out demo scenario', () => {
  let result: RothSuggestionOk;

  beforeAll(async () => {
    const projection = await loadDemoProjection('demo-scenario-early-no-contrib');
    const searched = await searchRothSuggestions({
      projection,
      targetRothAccountId: DEMO_TARGET_ROTH_ID,
      leftoverTaxRate: 0.22,
      deathAges: resolvedDeathAges(projection),
    });
    if (searched.kind !== 'ok') throw new Error(`expected ok, got ${searched.kind}`);
    result = searched;
  }, 60_000);

  it('returns the current plan unranked with the years its own cap was breached', () => {
    const reference = result.candidates[0];
    const breached = reference.drawdownYears
      .filter((r) => (r.magiCapBreachDollars ?? 0) > 0)
      .map((r) => r.year);
    expect(breached.length).toBeGreaterThan(0);
    expect(reference.unranked).toEqual([{ kind: 'cap-breached', years: breached }]);
    expect(reference.rank).toBeNull();
    expect(result.rankedIds).not.toContain(reference.id);
  });

  it('never ranks an unguarded plan out for crossing a line it was not asked to hold', () => {
    for (const candidate of result.candidates.filter((c) => c.guarded === false)) {
      expect(candidate.unranked.filter((u) => u.kind === 'guard-crossed')).toEqual([]);
    }
  });

  it('ranks only candidates with no reason against them', () => {
    for (const candidate of result.candidates) {
      expect(candidate.rank === null).toBe(candidate.unranked.length > 0);
    }
  });
});
