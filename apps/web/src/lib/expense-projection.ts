/**
 * Per-year and per-month expense projection for the Balance Projection chart band: pure and read-only, with `todayYear` passed in so tests are deterministic.
 * A month is active inclusive of start and exclusive of end; amounts are today's dollars inflated month-precise from `asOfMonth = todayYear * 12 + (todayMonthIndex ?? 0)`, and output is nominal (the page deflates for "Today's dollars" display).
 */
import {
  DEFAULT_DISCRETIONARY_DURATION_YEARS,
  DEFAULT_INFLATION_PCT,
  type DiscretionarySpendingOverride,
  type ScenarioOverrides,
} from '../db/types';
import type { ResolvedExpense } from './expense-resolution';
import { frequencyToAnnual } from './expense-format';
import { glideMultiplierFor } from './expense-glide';
import { isNeutralGlide } from './expense-glide-format';
import {
  isScheduleAnchorBroken,
  monthIndex,
  monthsActiveInYear,
  resolveEndMonth,
  resolveStartMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

/**
 * Inflation knob: `ratePct` drives every category unless `categoryRates` (from
 * `resolveInflationForScenario`, already sanitised with the Medical default) carries a per-category
 * rate; absent or empty means every category uses `ratePct`.
 */
export interface ProjectionInflation {
  ratePct: number;
  categoryRates?: Map<string, number>;
}

/**
 * Expense projection context: the schedule resolver context plus inflation and
 * discretionary-adjustment knobs.
 */
export interface ProjectionContext extends ScheduleResolveContext {
  todayYear: number;
  /**
   * 0-11 month of "today" within `todayYear`, anchoring the month-precise inflation exponent;
   * default 0 (January).
   */
  todayMonthIndex?: number;
  inflation?: ProjectionInflation;
  discretionarySpending?: DiscretionarySpendingOverride;
}

/**
 * Inputs to {@link buildExpenseProjectionContext}: `resolved` supplies the two expense-shaping
 * sections, `primary` / `secondary` carry birthdates, `primaryRetirementIso` is the primary's
 * resolved retirement date (`YYYY-MM-DD`).
 */
export interface ExpenseProjectionContextInput {
  resolved: Pick<ScenarioOverrides, 'discretionarySpending' | 'lifeExpectancy'>;
  primary: { birthdate?: string | null } | null;
  secondary: { birthdate?: string | null } | null;
  primaryRetirementIso: string;
}

function parseIsoMonth0(iso: string): number | null {
  const match = /^\d{4}-(\d{2})/.exec(iso);
  if (!match) return null;
  const m = Number(match[1]);
  if (m < 1 || m > 12) return null;
  return m - 1;
}

/**
 * Build the today's-dollars {@link ProjectionContext} the Expenses page and single-expense form
 * preview both project under: inflation pinned to 0% (retirement-start dollars), retirement year
 * and month from `primaryRetirementIso`, life-expectancy and discretionary knobs from the resolved
 * scenario. `todayYear` and `extendBeyondLifetime: false` are fixed so callers cannot drift them.
 */
export function buildExpenseProjectionContext(
  input: ExpenseProjectionContextInput,
): ProjectionContext {
  const { resolved, primary, secondary, primaryRetirementIso } = input;
  const retirementYear = new Date(primaryRetirementIso).getUTCFullYear();
  const retirementMonth0 = parseIsoMonth0(primaryRetirementIso);
  return {
    todayYear: new Date().getFullYear(),
    retirementYear,
    retirementMonth0: retirementMonth0 ?? 0,
    primary: primary?.birthdate ? { birthdate: primary.birthdate } : undefined,
    secondary: secondary?.birthdate
      ? { birthdate: secondary.birthdate }
      : undefined,
    inflation: { ratePct: 0 },
    discretionarySpending: resolved.discretionarySpending,
    lifeExpectancy: resolved.lifeExpectancy,
    extendBeyondLifetime: false,
  };
}

type InflationFactorFn = (year: number, monthIndex: number) => number;

function buildInflationFactorAt(
  ctx: ProjectionContext,
  inflationPct: number,
): InflationFactorFn {
  if (inflationPct === 0) return () => 1;
  const asOfMonth = ctx.todayYear * 12 + (ctx.todayMonthIndex ?? 0);
  const base = 1 + inflationPct / 100;
  return (year, monthIndex) =>
    Math.pow(base, (year * 12 + monthIndex - asOfMonth) / 12);
}

// Call-scoped memo keyed by effective rate, so categories at the same rate share one closure and a
// stale `ctx` cannot leak between calls.
function buildEffectiveInflationFactor(ctx: ProjectionContext): {
  generalRate: number;
  factorFor: (categoryId: string) => InflationFactorFn;
} {
  const generalRate = ctx.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const categoryRates = ctx.inflation?.categoryRates;
  const memo = new Map<number, InflationFactorFn>();
  const factorForRate = (rate: number): InflationFactorFn => {
    let fn = memo.get(rate);
    if (!fn) {
      fn = buildInflationFactorAt(ctx, rate);
      memo.set(rate, fn);
    }
    return fn;
  };
  const generalFactor = factorForRate(generalRate);
  const factorFor = (categoryId: string): InflationFactorFn => {
    const rate = categoryRates?.get(categoryId);
    if (rate === undefined || rate === generalRate) return generalFactor;
    return factorForRate(rate);
  };
  return { generalRate, factorFor };
}

export interface ExpenseProjectionPoint {
  year: number;
  essential: number;
  discretionary: number;
  total: number;
  /**
   * Real (entered, pre-inflation) analogues of the nominal fields: the same accumulation with only
   * the inflation factor neutralised, keeping the discretionary adjustment and per-expense spending
   * glide. The page reads them for "Today's dollars". The glided base is the per-active-month glide
   * sum `annualBase × (1/12) × Σ glide(m)`, not `nominal ÷ inflationFactor`.
   */
  essentialBase: number;
  discretionaryBase: number;
  totalBase: number;
}

/**
 * One month-granularity sample for the chart band, in annualized run-rates ($/yr), so an annual sum
 * is the mean of the 12 monthly rates. A one-off renders at its literal amount for one month
 * (age-anchored on the birthday month, year-anchored in January, retirementStart-anchored in the
 * retirement month), so the chart integral differs from the annual rollup in event years;
 * `projectExpensesByYear` stays the source of truth for headline math.
 */
export interface ExpenseProjectionMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  /** Recurring run-rate $/yr plus the literal one-off spike, as the chart band reads it. */
  essential: number;
  discretionary: number;
  total: number;
  /**
   * Literal one-off amount this month, essential bucket (included in `essential`); lets callers
   * split run-rate from spike.
   */
  oneOffEssential: number;
  /** Literal one-off event amount this month, discretionary bucket. */
  oneOffDiscretionary: number;
  /**
   * Real per-month analogues of the nominal fields: only `monthFactor` is omitted, glide and
   * adjustment kept, so `base = nominal ÷ monthFactor`.
   */
  essentialBase: number;
  discretionaryBase: number;
  oneOffEssentialBase: number;
  oneOffDiscretionaryBase: number;
}

