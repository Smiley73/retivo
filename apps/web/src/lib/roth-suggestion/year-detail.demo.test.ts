/**
 * The year-by-year table on the demo household: every figure on a row is
 * enough to arrive at the row's conversion amount, and the income before the
 * conversion, which the engine does not stamp, equals the engine's own zero
 * point.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_EARLY_SCENARIO_ID,
  DEMO_TARGET_ROTH_ID,
  loadDemoProjection,
  resolvedDeathAges,
} from './demo-fixture';
import { searchRothSuggestions } from './search';
import type { RothCandidate, RothSuggestionOk, RothSuggestionRequest } from './types';
import type { YearDetailRow } from './year-detail-types';
import { zeroPointByYear, type ZeroPoint } from './zero-point-fixture';

/** The search keeps this many dollars under a limit (its margin plus the $1
 *  step), so the hand check closes to within it and the column names it. */
const MAX_KEPT_UNDER_DOLLARS = 6;

describe('year detail on the demo household', () => {
  let request: RothSuggestionRequest;
  let result: RothSuggestionOk;

  beforeAll(async () => {
    const projection = await loadDemoProjection(DEMO_EARLY_SCENARIO_ID);
    request = {
      projection,
      targetRothAccountId: DEMO_TARGET_ROTH_ID,
      leftoverTaxRate: 0.22,
      deathAges: resolvedDeathAges(projection),
    };
    const searched = await searchRothSuggestions(request);
    if (searched.kind !== 'ok') throw new Error(`expected ok, got ${searched.kind}`);
    result = searched;
  }, 60_000);

  const planCandidates = (): RothCandidate[] => result.candidates.filter((c) => !c.isReference);

  it('has a row for every window year of every plan, $0 years included, then the year after', () => {
    const years: number[] = [];
    for (let y = result.window.startYear; y <= result.window.endYear + 1; y += 1) years.push(y);
    for (const candidate of result.candidates) {
      expect(candidate.yearDetail.map((r) => r.year)).toEqual(years);
      const last = candidate.yearDetail.at(-1);
      expect(last).toMatchObject({ inWindow: false, limitKind: 'outside-window', amountDollars: 0 });
    }
    const zeros = planCandidates().flatMap((c) => c.yearDetail.filter((r) => r.inWindow && r.amountDollars === 0));
    expect(zeros.length).toBeGreaterThan(0);
  });

  describe('the income before each conversion, derived from the row', () => {
    interface Pair {
      readonly candidate: RothCandidate;
      readonly row: YearDetailRow;
      readonly zero: ZeroPoint;
    }
    let pairs: Pair[];

    beforeAll(async () => {
      pairs = [];
      for (const candidate of planCandidates()) {
        const zero = await zeroPointByYear(request, candidate.ladder);
        for (const row of candidate.yearDetail.filter((r) => r.inWindow)) {
          pairs.push({ candidate, row, zero: zero.get(row.year) as ZeroPoint });
        }
      }
    }, 120_000);

    it('is never below what the engine reports for the year with no conversion', () => {
      expect(pairs.length).toBeGreaterThan(50);
      for (const { row, zero } of pairs) {
        expect((row.incomeBeforeDollars ?? NaN) - zero.incomeDollars).toBeGreaterThan(-0.005);
      }
    });

    it('equals it to the cent wherever paying the conversion tax added no income', () => {
      const exact = pairs.filter(({ row, zero }) => Math.abs((row.incomeBeforeDollars ?? NaN) - zero.incomeDollars) < 0.005);
      const converted = exact.filter(({ row }) => row.amountDollars > 0);
      expect(converted.length).toBeGreaterThan(5);
      for (const { row, zero } of converted) {
        // The Social Security taxable before is the engine's, and the extra is the rest.
        expect(row.taxableSsDollars - (row.extraTaxableSsDollars ?? NaN)).toBeCloseTo(zero.taxableSsDollars, 2);
      }
    });

    it('is exact in a year the Social Security tier moves from fifty to eighty-five', () => {
      const moved = pairs.filter(
        ({ row, zero }) =>
          row.amountDollars > 0 &&
          zero.ssTier === 'fifty' &&
          row.ssTier === 'eighty-five' &&
          Math.abs((row.incomeBeforeDollars ?? NaN) - zero.incomeDollars) < 0.005,
      );
      expect(moved.length).toBeGreaterThan(0);
      for (const { row, zero } of moved) {
        expect(row.extraTaxableSsDollars).toBeGreaterThan(0);
        expect(row.taxableSsDollars - (row.extraTaxableSsDollars ?? NaN)).toBeCloseTo(zero.taxableSsDollars, 2);
      }
    });

    it('differs only by the income the conversion tax draw added, never by more than the tax', () => {
      for (const { row, zero } of pairs) {
        expect((row.incomeBeforeDollars ?? NaN) - zero.incomeDollars).toBeLessThanOrEqual(row.incomeTaxDollars);
      }
    });
  });

  it('closes the hand check to the dollar in every limit-stopped year of every plan', () => {
    let checked = 0;
    const lines = new Set<string>();
    for (const candidate of planCandidates()) {
      for (const row of candidate.yearDetail) {
        if (row.limitKind !== 'bracket' && row.limitKind !== 'irmaa' && row.limitKind !== 'aca') continue;
        const { limitDollars, incomeBeforeDollars, extraTaxableSsDollars, keptUnderDollars } = row;
        if (limitDollars === null || incomeBeforeDollars === null || extraTaxableSsDollars === null || keptUnderDollars === null) {
          throw new Error(`${candidate.id} ${row.year} lacks a figure`);
        }
        expect(limitDollars - incomeBeforeDollars - extraTaxableSsDollars - keptUnderDollars).toBeCloseTo(row.amountDollars, 2);
        expect(keptUnderDollars).toBeGreaterThanOrEqual(0);
        expect(keptUnderDollars).toBeLessThanOrEqual(MAX_KEPT_UNDER_DOLLARS);
        lines.add(row.limitKind);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
    // A bracket line, a Medicare surcharge line and a premium credit line all appear.
    expect([...lines].sort()).toEqual(['aca', 'bracket', 'irmaa']);
  });

  it('takes the limit on the row from the lowest of the three lines', () => {
    for (const candidate of planCandidates()) {
      for (const row of candidate.yearDetail.filter((r): r is YearDetailRow & { lines: NonNullable<YearDetailRow['lines']> } => r.lines !== null)) {
        const present = [row.lines.bracketDollars, row.lines.irmaaDollars, row.lines.acaDollars].filter((v): v is number => v !== null);
        expect(row.limitDollars).toBe(Math.min(...present));
      }
    }
  });

  it('names the pre-65 marketplace years on the premium credit line, with the credit added back', () => {
    const guarded = result.candidates.find((c) => c.id === 'bracket-22-guarded');
    const acaYears = (guarded?.yearDetail ?? []).filter((r) => r.limitKind === 'aca');
    expect(acaYears.length).toBeGreaterThan(0);
    for (const row of acaYears) {
      const aca = guarded?.years.find((r) => r.year === row.year)?.limits?.aca;
      if (aca === undefined || !aca.applies) throw new Error('expected an applying ACA limit');
      // 4 x FPL less the non-taxable Social Security is the line.
      expect(row.lines?.acaDollars).toBe(aca.valueDollars);
      expect(aca.nontaxableSsDollars).toBeGreaterThan(0);
    }
  });

  it('marks the cliff note on cliff-stopped years only', () => {
    for (const candidate of result.candidates) {
      for (const row of candidate.yearDetail) {
        const cliff = row.limitKind === 'irmaa' || row.limitKind === 'aca';
        expect(row.crossingNote !== null).toBe(cliff);
        if (row.crossingNote !== null) expect(row.crossingNote.line).toBe(row.limitKind);
      }
    }
  });
});
