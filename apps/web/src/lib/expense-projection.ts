/**
 * Per-year expense projection for the Balance Projection chart band.
 * Pure functions; no React, no IndexedDB, no Date.now() at the
 * top-level (callers pass `todayYear` explicitly so tests are
 * deterministic).
 *
 * Read-only; this engine never modifies aggregates.
 *
 * Active-month rule:
 *   inclusive on start, exclusive on end
 *   active in month M iff startAnniv ≤ end-of-M AND endAnniv > start-of-M
 *
 * Year proration: month-prorate.
 *   yearTotal = active_months / 12 × amount × frequencyToAnnual(freq)
 * Inflation:
 *   amount × (1 + ratePct/100)^((year*12 + monthIndex − asOfMonth) / 12)
 *   where asOfMonth = ctx.todayYear * 12 + (ctx.todayMonthIndex ?? 0).
 *   Amounts are entered as **today's dollars**; the engine inflates
 *   forward (or deflates back) from today's anchor on a month-precise
 *   schedule. Pre-anchor years yield a factor < 1; post-anchor years
 *   yield factor > 1. Output is nominal — the page applies a view-
 *   model deflator at display when "Today's dollars" mode is on.
 * Discretionary adjustment multiplier (discretionary-only):
 *   if bumpPct ≠ 0 AND year is in window from retirement-start →
 *     multiply discretionary expenses by (1 + bumpPct/100).
 *   bumpPct clamped to [-100, +100] at this layer; stored values
 *   outside that range are silently clamped (no migration needed).
 * Spending glide (any classification):
 *   the per-expense rise/fall multiplier (`glideMultiplierFor`) applies
 *   to essential and discretionary expenses alike; the discretionary
 *   adjustment above stacks on top of it for discretionary expenses only.
 *
 * Additive real ("base") outputs:
 *   `projectExpensesByYear` / `projectExpensesByMonth` also emit
 *   `*Base` fields = the same accumulation with **only** the inflation
 *   factor neutralised. The discretionary adjustment and the per-expense
 *   spending glide are real-terms knobs and stay applied; only
 *   `inflationFactorAt` / `yearMeanFactor` / `monthFactor` are dropped.
 *   The Balance Projection page reads these for "Today's dollars" so a
 *   non-glided constant expense is flat (no sawtooth) and a glided one
 *   follows its real trajectory. The nominal fields and every existing
 *   nominal-field consumer are byte-unchanged.
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
 * Inflation knob for the expense projection context. The general
 * `ratePct` (percent) drives every category by default; the optional
 * `categoryRates` map carries a per-category effective rate (percent)
 * keyed by ExpenseCategory id — a category's effective rate is
 * `categoryRates?.get(catId) ?? ratePct`. The map comes from
 * `resolveInflationForScenario` (already sanitised + with the Medical
 * default materialised). Absent / empty `categoryRates` ⇒ every category
 * inflates at `ratePct`, byte-identical to the pre-feature engine.
 */
export interface ProjectionInflation {
  ratePct: number;
  categoryRates?: Map<string, number>;
}

/** Expense projection context. Extends the schedule resolver context
 *  with expense-specific knobs (inflation, discretionary adjustments). The
 *  resolver fields (retirementYear, primary, secondary, lifeExpectancy,
 *  extendBeyondLifetime, retirementMonth0) live on the base type. */
export interface ProjectionContext extends ScheduleResolveContext {
  todayYear: number;
  /** 0-11 month index of "today" within `todayYear`. Drives the
   *  month-precise inflation exponent. Default 0 (January) when
   *  unspecified — matches the prior all-Jan behaviour for callers
   *  that haven't been threaded through the new anchor. */
  todayMonthIndex?: number;
  inflation?: ProjectionInflation;
  discretionarySpending?: DiscretionarySpendingOverride;
}

/** Inputs to {@link buildExpenseProjectionContext}. `resolved` is the
 *  scenario-resolved overrides view (only the two expense-shaping
 *  sections are read); `primary` / `secondary` carry member birthdates;
 *  `primaryRetirementIso` is the primary member's resolved retirement
 *  date (`YYYY-MM-DD`). */
export interface ExpenseProjectionContextInput {
  resolved: Pick<ScenarioOverrides, 'discretionarySpending' | 'lifeExpectancy'>;
  primary: { birthdate?: string | null } | null;
  secondary: { birthdate?: string | null } | null;
  primaryRetirementIso: string;
}

/** 0-indexed month (Jan = 0) parsed from an ISO `YYYY-MM-DD`, or null
 *  when the string is malformed. Mirrors the inline parser the Expenses
 *  page used before this helper centralised the construction. */
