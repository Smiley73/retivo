/**
 * The search on the demo household: the numbers a person could check by hand.
 * Limits recompute from the calibration tables, guards hold on the projected
 * rows (not merely on the ceilings), and the ranking is a hand computation.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PROJECTIONS } from './projection';

vi.mock('../balance-projection-runner-drawdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../balance-projection-runner-drawdown')>();
  return { ...actual, runDrawdownForMethod: vi.fn(actual.runDrawdownForMethod) };
});

import { runDrawdownForMethod } from '../balance-projection-runner-drawdown';
import { hasAttainedAgeByYearEnd } from '../balance-projection-runner-tax-helpers';
import { resolveFederalTaxSnapshotForYear } from '../federal-tax-extrapolation';
import { fplDollarsForRegion } from '../aca-ptc';
import { realDeflatorAt } from '../projection-context';
import { resolveScenario } from '../scenario-resolution';
import { DEFAULT_TAX_CALIBRATION_BUNDLE, resolveSnapshotYear } from '../tax-integration-helpers';
import {
  DEMO_EARLY_SCENARIO_ID,
  DEMO_TARGET_ROTH_ID,
  DEMO_TODAY_MONTH,
  DEMO_TODAY_YEAR,
  loadDemoProjection,
  resolvedDeathAges,
} from './demo-fixture';
import { searchRothSuggestions } from './search';
import type {
  RothCandidate,
  RothSuggestionOk,
  RothSuggestionProjectionInput,
  RothSuggestionRequest,
} from './types';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;
const RATE = 0.22;
const TIMEOUT = { timeout: 60_000 };

/** Projections the demo search runs, pinned: a pass loop that doubled would
 *  slip through a toy fixture but not through this count. */
const DEMO_EARLY_PROJECTION_COUNT = 29;

async function runSearch(
  projection: RothSuggestionProjectionInput,
  overrides: Partial<RothSuggestionRequest> = {},
): Promise<RothSuggestionOk> {
  const result = await searchRothSuggestions({
    projection,
    targetRothAccountId: DEMO_TARGET_ROTH_ID,
    leftoverTaxRate: RATE,
    deathAges: resolvedDeathAges(projection),
    ...overrides,
  });
  if (result.kind !== 'ok') throw new Error(`expected an ok search, got ${JSON.stringify(result)}`);
  return result;
}