// `base` is `nominal` with the inflation factor neutralised and the glide kept; the caller applies
// the discretionary multiplier to both.
interface ContributionPair {
  nominal: number;
  base: number;
}

const ZERO_PAIR: ContributionPair = { nominal: 0, base: 0 };

function oneOffSpikeMonth0(
  r: ResolvedExpense,
  year: number,
  ctx: ProjectionContext,
): number | null {
  const s = r.payload.start;
  if (s.kind === 'year' && s.year === year) return 0;
  if (s.kind === 'retirementStart' && ctx.retirementYear === year) {
    return ctx.retirementMonth0 ?? 0;
  }
  if (s.kind === 'age') {
    const sm = resolveStartMonth(s, ctx);
    if (sm && sm.year === year) return sm.month0;
  }
  return null;
}

// Glided expenses (any classification) use the exact per-active-month inflation×glide sum so the
// rollup stays exact; the rest use the year-mean inflation factor prorated by activeMonths/12.
// `base` drops only inflation.
function continuousContribution(
  r: ResolvedExpense,
  year: number,
  ctx: ProjectionContext,
  inflationFactorAt: InflationFactorFn,
): ContributionPair {
  const e = r.payload.end;
  const sm = resolveStartMonth(r.payload.start, ctx);
  if (!sm || !e) return ZERO_PAIR;
  const em = resolveEndMonth(e, sm, ctx);
  if (!em) return ZERO_PAIR;
  const months = monthsActiveInYear(sm, em, year);
  if (months === 0) return ZERO_PAIR;
  const annualBase = r.payload.amount * frequencyToAnnual(r.payload.frequency);
  if (
    r.payload.discretionaryGlide &&
    !isNeutralGlide(r.payload.discretionaryGlide)
  ) {
    let nominalSum = 0;
    let baseSum = 0;
    for (let m = 0; m < 12; m += 1) {
      if (!isMonthActive(sm, em, year, m)) continue;
      const glide = glideMultiplierFor(r.payload, monthIndex(year, m), ctx);
      nominalSum += inflationFactorAt(year, m) * glide;
      baseSum += glide;
    }
    return {
      nominal: annualBase * (nominalSum / 12),
      base: annualBase * (baseSum / 12),
    };
  }
  let yearMeanFactor = 0;
  for (let m = 0; m < 12; m += 1) {
    yearMeanFactor += inflationFactorAt(year, m);
  }
  yearMeanFactor /= 12;
  return {
    nominal: annualBase * (months / 12) * yearMeanFactor,
    base: annualBase * (months / 12),
  };
}