function parseIsoMonth0(iso: string): number | null {
  const match = /^\d{4}-(\d{2})/.exec(iso);
  if (!match) return null;
  const m = Number(match[1]);
  if (m < 1 || m > 12) return null;
  return m - 1;
}

/**
 * Build the today's-dollars expense {@link ProjectionContext} the
 * Expenses page and the single-expense form preview both project under.
 *
 * Single source of truth for the canonical-expense projection context:
 * inflation is pinned to 0% (values stay in retirement-start dollars),
 * the retirement year + month come from `primaryRetirementIso`, and the
 * life-expectancy / discretionary-spending knobs come from the resolved
 * scenario so the horizon and the discretionary adjustment window match the
 * household's plan. `todayYear` (local-year anchor) and
 * `extendBeyondLifetime: false` are part of the fixed shape, not inputs,
 * so callers cannot drift them. Pure; no Date.now() side effects beyond
 * the `todayYear` anchor (kept here so the Expenses-page lift stays
 * byte-identical to its previous inline construction).
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

/** A month-precise inflation-factor lookup: `(year, monthIndex) → factor`
 *  relative to the context's `asOfMonth`. */
type InflationFactorFn = (year: number, monthIndex: number) => number;

/**
 * Build a month-precise inflation-factor lookup anchored at the
 * context's `asOfMonth = todayYear * 12 + (todayMonthIndex ?? 0)`.
 * Returns a closure so the multiplicative base is computed once per
 * projection call.
 *
 * `inflationFactorAt(2030, 5)` reads the factor for June of 2030
 * relative to today's anchor. Returns 1 when `inflationPct` is 0.
 */
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

/**
 * Per-effective-rate inflation-factor memo for one projection call. The
 * general `ratePct` drives every category by default; a category whose
 * effective rate (`ctx.inflation.categoryRates.get(catId)`) differs gets
 * its own memoised factor function. The memo is keyed by the numeric
 * effective rate (1–few distinct rates per scenario), so two categories at
 * the same rate share one factor closure.
 *
 * Call-scoped: rebuilt per `projectExpensesBy*` call, capturing the
 * current `ctx` — never module-level, so a stale `ctx`/`asOfMonth` cannot
 * leak between calls. Absent / empty `categoryRates` ⇒ every category
 * resolves to the single general-rate factor, byte-identical to the
 * pre-feature engine.
 */
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
   * Real (entered, pre-inflation) annual analogues of the nominal
   * fields above. Identical accumulation with **only** the inflation
   * factor neutralised (`inflationFactorAt → 1`, `yearMeanFactor → 1`):
   * the discretionary `adjustmentMultiplier` and the per-expense spending
   * `glideMultiplier` are kept (they are deliberate real-terms knobs,
   * not inflation). The Balance Projection page reads these for
   * "Today's dollars" instead of deflating the month-precise nominal,
   * so a non-glided constant expense is flat and a glided one follows
   * its chosen real trajectory. The continuous glided base is the
   * per-active-month glide sum `annualBase × (1/12) × Σ_{active m}
   * glideMultiplierFor(m)` — NOT a scalar `nominal ÷
   * inflationFactor`. Additive: every existing nominal-field consumer
   * (drawdown engine, category chart, Monte Carlo) is unaffected.
   */
  essentialBase: number;
  discretionaryBase: number;
  totalBase: number;
}

/**
 * One sample point at month granularity for the chart-band visualization.
 * Values are *annualized run-rates* in $/yr (i.e. "what's the spending
 * rate at this moment, projected over a year") so:
 *
 *   annual sum (year y) = mean of the 12 monthly rates in year y
 *
 * `fractionalYear` is the chart X coordinate (`year + month0/12`); the
 * tooltip uses `year` + `month0` for display so users see integer years
 * and "Jun 2055" month labels rather than `2055.42`.
 *
 * Continuous expenses (monthly / yearly / etc.) emit a flat rate while
 * active and zero while inactive — the chart line steps up/down at the
 * actual start/end month rather than at January 1 of the year.
 *
 * One-off lump sums render at their **literal amount** for exactly one
 * month, then drop to zero. A $40k event in November renders as a $40k
 * bar in November — readable directly against the y-axis. This
 * intentionally diverges from the annual-rollup invariant in event
 * years: the chart's integral over the event month is `amount/12`,
 * while `projectExpensesByYear` sums the full `amount` into the annual
 * total. The year-by-year table (which uses the annual fn) is the
 * source of truth for headline math; the chart is a visualisation that
 * shows where one-offs sit in the timeline at honest magnitudes.
 *
 * Spike month comes from `resolveStartMonth`: age-anchored one-offs
 * spike on the resolved birthday month; year- and retirementStart-
 * anchored one-offs spike in January / the resolved retirement month
 * respectively.
 */
