/**
 * The year-by-year table on small hand-built households: the years the demo
 * dataset does not have (a survivor filing Single, a spending level above the
 * 12 % ceiling) with the same checks as the demo.
 */
import { describe, expect, it } from 'vitest';
import { searchRothSuggestions } from './search';
import { TOY_ROTH_ID, toyProjection, type ToyOptions } from './test-fixtures';
import type { RothCandidate, RothSuggestionOk, RothSuggestionRequest } from './types';
import type { YearDetailRow } from './year-detail-types';
import { zeroPointByYear, type ZeroPoint } from './zero-point-fixture';

const TIMEOUT = { timeout: 60_000 };
/** Born 1966, the secondary dies at 70: the death year is 2036, inside 2028-2040. */
const SURVIVOR_FIRST_YEAR = 2037;

function request(options: ToyOptions, deathAges: RothSuggestionRequest['deathAges']): RothSuggestionRequest {
  return { projection: toyProjection(options), targetRothAccountId: TOY_ROTH_ID, leftoverTaxRate: 0.2, deathAges };
}

async function search(req: RothSuggestionRequest): Promise<RothSuggestionOk> {
  const result = await searchRothSuggestions(req);
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result;
}

function limitStopped(candidates: readonly RothCandidate[]): { id: string; row: YearDetailRow }[] {
  return candidates.flatMap((c) =>
    c.yearDetail
      .filter((r) => r.limitKind === 'bracket' || r.limitKind === 'irmaa' || r.limitKind === 'aca')
      .map((row) => ({ id: c.id, row })),
  );
}

/** The derived figures equal the engine's own zero point to the cent. */
function expectZeroPoint(row: YearDetailRow, zero: ZeroPoint | undefined): void {
  if (zero === undefined) throw new Error(`${row.year} has no zero point`);
  expect(row.incomeBeforeDollars).toBeCloseTo(zero.incomeDollars, 2);
  expect(row.taxableSsDollars - (row.extraTaxableSsDollars ?? NaN)).toBeCloseTo(zero.taxableSsDollars, 2);
}

function expectHandCheck(row: YearDetailRow): void {
  const { limitDollars, incomeBeforeDollars, extraTaxableSsDollars, taxPaymentIncomeDollars, keptUnderDollars } = row;
  if (
    limitDollars === null ||
    incomeBeforeDollars === null ||
    extraTaxableSsDollars === null ||
    taxPaymentIncomeDollars === null ||
    keptUnderDollars === null
  ) {
    throw new Error(`${row.year} lacks a figure`);
  }
  expect(
    limitDollars - incomeBeforeDollars - extraTaxableSsDollars - taxPaymentIncomeDollars - keptUnderDollars,
  ).toBeCloseTo(row.amountDollars, 2);
  expect(taxPaymentIncomeDollars).toBeGreaterThanOrEqual(-0.005);
  expect(keptUnderDollars).toBeGreaterThanOrEqual(0);
  expect(keptUnderDollars).toBeLessThanOrEqual(6);
}

describe('a couple whose spouse dies inside the window', () => {
  const req = request({ iraBalance: 3_000_000 }, { primary: 90, secondary: 70 });
  let result: RothSuggestionOk;

  it('closes the hand check in the Single years, on the Single return', TIMEOUT, async () => {
    result = await search(req);
    const plans = result.candidates.filter((c) => !c.isReference);
    const single = plans.flatMap((c) => c.yearDetail.filter((r) => r.year >= SURVIVOR_FIRST_YEAR && r.inWindow));
    expect(single.length).toBeGreaterThan(0);
    expect(single.every((r) => r.filingStatus === 'Single')).toBe(true);
    const stopped = limitStopped(plans).filter(({ row }) => row.year >= SURVIVOR_FIRST_YEAR);
    expect(stopped.length).toBeGreaterThan(0);
    for (const { row } of stopped) expectHandCheck(row);
    // The Single years' Social Security comes from the Single thresholds.
    for (const plan of plans) {
      const zero = await zeroPointByYear(req, plan.ladder);
      for (const row of plan.yearDetail.filter((r) => r.year >= SURVIVOR_FIRST_YEAR && r.inWindow)) {
        expectZeroPoint(row, zero.get(row.year));
      }
    }
  });

  it('reads the income before a Single-year conversion off the Single Social Security thresholds', TIMEOUT, async () => {
    result = result ?? (await search(req));
    const plan = result.candidates.find((c) => c.id === 'bracket-22-unguarded');
    const zero = await zeroPointByYear(req, plan?.ladder ?? []);
    const survivorYears = (plan?.yearDetail ?? []).filter((r) => r.year >= SURVIVOR_FIRST_YEAR && r.amountDollars > 0);
    expect(survivorYears.length).toBeGreaterThan(0);
    for (const row of survivorYears) {
      expectZeroPoint(row, zero.get(row.year));
    }
  });
});

