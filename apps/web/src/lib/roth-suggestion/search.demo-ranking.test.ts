/**
 * Ranking on the demo household whose plans leave different amounts in pre-tax
 * accounts at the horizon, so the leftover-tax rate changes the order. The
 * after-tax balance is recomputed by hand from each candidate's last row.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { realDeflatorAt } from '../projection-context';
import { isQualifyingAccount } from '../rmd';
import { resolveScenario } from '../scenario-resolution';
import {
  DEMO_TARGET_ROTH_ID,
  DEMO_TODAY_MONTH,
  DEMO_TODAY_YEAR,
  loadDemoProjection,
  resolvedDeathAges,
} from './demo-fixture';
import { searchRothSuggestions } from './search';
import type { RothCandidate, RothSuggestionOk, RothSuggestionProjectionInput } from './types';

describe('ranking on a household that leaves pre-tax money at the horizon', () => {
  const DELAY_RATE = 0.3;
  let projection: RothSuggestionProjectionInput;
  let result: RothSuggestionOk;

  beforeAll(async () => {
    projection = await loadDemoProjection('demo-scenario-delay');
    const searched = await searchRothSuggestions({
      projection,
      targetRothAccountId: DEMO_TARGET_ROTH_ID,
      leftoverTaxRate: DELAY_RATE,
      deathAges: resolvedDeathAges(projection),
    });
    if (searched.kind !== 'ok') throw new Error(`expected ok, got ${searched.kind}`);
    result = searched;
  }, 60_000);

  /** Ending balance less the tax rate on what is still pre-tax, by hand. */
  function afterTax(candidate: RothCandidate, rate: number): number {
    const inflation = resolveScenario(projection.selectedScenarioId, [...projection.scenarios]).inflation?.ratePct ?? 0;
    const asOfMonth = DEMO_TODAY_YEAR * 12 + DEMO_TODAY_MONTH;
    const deflator = realDeflatorAt(
      {
        asOfYear: DEMO_TODAY_YEAR,
        asOfMonthIndex: DEMO_TODAY_MONTH,
        asOfMonth,
        firstProjectionMonth: asOfMonth,
        primaryRetirementMonth: asOfMonth,
        horizonMonth: asOfMonth,
        inflationPct: inflation,
      },
      result.horizonYear,
      11,
    );
    const last = candidate.drawdownYears[candidate.drawdownYears.length - 1];
    expect(last.year).toBe(result.horizonYear);
    let preTax = 0;
    for (const account of projection.accounts) {
      const row = last.accountBalances?.get(account.id);
      if (row !== undefined && isQualifyingAccount(account.payload.type, account.payload.taxTreatment)) {
        preTax += row.preEnd;
      }
    }
    return last.balance * deflator - preTax * deflator * rate;
  }

  it('is the ending balance less the leftover tax on pre-tax money, in today dollars', () => {
    for (const candidate of result.candidates) {
      expect(candidate.afterTax.afterTaxTodayDollars).toBeCloseTo(afterTax(candidate, DELAY_RATE), 4);
    }
    // The rate only matters if some candidate still holds pre-tax money, and
    // only some do, so the ranking differs from the ranking by ending balance.
    const pre = result.candidates.map((c) => c.afterTax.preTaxTodayDollars);
    expect(pre.some((v) => v > 0)).toBe(true);
    expect(pre.some((v) => v === 0)).toBe(true);
  });

  it('orders ranked candidates by that hand computation, ties going to the grid order', () => {
    const ranked = result.candidates.filter((c) => c.unranked.length === 0);
    const byHand = ranked
      .map((c, gridIndex) => ({ c, gridIndex, value: Math.round(afterTax(c, DELAY_RATE) * 100) }))
      .sort((a, b) => b.value - a.value || a.c.totals.totalConvertedTodayDollars - b.c.totals.totalConvertedTodayDollars || a.gridIndex - b.gridIndex)
      .map(({ c }) => c.id);
    expect(result.rankedIds).toEqual(byHand);
    result.candidates.forEach((c) => {
      expect(c.rank).toBe(c.unranked.length === 0 ? byHand.indexOf(c.id) + 1 : null);
    });
    // The 12 % plans are identical here (the guards never bind): the guarded one ranks first.
    const guarded = result.candidates.find((c) => c.id === 'bracket-12-guarded');
    const unguarded = result.candidates.find((c) => c.id === 'bracket-12-unguarded');
    expect(guarded?.afterTax.afterTaxTodayDollars).toBe(unguarded?.afterTax.afterTaxTodayDollars);
    expect(guarded?.rank).toBeLessThan(unguarded?.rank ?? 0);
  });

  it('changes with the rate: a higher leftover rate favours plans that empty the pre-tax accounts', () => {
    const noTax = [...result.candidates].sort((a, b) => afterTax(b, 0) - afterTax(a, 0)).map((c) => c.id);
    expect(result.rankedIds).not.toEqual(noTax.filter((id) => result.rankedIds.includes(id)));
  });

  it('measures every total and delta against the current plan', () => {
    const reference = result.candidates[0];
    expect(reference.deltaVsReference.totalConvertedTodayDollars).toBe(0);
    for (const c of result.candidates.slice(1)) {
      expect(c.deltaVsReference.incomeTaxTodayDollars).toBeCloseTo(
        c.totals.incomeTaxTodayDollars - reference.totals.incomeTaxTodayDollars,
        6,
      );
      expect(c.deltaVsReference.yearsConverted).toBe(c.totals.yearsConverted - reference.totals.yearsConverted);
      expect(c.afterTax.deltaVsReferenceTodayDollars).toBeCloseTo(
        c.afterTax.afterTaxTodayDollars - reference.afterTax.afterTaxTodayDollars,
        6,
      );
    }
  });
});