// Annual contribution for `year` before the discretionary `discMultiplier`; a one-off uses its
// spike-month glide factor.
function yearExpenseContribution(
  r: ResolvedExpense,
  year: number,
  ctx: ProjectionContext,
  inflationFactorAt: InflationFactorFn,
): ContributionPair {
  if (r.payload.frequency === 'oneOff') {
    const spikeMonth0 = oneOffSpikeMonth0(r, year, ctx);
    if (spikeMonth0 === null) return ZERO_PAIR;
    const glide = glideMultiplierFor(
      r.payload,
      monthIndex(year, spikeMonth0),
      ctx,
    );
    return {
      nominal: r.payload.amount * inflationFactorAt(year, spikeMonth0) * glide,
      base: r.payload.amount * glide,
    };
  }
  return continuousContribution(r, year, ctx, inflationFactorAt);
}

/** Year-by-year essential, discretionary and total expenses across `yearRange`; pure. */
export function projectExpensesByYear(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseProjectionPoint[] {
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  // Clamp to [-100, +100] so the multiplier never goes negative or above ×2.
  const bumpPct = Math.max(-100, Math.min(100, ctx.discretionarySpending?.bumpPct ?? 0));
  // `durationYears`: null means the whole retirement, a positive integer the first N years; a
  // missing key (undefined) takes the default.
  const durationYears =
    ctx.discretionarySpending && 'durationYears' in ctx.discretionarySpending
      ? ctx.discretionarySpending.durationYears
      : bumpPct === 0
        ? null
        : DEFAULT_DISCRETIONARY_DURATION_YEARS;

  const out: ExpenseProjectionPoint[] = [];
  for (let year = yearRange.from; year <= yearRange.to; year++) {
    const yearsSinceRetirement = year - ctx.retirementYear;
    const inDiscWindow =
      bumpPct !== 0 &&
      (durationYears === null
        ? yearsSinceRetirement >= 0
        : yearsSinceRetirement >= 0 && yearsSinceRetirement < durationYears);
    const discMultiplier = inDiscWindow ? 1 + bumpPct / 100 : 1;

    let essential = 0;
    let discretionary = 0;
    let essentialBase = 0;
    let discretionaryBase = 0;

    for (const r of resolved) {
      if (isScheduleAnchorBroken(r.payload.start, r.payload.end, ctx)) continue;
      const { nominal, base } = yearExpenseContribution(
        r,
        year,
        ctx,
        factorFor(r.payload.categoryId),
      );
      if (nominal === 0 && base === 0) continue;
      if (r.payload.classification === 'discretionary') {
        discretionary += nominal * discMultiplier;
        discretionaryBase += base * discMultiplier;
      } else {
        essential += nominal;
        essentialBase += base;
      }
    }

    out.push({
      year,
      essential: round2(essential),
      discretionary: round2(discretionary),
      total: round2(essential + discretionary),
      essentialBase: round2(essentialBase),
      discretionaryBase: round2(discretionaryBase),
      totalBase: round2(essentialBase + discretionaryBase),
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Per-month sample for the Expenses by Category chart, bucketed by `categoryId`; categories with no
 * active expense carry 0.
 */
export interface ExpenseCategoryMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  byCategoryId: Record<string, number>;
  total: number;
  /**
   * Per-category recurring run-rate ($/yr) and literal one-off spike, split out of `byCategoryId`
   * so a band-basis consumer can apply `monthlyBucket(recurring, spike, f)`. A one-off's amount
   * lands in both maps; `byCategoryId[c] === recurringByCategoryId[c]`.
   */
  recurringByCategoryId: Record<string, number>;
  oneOffByCategoryId: Record<string, number>;
}

/**
 * Per-year per-category expense rollup for the cashflow category band's Yearly mode, on the same
 * annual basis as `projectExpensesByYear`; `byCategoryId` sums to its `total` (sub-cent FP).
 */
export interface ExpenseCategoryYearPoint {
  year: number;
  byCategoryId: Record<string, number>;
  total: number;
}

/**
 * Category-resolution variant of `projectExpensesByMonth`; the discretionary adjustment multiplies
 * a discretionary expense's contribution before it lands in its bucket.
 */
export function projectExpensesByCategoryMonth(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseCategoryMonthlyPoint[] {
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  const bumpPct = Math.max(-100, Math.min(100, ctx.discretionarySpending?.bumpPct ?? 0));
  const durationYears =
    ctx.discretionarySpending && 'durationYears' in ctx.discretionarySpending
      ? ctx.discretionarySpending.durationYears
      : bumpPct === 0
        ? null
        : DEFAULT_DISCRETIONARY_DURATION_YEARS;

  const out: ExpenseCategoryMonthlyPoint[] = [];
  for (let year = yearRange.from; year <= yearRange.to; year++) {
    const yearsSinceRetirement = year - ctx.retirementYear;
    const inDiscWindow =
      bumpPct !== 0 &&
      (durationYears === null
        ? yearsSinceRetirement >= 0
        : yearsSinceRetirement >= 0 && yearsSinceRetirement < durationYears);
    const discMultiplier = inDiscWindow ? 1 + bumpPct / 100 : 1;

    for (let month0 = 0; month0 < 12; month0++) {
      const byCategoryId: Record<string, number> = {};
      const oneOffByCategoryId: Record<string, number> = {};
      let total = 0;

      for (const r of resolved) {
        const e = r.payload.end;
        if (isScheduleAnchorBroken(r.payload.start, e, ctx)) continue;

        const monthFactor = factorFor(r.payload.categoryId)(year, month0);
        let rate = 0;
        let isOneOff = false;
        if (r.payload.frequency === 'oneOff') {
          const sm = resolveStartMonth(r.payload.start, ctx);
          if (sm && sm.year === year && sm.month0 === month0) {
            rate = r.payload.amount * monthFactor;
            isOneOff = true;
          }
        } else {
          const sm = resolveStartMonth(r.payload.start, ctx);
          if (!sm || !e) continue;
          const em = resolveEndMonth(e, sm, ctx);
          if (!em) continue;
          if (!isMonthActive(sm, em, year, month0)) continue;
          rate =
            r.payload.amount *
            frequencyToAnnual(r.payload.frequency) *
            monthFactor;
        }

        if (rate === 0) continue;
        // Glide applies to any expense; the discretionary adjustment stays discretionary-only.
        rate *= glideMultiplierFor(r.payload, monthIndex(year, month0), ctx);
        if (r.payload.classification === 'discretionary') {
          rate *= discMultiplier;
        }
        const cat = r.payload.categoryId;
        byCategoryId[cat] = round2((byCategoryId[cat] ?? 0) + rate);
        if (isOneOff) {
          oneOffByCategoryId[cat] = round2((oneOffByCategoryId[cat] ?? 0) + rate);
        }
        total += rate;
      }

      out.push({
        fractionalYear: year + month0 / 12,
        year,
        month0,
        byCategoryId,
        total: round2(total),
        recurringByCategoryId: byCategoryId,
        oneOffByCategoryId,
      });
    }
  }
  return out;
}

/**
 * Per-year per-category rollup for the cashflow category band's Yearly mode: buckets
 * `yearExpenseContribution`'s nominal by `categoryId`, so `Σ byCategoryId` ties to
 * `projectExpensesByYear`'s `total` (sub-cent FP). The caller passes the mode-appropriate inflation
 * in `ctx` (0% pinned in Today's dollars).
 */
export function projectExpensesByCategoryYear(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseCategoryYearPoint[] {
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  const bumpPct = Math.max(-100, Math.min(100, ctx.discretionarySpending?.bumpPct ?? 0));
  const durationYears =
    ctx.discretionarySpending && 'durationYears' in ctx.discretionarySpending
      ? ctx.discretionarySpending.durationYears
      : bumpPct === 0
        ? null
        : DEFAULT_DISCRETIONARY_DURATION_YEARS;

  const out: ExpenseCategoryYearPoint[] = [];
  for (let year = yearRange.from; year <= yearRange.to; year++) {
    const yearsSinceRetirement = year - ctx.retirementYear;
    const inDiscWindow =
      bumpPct !== 0 &&
      (durationYears === null
        ? yearsSinceRetirement >= 0
        : yearsSinceRetirement >= 0 && yearsSinceRetirement < durationYears);
    const discMultiplier = inDiscWindow ? 1 + bumpPct / 100 : 1;

    const byCategoryId: Record<string, number> = {};
    let total = 0;
    for (const r of resolved) {
      if (isScheduleAnchorBroken(r.payload.start, r.payload.end, ctx)) continue;
      const { nominal } = yearExpenseContribution(
        r,
        year,
        ctx,
        factorFor(r.payload.categoryId),
      );
      if (nominal === 0) continue;
      const value =
        r.payload.classification === 'discretionary'
          ? nominal * discMultiplier
          : nominal;
      const cat = r.payload.categoryId;
      byCategoryId[cat] = (byCategoryId[cat] ?? 0) + value;
      total += value;
    }
    for (const cat of Object.keys(byCategoryId)) {
      byCategoryId[cat] = round2(byCategoryId[cat]);
    }
    out.push({ year, byCategoryId, total: round2(total) });
  }
  return out;
}

/**
 * Earliest active-start month across the resolved expenses (broken anchors skipped), or null when
 * none resolve; widens the chart's left edge so a pre-retirement expense shows from its true start.
 */
export function findEarliestExpenseStartMonth(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
): { year: number; month0: number } | null {
  let best: { year: number; month0: number } | null = null;
  for (const r of resolved) {
    if (isScheduleAnchorBroken(r.payload.start, r.payload.end, ctx)) continue;
    const sm = resolveStartMonth(r.payload.start, ctx);
    if (!sm) continue;
    if (
      !best ||
      monthIndex(sm.year, sm.month0) < monthIndex(best.year, best.month0)
    ) {
      best = sm;
    }
  }
  return best;
}

function isMonthActive(
  startMonth: { year: number; month0: number },
  endMonthExclusive: { year: number; month0: number },
  year: number,
  month0: number,
): boolean {
  const idx = monthIndex(year, month0);
  const startIdx = monthIndex(startMonth.year, startMonth.month0);
  const endIdx = monthIndex(endMonthExclusive.year, endMonthExclusive.month0);
  return idx >= startIdx && idx < endIdx;
}

// Per-month rate with `base` = `nominal` minus the inflation `monthFactor`; the caller applies the
// glide to both. `isOneOff` routes the value into the spike buckets; `null` means inactive.
function monthExpenseRate(
  r: ResolvedExpense,
  year: number,
  month0: number,
  ctx: ProjectionContext,
  monthFactor: number,
): { nominal: number; base: number; isOneOff: boolean } | null {
  const e = r.payload.end;
  if (r.payload.frequency === 'oneOff') {
    const sm = resolveStartMonth(r.payload.start, ctx);
    if (!sm || sm.year !== year || sm.month0 !== month0) return null;
    return {
      nominal: r.payload.amount * monthFactor,
      base: r.payload.amount,
      isOneOff: true,
    };
  }
  const sm = resolveStartMonth(r.payload.start, ctx);
  if (!sm || !e) return null;
  const em = resolveEndMonth(e, sm, ctx);
  if (!em) return null;
  if (!isMonthActive(sm, em, year, month0)) return null;
  const annualRate = r.payload.amount * frequencyToAnnual(r.payload.frequency);
  return {
    nominal: annualRate * monthFactor,
    base: annualRate,
    isOneOff: false,
  };
}

/**
 * Month-resolution variant of `projectExpensesByYear`: 12 points per calendar year, in annualized
 * run-rates ($/yr) (see `ExpenseProjectionMonthlyPoint`). The discretionary window is evaluated per
 * year because it is defined in whole years from retirement start.
 */
export function projectExpensesByMonth(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseProjectionMonthlyPoint[] {
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  const bumpPct = Math.max(-100, Math.min(100, ctx.discretionarySpending?.bumpPct ?? 0));
  const durationYears =
    ctx.discretionarySpending && 'durationYears' in ctx.discretionarySpending
      ? ctx.discretionarySpending.durationYears
      : bumpPct === 0
        ? null
        : DEFAULT_DISCRETIONARY_DURATION_YEARS;

  const out: ExpenseProjectionMonthlyPoint[] = [];
  for (let year = yearRange.from; year <= yearRange.to; year++) {
    const yearsSinceRetirement = year - ctx.retirementYear;
    const inDiscWindow =
      bumpPct !== 0 &&
      (durationYears === null
        ? yearsSinceRetirement >= 0
        : yearsSinceRetirement >= 0 && yearsSinceRetirement < durationYears);
    const discMultiplier = inDiscWindow ? 1 + bumpPct / 100 : 1;

    for (let month0 = 0; month0 < 12; month0++) {
      let essential = 0;
      let discretionary = 0;
      // One-off spikes are tracked separately so the drawdown engine can split run-rate from spike;
      // both stay summed into `essential` / `discretionary`.
      let oneOffEssential = 0;
      let oneOffDiscretionary = 0;
      let essentialBase = 0;
      let discretionaryBase = 0;
      let oneOffEssentialBase = 0;
      let oneOffDiscretionaryBase = 0;

      for (const r of resolved) {
        if (isScheduleAnchorBroken(r.payload.start, r.payload.end, ctx))
          continue;

        const monthFactor = factorFor(r.payload.categoryId)(year, month0);
        const rate = monthExpenseRate(r, year, month0, ctx, monthFactor);
        if (!rate || (rate.nominal === 0 && rate.base === 0)) continue;
        // Glide applies to any expense and multiplies both halves; the discretionary adjustment
        // stays discretionary-only.
        const glide = glideMultiplierFor(r.payload, monthIndex(year, month0), ctx);
        if (r.payload.classification === 'discretionary') {
          const realScale = discMultiplier * glide;
          const scaled = rate.nominal * realScale;
          const scaledBase = rate.base * realScale;
          discretionary += scaled;
          discretionaryBase += scaledBase;
          if (rate.isOneOff) {
            oneOffDiscretionary += scaled;
            oneOffDiscretionaryBase += scaledBase;
          }
        } else {
          const scaled = rate.nominal * glide;
          const scaledBase = rate.base * glide;
          essential += scaled;
          essentialBase += scaledBase;
          if (rate.isOneOff) {
            oneOffEssential += scaled;
            oneOffEssentialBase += scaledBase;
          }
        }
      }

      out.push({
        fractionalYear: year + month0 / 12,
        year,
        month0,
        essential: round2(essential),
        discretionary: round2(discretionary),
        total: round2(essential + discretionary),
        oneOffEssential: round2(oneOffEssential),
        oneOffDiscretionary: round2(oneOffDiscretionary),
        essentialBase: round2(essentialBase),
        discretionaryBase: round2(discretionaryBase),
        oneOffEssentialBase: round2(oneOffEssentialBase),
        oneOffDiscretionaryBase: round2(oneOffDiscretionaryBase),
      });
    }
  }
  return out;
}