describe('a couple before Medicare, on the Marketplace', () => {
  it('closes the hand check on the premium credit line, with the non-taxable Social Security taken off it', TIMEOUT, async () => {
    const req = request({ iraBalance: 3_000_000 }, { primary: 90, secondary: 90 });
    const result = await search(req);
    const acaYears = result.candidates
      .filter((c) => c.guarded === true)
      .flatMap((c) => c.yearDetail.filter((r) => r.limitKind === 'aca').map((row) => ({ c, row })));
    expect(acaYears.length).toBeGreaterThan(0);
    const zeroByPlan = new Map<string, Map<number, ZeroPoint>>();
    for (const { c, row } of acaYears) {
      expectHandCheck(row);
      if (!zeroByPlan.has(c.id)) zeroByPlan.set(c.id, await zeroPointByYear(req, c.ladder));
      expectZeroPoint(row, zeroByPlan.get(c.id)?.get(row.year));
      const aca = c.years.find((y) => y.year === row.year)?.limits?.aca;
      expect(aca?.applies).toBe(true);
      expect(row.lines?.acaDollars).toBe(aca?.applies === true ? aca.valueDollars : NaN);
      expect(row.crossingNote?.line).toBe('aca');
    }
  });
});

describe('spending above the 12 % ceiling', () => {
  const HOUSEHOLD: ToyOptions = { iraBalance: 3_000_000, annualExpense: 170_000 };

  it('lists a rerouted year as a row that converted $0 because the ceiling was already reached', TIMEOUT, async () => {
    const result = await search(request({ ...HOUSEHOLD, rothBalance: 900_000 }, { primary: 90, secondary: 90 }));
    const plan = result.candidates.find((c) => c.id === 'bracket-12-guarded') as RothCandidate;
    const rerouted = plan.yearDetail.filter((r) => r.reroutedDollars > 0);
    expect(rerouted.length).toBeGreaterThan(0);
    for (const row of rerouted) {
      expect(row.limitKind).toBe('already-over');
      expect(row.amountDollars).toBe(0);
      expect(row.breachedDollars).toBe(0);
    }
    // Every year of the window is a row, converted or not, then the year after.
    expect(plan.yearDetail.map((r) => r.year)).toEqual(
      Array.from({ length: result.window.endYear - result.window.startYear + 2 }, (_, i) => result.window.startYear + i),
    );
    expect(plan.yearDetail.at(-1)?.limitKind).toBe('outside-window');
  });

  it('lists a year the cap could not be met in as a row with the dollars it missed by', TIMEOUT, async () => {
    const result = await search(request({ ...HOUSEHOLD, rothBalance: 0 }, { primary: 90, secondary: 90 }));
    const plan = result.candidates.find((c) => c.id === 'bracket-12-guarded') as RothCandidate;
    const breached = plan.yearDetail.filter((r) => r.breachedDollars > 0);
    expect(breached.length).toBeGreaterThan(0);
    expect(breached.every((r) => r.limitKind === 'already-over')).toBe(true);
  });
});

describe('a small IRA', () => {
  it('converts the whole room and says the pre-tax money ran out', TIMEOUT, async () => {
    const result = await search(request({ iraBalance: 150_000 }, { primary: 90, secondary: 90 }));
    const plan = result.candidates.find((c) => c.id === 'bracket-32-unguarded') as RothCandidate;
    const ranOut = plan.yearDetail.filter((r) => r.limitKind === 'pre-tax-ran-out');
    expect(ranOut.length).toBeGreaterThan(0);
    for (const row of ranOut) {
      expect(row.preTaxEndDollars).toBeLessThan(1);
      expect(row.keptUnderDollars ?? 0).toBeGreaterThan(6);
    }
    // $0 years after the money is gone are rows too.
    expect(ranOut.some((r) => r.amountDollars === 0)).toBe(true);
  });
});