describe('roth suggestion search on the demo household', () => {
  let projection: RothSuggestionProjectionInput;
  let result: RothSuggestionOk;
  /** The same household with its own cap taken off: its current plan is the
   *  zero-conversion run the guards are held to. */
  let zeroConversion: RothSuggestionOk;
  let projectionCalls: number;

  beforeAll(async () => {
    projection = await loadDemoProjection(DEMO_EARLY_SCENARIO_ID);
    const before = vi.mocked(runDrawdownForMethod).mock.calls.length;
    result = await runSearch(projection);
    projectionCalls = vi.mocked(runDrawdownForMethod).mock.calls.length - before;
    zeroConversion = await runSearch({
      ...projection,
      scenarios: projection.scenarios.map((s) =>
        s.id === projection.selectedScenarioId
          ? { ...s, payload: { ...s.payload, overrides: { ...s.payload.overrides, magiCap: { windows: [] } } } }
          : s,
      ),
    });
  }, 60_000);

  const ladderCandidates = (): RothCandidate[] => result.candidates.filter((c) => !c.isReference);

  it('returns the current plan first, then each bracket guarded and unguarded', () => {
    expect(result.candidates.map((c) => c.id)).toEqual([
      'current-plan',
      'bracket-12-guarded',
      'bracket-12-unguarded',
      'bracket-22-guarded',
      'bracket-22-unguarded',
      'bracket-24-guarded',
      'bracket-24-unguarded',
      'bracket-32-guarded',
      'bracket-32-unguarded',
    ]);
  });

  it('runs a pinned number of projections, within the cap', () => {
    expect(result.projectionsRun).toBe(DEMO_EARLY_PROJECTION_COUNT);
    expect(result.projectionsRun).toBeLessThanOrEqual(MAX_PROJECTIONS);
    expect(projectionCalls).toBe(result.projectionsRun);
  });

  describe('each year ceiling is the smallest of three limits a person can recompute', () => {
    const memberBirthdates = (): string[] =>
      projection.members.map((m) => m.payload.birthdate ?? '');

    function windowYears(candidate: RothCandidate): NonNullable<RothCandidate['years'][number]['limits']>[] {
      return candidate.years.flatMap((y) => (y.inWindow && y.limits !== null ? [y.limits] : []));
    }

    it('recomputes each bracket limit from the tables and its recorded pieces', () => {
      const inflationPct = resolveScenario(projection.selectedScenarioId, [...projection.scenarios]).inflation?.ratePct;
      for (const candidate of ladderCandidates()) {
        for (const limits of windowYears(candidate)) {
          const { bracket } = limits;
          const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(BUNDLE.federalTax, limits.year, inflationPct);
          const config = snapshot.values[lookupYear];
          const brackets = config.brackets.MFJ;
          const at = brackets.findIndex((b) => Math.abs(b.rate - (candidate.bracketRate ?? 0)) < 1e-9);
          const seniors = memberBirthdates().filter((b) => hasAttainedAgeByYearEnd(b, limits.year, 65)).length;
          expect(bracket.filingStatus).toBe('MFJ');
          expect(bracket.bracketTopDollars).toBe(brackets[at + 1].floor);
          expect(bracket.standardDeductionDollars).toBe(config.standardDeduction.MFJ);
          expect(bracket.age65AddOnDollars).toBe(seniors * config.age65AddOn.mfj);
          // The senior bonus ended after 2028; every window year here is later.
          expect(bracket.seniorBonusDollars).toBe(0);
          expect(bracket.valueDollars).toBe(
            Math.floor(
              bracket.bracketTopDollars +
                bracket.standardDeductionDollars +
                bracket.age65AddOnDollars +
                bracket.seniorBonusDollars,
            ),
          );
        }
      }
    });

    it('recomputes each IRMAA and ACA limit from the tables and its recorded pieces', () => {
      const inflationPct = resolveScenario(projection.selectedScenarioId, [...projection.scenarios]).inflation?.ratePct;
      let irmaaSeen = 0;
      let acaSeen = 0;
      for (const candidate of ladderCandidates()) {
        for (const { irmaa, aca, year } of windowYears(candidate)) {
          if (irmaa.applies) {
            irmaaSeen += 1;
            const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(BUNDLE.irmaa, year + 2, inflationPct);
            expect(irmaa.lookbackYear).toBe(year + 2);
            expect(irmaa.thresholdDollars).toBe(BUNDLE.irmaa.values[effectiveYear].byMfj[0].thresholdDollars);
            expect(irmaa.scalingFactor).toBe(thresholdScalingFactor);
            expect(irmaa.valueDollars).toBe(Math.floor(irmaa.thresholdDollars * irmaa.scalingFactor));
          }
          if (aca.applies) {
            acaSeen += 1;
            const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(BUNDLE.acaPtc, year, inflationPct);
            const fpl = fplDollarsForRegion(BUNDLE.acaPtc.values[effectiveYear].fpl, aca.householdSize, 'contiguous');
            expect(aca.multiple).toBe(4);
            expect(aca.fplDollars).toBe(fpl);
            expect(aca.scalingFactor).toBe(thresholdScalingFactor);
            expect(aca.nontaxableSsDollars).toBeCloseTo(aca.grossSsDollars - aca.taxableSsDollars, 6);
            expect(aca.valueDollars).toBe(
              Math.max(0, Math.floor(aca.multiple * aca.fplDollars * aca.scalingFactor - aca.nontaxableSsDollars)),
            );
          }
        }
      }
      // The early retiree is on the Marketplace before 65 and on Medicare after,
      // so both guards must have been exercised for this to mean anything.
      expect(irmaaSeen).toBeGreaterThan(0);
      expect(acaSeen).toBeGreaterThan(0);
    });

    it('takes the smallest applicable limit, less the engine offset, as the ceiling', () => {
      for (const candidate of ladderCandidates()) {
        expect(candidate.ladder.length).toBe(result.window.endYear - result.window.startYear + 1);
        candidate.years.forEach((record) => {
          const limits = record.limits;
          if (limits === null) return;
          const applicable: [number, string][] = [[limits.bracket.valueDollars, 'bracket']];
          if (limits.irmaa.applies) applicable.push([limits.irmaa.valueDollars, 'irmaa']);
          if (limits.aca.applies) applicable.push([limits.aca.valueDollars, 'aca']);
          const smallest = Math.min(...applicable.map(([v]) => v));
          // A tie is labelled bracket, then IRMAA, then ACA.
          expect(limits.binding).toBe(applicable.find(([v]) => v === smallest)?.[1]);
          expect(limits.limitDollars).toBe(smallest);
          expect(limits.ceilingDollars).toBe(Math.max(0, Math.floor(smallest - limits.engineOffsetDollars)));
          expect(record.ceilingDollars).toBe(limits.ceilingDollars);
          expect(record.binding).toBe(limits.binding);
          const window = candidate.ladder.find((w) => w.start.kind === 'year' && w.start.year === record.year);
          expect(window?.magiCeilingAnnualDollars).toBe(limits.ceilingDollars);
        });
      }
    });

    it('lands the reported MAGI just under the limit in a year a conversion filled the ceiling', () => {
      let filled = 0;
      for (const candidate of ladderCandidates()) {
        for (const record of candidate.years) {
          if (record.stop !== 'limit' || record.limits === null) continue;
          filled += 1;
          const gap = record.limits.limitDollars - record.magiCents / 100;
          // Never over; the safety margin and the $1 bisection leave a few dollars.
          expect(gap).toBeGreaterThanOrEqual(0);
          expect(gap).toBeLessThanOrEqual(6);
        }
      }
      expect(filled).toBeGreaterThan(0);
    });
  });

  describe('guarded candidates stay on their side of the IRMAA and ACA lines', () => {
    /** Years where the candidate's rows cross a line the zero-conversion rows were under. */
    function crossings(candidate: RothCandidate): { year: number; line: 'irmaa' | 'aca' }[] {
      const reference = new Map(zeroConversion.candidates[0].drawdownYears.map((r) => [r.year, r]));
      const rows = new Map(candidate.drawdownYears.map((r) => [r.year, r]));
      const out: { year: number; line: 'irmaa' | 'aca' }[] = [];
      for (let year = result.window.startYear; year <= result.window.endYear; year += 1) {
        const underAca = reference.get(year)?.acaPtcTier !== 'above-400-cliff';
        if (underAca && rows.get(year)?.acaPtcTier === 'above-400-cliff') out.push({ year, line: 'aca' });
        const refLookback = reference.get(year + 2);
        const lookback = rows.get(year + 2);
        if (refLookback !== undefined && (refLookback.irmaaTier ?? 'none') === 'none' && (lookback?.irmaaTier ?? 'none') !== 'none') {
          out.push({ year, line: 'irmaa' });
        }
      }
      return out;
    }

    it('holds the same lines whether or not the scenario already carries a cap', () => {
      const guarded = (r: RothSuggestionOk): RothCandidate[] => r.candidates.filter((c) => c.guarded === true);
      expect(guarded(zeroConversion).map((c) => c.years.map((y) => y.limits))).toEqual(
        guarded(result).map((c) => c.years.map((y) => y.limits)),
      );
    });

    it('crosses nothing, judged from the projected rows', () => {
      const guarded = ladderCandidates().filter((c) => c.guarded === true);
      expect(guarded.length).toBe(4);
      for (const candidate of guarded) {
        expect(candidate.unranked.filter((u) => u.kind === 'guard-crossed')).toEqual([]);
        expect(crossings(candidate)).toEqual([]);
      }
    });

    it('is not vacuous: an unguarded candidate does cross a line on the same household', () => {
      const unguarded = ladderCandidates().filter((c) => c.guarded === false);
      expect(unguarded.some((c) => crossings(c).length > 0)).toBe(true);
      expect(unguarded.some((c) => c.totals.irmaaTodayDollars > 0)).toBe(true);
    });
  });

  it('keeps taxable ordinary income at or under the bracket top in every conversion year', () => {
    for (const candidate of ladderCandidates().filter((c) => c.unranked.length === 0)) {
      for (const record of candidate.years) {
        if (record.limits === null || record.convertedCents === 0) continue;
        const { bracket } = record.limits;
        const taxableBound =
          record.magiCents / 100 - bracket.standardDeductionDollars - bracket.age65AddOnDollars;
        expect(taxableBound).toBeLessThanOrEqual(bracket.bracketTopDollars + 1);
      }
    }
  });

  it('flags the current plan as rerouted but still ranks it', () => {
    const reference = result.candidates[0];
    const fromRows = reference.drawdownYears
      .filter((r) => (r.magiCapTierOverrideDollars ?? 0) > 0)
      .map((r) => r.year);
    expect(fromRows.length).toBeGreaterThan(0);
    expect(reference.reroutedYears).toEqual(fromRows);
    expect(reference.unranked).toEqual([]);
    expect(reference.rank).not.toBeNull();
  });

  it('records, per window year, the figures a person checks the conversion against', () => {
    const candidate = result.candidates.find((c) => c.id === 'bracket-22-guarded');
    expect(candidate).toBeDefined();
    const rows = new Map((candidate?.drawdownYears ?? []).map((r) => [r.year, r]));
    for (const record of candidate?.years ?? []) {
      const row = rows.get(record.year);
      expect(record.convertedCents).toBe(row?.rothConvertedCents ?? 0);
      expect(record.magiCents).toBe(row?.magiCents ?? 0);
      expect(record.taxableSsCents).toBe(row?.taxableSsCents ?? 0);
      expect(record.federalTaxCents).toBe(row?.federalTaxCents ?? 0);
      expect(record.irmaaSurchargeCents).toBe(row?.irmaaSurchargeCents ?? 0);
      expect(record.acaPtcSubsidyCents).toBe(row?.acaPtcSubsidyCents ?? 0);
      expect(record.lookbackIrmaaTier).toBe(rows.get(record.year + 2)?.irmaaTier ?? null);
    }
    const years = (candidate?.years ?? []).map((r) => r.year);
    expect(years[0]).toBe(result.window.startYear);
    expect(years[years.length - 1]).toBe(result.window.endYear + 1);
    expect(candidate?.years.at(-1)?.stop).toBe('window-ended');
  });

  it('lifetime totals deflate each year to today dollars', () => {
    const candidate = result.candidates.find((c) => c.id === 'bracket-12-unguarded');
    const inflation = resolveScenario(projection.selectedScenarioId, [...projection.scenarios]).inflation?.ratePct ?? 0;
    const asOfMonth = DEMO_TODAY_YEAR * 12 + DEMO_TODAY_MONTH;
    const ctx = {
      asOfYear: DEMO_TODAY_YEAR,
      asOfMonthIndex: DEMO_TODAY_MONTH,
      asOfMonth,
      firstProjectionMonth: asOfMonth,
      primaryRetirementMonth: asOfMonth,
      horizonMonth: asOfMonth,
      inflationPct: inflation,
    };
    let converted = 0;
    let tax = 0;
    for (const row of candidate?.drawdownYears ?? []) {
      const d = realDeflatorAt(ctx, row.year, 11);
      converted += ((row.rothConvertedCents ?? 0) / 100) * d;
      tax += ((row.federalTaxCents ?? 0) / 100) * d;
    }
    expect(candidate?.totals.totalConvertedTodayDollars).toBeCloseTo(converted, 4);
    expect(candidate?.totals.incomeTaxTodayDollars).toBeCloseTo(tax, 4);
    expect(candidate?.totals.yearsConverted).toBe(
      (candidate?.drawdownYears ?? []).filter((r) => (r.rothConvertedCents ?? 0) > 0).length,
    );
  });

  it('gives the same answer for the same inputs', { ...TIMEOUT }, async () => {
    const again = await runSearch(projection);
    expect(again).toEqual(result);
  });

  it('moves the horizon when the death age changes', { ...TIMEOUT }, async () => {
    const early = await runSearch(projection, { deathAges: { primary: 85, secondary: 85 } });
    // Primary born 1977 and secondary 1974: the later death year is 1977 + 85.
    expect(early.horizonYear).toBe(2062);
    expect(result.horizonYear).toBe(2072);
    const last = early.candidates[0].drawdownYears.at(-1);
    expect(last?.year).toBe(2062);
    expect(early.candidates[0].drawdownYears.length).toBeLessThan(result.candidates[0].drawdownYears.length);
  });
});