export interface ExpenseProjectionMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  /** Mixed: recurring run-rate $/yr + literal one-off spike. Existing
   *  consumers (chart band) read this as a single y-axis value. */
  essential: number;
  discretionary: number;
  total: number;
  /** Literal one-off event amount this month, essential bucket
   *  (non-zero only at the spike month). Already included in `essential`
   *  above — exposed separately so callers that need true monthly
   *  cashflow (e.g. the drawdown engine) can extract run-rate vs spike. */
  oneOffEssential: number;
  /** Literal one-off event amount this month, discretionary bucket. */
  oneOffDiscretionary: number;
  /**
   * Real (entered, pre-inflation) per-month analogues of the four
   * nominal fields above. Same contributions with **only** the
   * inflation `monthFactor` omitted; the discretionary `adjustmentMultiplier`
   * and the per-month spending `glideMultiplier` are kept. For
   * any month `base = nominal ÷ monthFactor` exactly (one inflation
   * factor per month, glide retained), so a non-glided constant expense
   * is flat across the 12 months and a glided one follows its real
   * monthly glide ramp. Read by the Balance Projection page in
   * "Today's dollars"; additive — nominal-field consumers unchanged.
   */
  essentialBase: number;
  discretionaryBase: number;
  oneOffEssentialBase: number;
  oneOffDiscretionaryBase: number;
}

// Resolver helpers (resolveStartMonth, resolveEndMonth,
// monthsActiveInYear, monthIndex, isScheduleAnchorBroken) live in
// ./schedule-resolution.ts so the income engine can share the same
// implementation. ProjectionContext extends ScheduleResolveContext so
// it satisfies their input contract structurally.

/**
 * One expense's pre-classification contribution as a `{ nominal, base }`
 * pair. `nominal` is the engine's existing month-precise-inflated value
 * (byte-identical to the pre-`base` engine); `base` is the **same**
 * accumulation with the inflation factor neutralised (`inflationFactorAt
 * → 1`) and the per-expense spending glide kept. The
 * discretionary `adjustmentMultiplier` is applied identically to both by the
 * caller (it is the same scalar regardless of inflation), so the glide
 * — the only per-month real-terms knob that differs from a flat scalar
 * — is computed exactly once here and folded into both branches.
 */
interface ContributionPair {
  nominal: number;
  base: number;
}

const ZERO_PAIR: ContributionPair = { nominal: 0, base: 0 };

/**
 * Per-expense `{ nominal, base }` annual contribution for one calendar
 * `year`, BEFORE the discretionary `discMultiplier`. The spending glide
 * is folded into both halves here (one-off: the single spike-month
 * factor; continuous-glided: the per-active-month glide sum;
 * non-glided/essential: identity 1) so the caller only has to apply the
 * inflation-independent `discMultiplier`. The sole difference between
 * `nominal` and `base` is the inflation factor — `base` recomputes the
 * accumulation with `inflationFactorAt → 1` (the continuous
 * glided base is `annualBase × (1/12) × Σ_{active m} glide(m)`, NOT a
 * scalar `nominal ÷ inflationFactor`).
 */
/** Resolved spike month for a one-off in `year`, or null when the
 *  one-off does not fall in this calendar year. */
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

/** Continuous-expense `{ nominal, base }` for one active calendar year.
 *  Glided discretionary → the per-active-month inflation×glide sum / 12;
 * `base` drops only the per-month inflation factor and
 *  keeps the same per-month glide sum — NOT `nominal ÷ scalar
 *  inflationFactor`. Essential / absent-glide / neutral no-op → the
 *  year-mean inflation factor prorated by activeMonths/12, byte-
 *  identical to the pre-glide engine; `base` is the inflation-free
 *  analogue (year-mean factor → 1). */
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
  // Glide-presence + active is the split key: a glided essential
  // uses the same exact per-active-month inflation×glide sum as a glided
  // discretionary, so the annual rollup stays exact for both. The
  // discretionary `discMultiplier` adjustment is applied by the caller and
  // is classification-gated there — it never enters this glide sum.
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

/**
 * Compute year-by-year expense totals (Essential, Discretionary, Total)
 * across the requested year range.
 *
 * Pure: same inputs always produce same outputs. Callers handle pre-
 * retirement clipping for the chart's x-axis (the resolver can run for
 * any range; the chart picks ≥ retirementYear).
 */
export function projectExpensesByYear(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseProjectionPoint[] {
  // Per-effective-rate factor memo, call-scoped. `factorFor(catId)`
  // returns the inflation-factor closure for the category's effective rate
  // (general rate when the category carries no override).
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  // Clamp to [-100, +100]: stored values outside this range are silently
  // bounded so the multiplier never goes negative or above ×2.
  const bumpPct = Math.max(-100, Math.min(100, ctx.discretionarySpending?.bumpPct ?? 0));
  // `durationYears` semantics: `null` = whole retirement, a positive
  // integer = first N years. The override stores `null` explicitly when
  // the user picked "whole retirement", so distinguish missing-key
  // (`undefined` → default) from set-to-null (`null` → whole-retirement).
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
      // `{ nominal, base }` differ only by the inflation factor; the
      // glide is folded into both halves inside the helper (Decision
      // 14 / 19), so only the inflation-independent `discMultiplier`
      // is applied here.
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
 * Per-month sample for the **Expenses by Category** chart. Same shape
 * as `ExpenseProjectionMonthlyPoint` but values are bucketed by the
 * expense's `categoryId` instead of by classification. Categories with
 * no active expense at this month carry 0; the caller decides which
 * categories to actually render (typically: every category that has a
 * non-zero value in any month of the chart range).
 */
export interface ExpenseCategoryMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  byCategoryId: Record<string, number>;
  total: number;
  /**
   * Per-category **recurring** run-rate ($/yr) and literal **one-off**
   * spike for this month, split out of `byCategoryId` so a band-basis
   * consumer (the cashflow category band) can apply the same
   * `monthlyBucket(recurring, spike, f)` math the displayed essential /
   * discretionary band uses — `(recurring − spike)/12 + spike`. A
   * continuous category lands entirely in `recurringByCategoryId`; a
   * one-off category's literal amount lands in BOTH (`recurring` includes
   * the spike, `oneOff` carries it) exactly like the
   * essential/discretionary `oneOff*` fields. `byCategoryId[c] ===
   * recurringByCategoryId[c]` for every category (the run-rate IS the
   * monthly value); `oneOffByCategoryId[c]` is the spike subset. Additive
   * — the prior `byCategoryId` consumers (Expenses page) are unchanged.
   */
  recurringByCategoryId: Record<string, number>;
  oneOffByCategoryId: Record<string, number>;
}

/**
 * Cadence-correct per-year per-category expense rollup for the cashflow
 * category band's Yearly mode. Mirrors `projectExpensesByYear`'s
 * essential/discretionary annual basis (continuous = active-months
 * rollup; one-off = literal full amount), bucketed by `categoryId`
 * instead of by classification. `byCategoryId` sums to the same total as
 * `projectExpensesByYear(...).total` for the same inputs (sub-cent FP),
 * so the per-category bands tie to the displayed essential+discretionary
 * total in Yearly mode. The discretionary adjustment + per-expense glide
 * apply identically to the by-classification function.
 */
export interface ExpenseCategoryYearPoint {
  year: number;
  byCategoryId: Record<string, number>;
  total: number;
}

/**
 * Category-resolution variant of `projectExpensesByMonth`. Same
 * underlying math (continuous expenses at flat run-rate, one-off
 * lump sums at literal `amount` for one month). Discretionary adjustment
 * applies the same way it does in `projectExpensesByMonth` — multiplies
 * the discretionary-classified expense's contribution before it lands
 * in its category bucket.
 */
export function projectExpensesByCategoryMonth(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseCategoryMonthlyPoint[] {
  // Per-effective-rate factor memo, call-scoped — so the per-category
  // chart matches the band/table (Medical grows at general+2 while other
  // categories grow at the general rate).
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  // Clamp to [-100, +100].
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

        // Each category inflates at its own effective rate (general rate
        // when no override / no Medical default applies).
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
        // Glide applies to any expense; the discretionary adjustment
        // (`discMultiplier`) stays discretionary-only.
        rate *= glideMultiplierFor(r.payload, monthIndex(year, month0), ctx);
        if (r.payload.classification === 'discretionary') {
          rate *= discMultiplier;
        }
        const cat = r.payload.categoryId;
        byCategoryId[cat] = round2((byCategoryId[cat] ?? 0) + rate);
        // Track the one-off spike subset so a band-basis consumer can run
        // `monthlyBucket(recurring, spike, f)` per category. The run-rate
        // (`byCategoryId`) doubles as `recurring` (it IS the monthly value).
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
        // `recurringByCategoryId` is the full monthly run-rate value
        // (continuous run-rate + the literal one-off spike), identical to
        // `byCategoryId`; the spike subset lives in `oneOffByCategoryId`
        // so `monthlyBucket` can net it out of the ÷12 slice.
        recurringByCategoryId: byCategoryId,
        oneOffByCategoryId,
      });
    }
  }
  return out;
}

/**
 * Cadence-correct per-year per-category rollup for the cashflow category
 * band's Yearly mode. Reuses `yearExpenseContribution` (the SAME helper
 * `projectExpensesByYear` uses for its essential/discretionary annual
 * basis: continuous = active-months rollup, one-off = literal amount) and
 * buckets the `nominal` contribution by `categoryId` instead of by
 * classification. The discretionary `discMultiplier` is applied to a
 * discretionary-classified expense's contribution exactly as in
 * `projectExpensesByYear`, so `Σ byCategoryId` ties to that function's
 * `total` for the same inputs (sub-cent FP). The caller passes the
 * mode-appropriate inflation in `ctx` (0% pinned in Today's-dollars,
 * scenario rate in Future), mirroring the band.
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
 * Earliest active-start month across the resolved expense list, taking
 * broken anchors into account (skipped). Returns null when nothing is
 * resolvable (e.g. every expense's anchored member is missing, or the
 * list is empty). Used to widen the chart's left edge so an expense
 * that starts before retirement is visible from its true start month
 * rather than clipped at retirementYear.
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

/** True iff the calendar (year, month0) tuple is within the active
 *  window [startMonth, endMonthExclusive). */
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

/**
 * One expense's pre-classification per-month rate as a `{ nominal,
 * base }` pair plus the one-off flag. `nominal` is the existing
 * month-precise-inflated rate; `base` is the same rate with the
 * inflation `monthFactor` omitted — exactly `nominal ÷ monthFactor`,
 * one inflation factor per month. The glide is applied by
 * the caller (computed once, multiplied into both halves identically),
 * so the only difference between `nominal` and `base` is inflation.
 * `isOneOff` lets the caller route the value into the one-off spike
 * buckets. `null` ⇒ the expense is inactive this month.
 */
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
 * Month-resolution variant of `projectExpensesByYear`. Emits 12 points
 * per calendar year covering the requested range. Each point's amounts
 * are *annualized run-rates* in $/yr — see `ExpenseProjectionMonthlyPoint`
 * for the full semantics and the annual-rollup invariant.
 *
 * Pure: same inputs always produce same outputs. Inflation compounds
 * month-precise from `ctx`'s `asOfMonth`; discretionary
 * adjustment window evaluates per-year because the window is defined in
 * whole years from retirement-start.
 */
export function projectExpensesByMonth(
  resolved: ResolvedExpense[],
  ctx: ProjectionContext,
  yearRange: { from: number; to: number },
): ExpenseProjectionMonthlyPoint[] {
  // Per-effective-rate factor memo, call-scoped.
  const { factorFor } = buildEffectiveInflationFactor(ctx);
  // Clamp to [-100, +100].
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
      // Track literal one-off spikes separately so consumers that need
      // true monthly cashflow (drawdown engine) can extract run-rate
      // vs spike. Both buckets stay summed into `essential` /
      // `discretionary` for the chart band's existing semantics. The
      // `*Base` accumulators are the inflation-free analogues (per-month
      // `base = nominal ÷ monthFactor`, glide retained).
      let oneOffEssential = 0;
      let oneOffDiscretionary = 0;
      let essentialBase = 0;
      let discretionaryBase = 0;
      let oneOffEssentialBase = 0;
      let oneOffDiscretionaryBase = 0;

      for (const r of resolved) {
        if (isScheduleAnchorBroken(r.payload.start, r.payload.end, ctx))
          continue;

        // Each category inflates at its own effective rate.
        const monthFactor = factorFor(r.payload.categoryId)(year, month0);
        const rate = monthExpenseRate(r, year, month0, ctx, monthFactor);
        if (!rate || (rate.nominal === 0 && rate.base === 0)) continue;
        // Glide applies to any expense — computed once and multiplied
        // into both halves so the real-terms scaling is identical; only
        // the inflation factor differs nominal-vs-base. The
        // discretionary adjustment (`discMultiplier`) stays
        // discretionary-only: essential `realScale = glide`, discretionary
        // `realScale = discMultiplier × glide`.
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
