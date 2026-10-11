/**
 * Market-stress transforms.
 *
 * Pure, engine-agnostic helpers that turn a base `MonteCarloInput` into a
 * stressed one for the four named sensitivity cases. Each stress
 * reuses the SAME random paths as its base comparison — the fee, return, and
 * inflation shocks are deterministic mean-shifts folded into the engine's
 * per-account return series / CPI centering (they never touch the RNG), and the
 * longevity shock only EXTENDS the horizon, so the overlapping years draw the
 * identical seeded months. That shared-path property is what makes a
 * before/after probability-of-success / shortfall comparison valid.
 *
 * This module is the reusable core; it renders no UI itself. It is LIVE: the
 * Balance Projection page's "Compare against market stresses" surface
 * (`components/plan-market-stress-comparison.ts`) runs every case through
 * it once the page's own stress-test result settles, and the exported report
 * restates its names and magnitudes.
 *
 * The sensitivities:
 *   - Higher fees:      +0.50 pp annual investment cost.
 *   - Lower returns:    stocks −2 pp, bonds/cash −1 pp (annual).
 *   - Higher inflation: +2 pp annual.
 *   - Longer life:      +5 years, capped at age 105.
 *
 * See docs/math-projections.md, "The four market stress tests".
 */
import type { MonteCarloInput, MonteCarloSummary } from './monte-carlo-types.js';
import type { AssetMix } from '../db/types.js';

/**
 * Stress-only maximum simulated age. DELIBERATELY DISTINCT from the
 * aggregate `MAX_AGE` (100, `db/types/aggregate-base.ts`) and the user-facing
 * life-expectancy editor cap `LIFE_MAX` (also 100): the longevity stress may
 * carry the horizon to 105 WITHOUT changing either of those — they bound the
 * user's editable plan, this bounds a transient sensitivity run.
 */
export const STRESS_MAX_AGE = 105;

/** The named market-stress cases. */
export type StressCaseId =
  | 'higherFees'
  | 'lowerReturns'
  | 'higherInflation'
  | 'longerLife';

/** All four stress cases in presentation order. */
export const STRESS_CASE_IDS: readonly StressCaseId[] = [
  'higherFees',
  'lowerReturns',
  'higherInflation',
  'longerLife',
];

/**
 * The magnitude of each shock lever. Every field is a POSITIVE "worse than
 * base" delta; a case leaves inactive levers at 0. Fixed — the stresses
 * are product-approved sensitivities, not per-scenario settings.
 */
export interface StressShocks {
  /** Annual investment cost (pp). The base plan carries no cost, so this IS the
   *  modeled fee rather than an increment on a stored one. */
  readonly investmentCostPctDelta: number;
  /** Annual return reduction (pp) on the stock sleeve. */
  readonly returnShockStocksPct: number;
  /** Annual return reduction (pp) on the bond sleeve. */
  readonly returnShockBondsPct: number;
  /** Annual return reduction (pp) on the cash sleeve. */
  readonly returnShockCashPct: number;
  /** Extra annual inflation (pp). */
  readonly inflationShockPct: number;
  /** Extra years of life, before the age-105 cap. */
  readonly longevityShockYears: number;
}

const NO_SHOCK: StressShocks = {
  investmentCostPctDelta: 0,
  returnShockStocksPct: 0,
  returnShockBondsPct: 0,
  returnShockCashPct: 0,
  inflationShockPct: 0,
  longevityShockYears: 0,
};

/** The shock magnitudes per named case. */
export const STRESS_CASES: Readonly<Record<StressCaseId, StressShocks>> = {
  higherFees: { ...NO_SHOCK, investmentCostPctDelta: 0.5 },
  lowerReturns: {
    ...NO_SHOCK,
    returnShockStocksPct: 2,
    returnShockBondsPct: 1,
    returnShockCashPct: 1,
  },
  higherInflation: { ...NO_SHOCK, inflationShockPct: 2 },
  longerLife: { ...NO_SHOCK, longevityShockYears: 5 },
};

/**
 * Percent reading for a stress magnitude. Trims trailing zeros so `0.5` reads
 * "0.5%" and `2` reads "2%" — one formatter for every surface, because the
 * comparison table and the exported report previously disagreed ("0.50%" vs
 * "0.5%") about the same approved number.
 */
function stressPct(n: number): string {
  return `${Number(n.toFixed(2))}%`;
}

/** Plain-English name + the assumption each named stress changes. */
export interface StressCaseCopy {
  readonly name: string;
  readonly changed: string;
}

/**
 * The one place a stress case is NAMED and DESCRIBED. The
 * comparison table on the Balance Projection page and the exported report both
 * read from here, and every magnitude is interpolated from `STRESS_CASES`
 * above — so a change to an approved magnitude can never leave a stale number
 * in the copy, and the two surfaces can never drift apart.
 *
 * ONE phrasing depends on a value the sentence does not name: "bonds and cash
 * <n>% a year lower" combines two levers into one reading, so it is accurate
 * only while `returnShockBondsPct === returnShockCashPct`. `market-stress.test.ts`
 * asserts that equality, so a future divergence fails the suite instead of
 * silently shipping copy that understates or overstates the cash sleeve.
 */
export const STRESS_CASE_COPY: Readonly<Record<StressCaseId, StressCaseCopy>> = {
  higherFees: {
    name: 'Higher fees',
    changed: `Investment cost ${stressPct(STRESS_CASES.higherFees.investmentCostPctDelta)} a year higher`,
  },
  lowerReturns: {
    name: 'Lower returns',
    changed:
      `Stocks ${stressPct(STRESS_CASES.lowerReturns.returnShockStocksPct)} a year lower; ` +
      // Combined reading — valid only while the bond and cash shocks are equal,
      // which `market-stress.test.ts` pins.
      `bonds and cash ${stressPct(STRESS_CASES.lowerReturns.returnShockBondsPct)} a year lower`,
  },
  higherInflation: {
    name: 'Higher inflation',
    changed: `Inflation ${stressPct(STRESS_CASES.higherInflation.inflationShockPct)} a year higher`,
  },
  longerLife: {
    name: 'Longer life',
    changed: `${STRESS_CASES.longerLife.longevityShockYears} more years of retirement`,
  },
};

/**
 * Household-specific "What changes" reading for the longevity stress.
 *
 * The generic {@link STRESS_CASE_COPY} entry deliberately stops at "+5 more
 * years of retirement": the age-105 ceiling only ever BINDS for a plan already
 * running past 100, so naming it on every row announced a limit that is
 * irrelevant to nearly every household — and made the row read as though the
 * plan itself runs to 105. On screen, where the household's birth years ARE
 * known, the row names the age actually reached instead, which is both concrete
 * and — in the rare capped case — self-explanatory.
 *
 * The age belongs to the LAST SURVIVING member, not to the cap anchor. The plan
 * ends when the last survivor dies, so those are the years being added to THEIR
 * life; the cap anchor (the youngest member, `longestLivedBirthYear`) only
 * bounds how far the horizon may run. They are the same person in an ordinary
 * household and diverge when an older member's longer life expectancy carries
 * them past a younger one — where naming the youngest would credit the added
 * years to someone the plan already buried. `survivor` is `null` when no member
 * has a usable birthdate, and `survivor.firstName` is `null` when no single
 * member owns the last death year; the reading degrades to an unattributed age
 * and then to no age at all, rather than naming the wrong person. The
 * `<name> (age <n>)` form matches every projection-chart tooltip.
 */
export function longerLifeChangedText(
  baseHorizonYear: number,
  longestLivedBirthYear: number,
  survivor: { readonly firstName: string | null; readonly birthYear: number } | null,
): string {
  const stressedHorizonYear = resolveStressHorizonYear(
    baseHorizonYear,
    longestLivedBirthYear,
    STRESS_CASES.longerLife.longevityShockYears,
  );
  // The years ACTUALLY added, which is what the cap can shorten — stating the
  // approved +5 next to a capped age would promise years the run never
  // simulated. A household editing its plan in the UI never sees this bite (the
  // life-expectancy control maxes at 100, so +5 lands on 105 at worst), but
  // `ScenarioOverrides.lifeExpectancy` carries no RUNTIME bound: an imported
  // scenario can hold an age past 100 and push the base horizon beyond the cap,
  // where the honest reading is a smaller number — or none at all.
  const added = stressedHorizonYear - baseHorizonYear;
  const years = `${added} more year${added === 1 ? '' : 's'} of retirement`;
  if (survivor === null) {
    // No usable birthdate anywhere, so there is no age to report. The
    // comparison is withheld in that state anyway; this keeps the copy honest
    // rather than inventing one.
    return added <= 0 ? 'No added years' : years;
  }
  const age = stressedHorizonYear - survivor.birthYear;
  if (added <= 0) {
    // The one reading where "whose age is this?" is least obvious, so it names
    // the survivor too where it can rather than dropping them.
    return survivor.firstName === null
      ? `No added years — already at age ${age}`
      : `No added years — ${survivor.firstName} already at age ${age}`;
  }
  const who = survivor.firstName === null ? 'to age' : `${survivor.firstName} age`;
  return `${years} (${who} ${age})`;
}

/**
 * True when the case lengthens the plan instead of only re-pricing it. These
 * are the cases whose "same simulated market histories" claim holds only
 * through the ORIGINAL end of the plan — the appended years draw fresh months
 * and repeat the last year's income and spending — so every surface that makes
 * the same-paths claim must qualify itself for them.
 */
export function stressExtendsHorizon(caseId: StressCaseId): boolean {
  return STRESS_CASES[caseId].longevityShockYears > 0;
}

/** Household context the longevity cap needs (the age-105 anchor). */
export interface StressContext {
  /**
   * Calendar birth year of the youngest household member (the latest birth
   * year) — anchors the age-105 longevity cap (`birthYear + STRESS_MAX_AGE`).
   */
  readonly longestLivedBirthYear: number;
}

/**
 * Resolve the longevity-stressed horizon calendar year: extend the base horizon
 * by `longevityShockYears`, but never past age 105 for the youngest member. Caps at 105 EVEN WHEN the base horizon already sits at `MAX_AGE`
 * (the editor cap of 100 → the stress still reaches 105, five years beyond).
 * Never shortens the horizon (a negative shock would be ignored).
 */
export function resolveStressHorizonYear(
  baseHorizonYear: number,
  longestLivedBirthYear: number,
  longevityShockYears: number,
): number {
  if (longevityShockYears <= 0) return baseHorizonYear;
  const age105Year = longestLivedBirthYear + STRESS_MAX_AGE;
  const extended = baseHorizonYear + longevityShockYears;
  return Math.max(baseHorizonYear, Math.min(extended, age105Year));
}

/**
 * Overlay the fee / return / inflation levers of a shock set onto `base`
 * WITHOUT changing the horizon. These three are scalar engine parameters
 * (`annualInvestmentCostPct`, `returnShock`, `inflationShockPct`) that mean-shift
 * the sampled series in place, so the run keeps `base`'s exact random paths.
 * An all-zero shock returns `base` UNCHANGED (referential identity) so callers
 * can cheaply detect the no-op and the frozen fixtures stay byte-identical.
 */
export function applyReturnCostInflationShocks(
  base: MonteCarloInput,
  shocks: StressShocks,
): MonteCarloInput {
  const costActive = shocks.investmentCostPctDelta !== 0;
  const returnActive =
    shocks.returnShockStocksPct !== 0 ||
    shocks.returnShockBondsPct !== 0 ||
    shocks.returnShockCashPct !== 0;
  const inflationActive = shocks.inflationShockPct !== 0;
  if (!costActive && !returnActive && !inflationActive) return base;

  const next: MonteCarloInput = { ...base };
  if (costActive) {
    (next as { annualInvestmentCostPct?: number }).annualInvestmentCostPct =
      (base.annualInvestmentCostPct ?? 0) + shocks.investmentCostPctDelta;
  }
  if (returnActive) {
    (next as { returnShock?: MonteCarloInput['returnShock'] }).returnShock = {
      stocksPct: shocks.returnShockStocksPct,
      bondsPct: shocks.returnShockBondsPct,
      cashPct: shocks.returnShockCashPct,
    };
  }
  if (inflationActive) {
    (next as { inflationShockPct?: number }).inflationShockPct =
      (base.inflationShockPct ?? 0) + shocks.inflationShockPct;
  }
  return next;
}

/** Repeat the final simulated year's monthly pattern across `extraSteps`
 *  appended months (retirement spending/income continues flat-real). */
function extendMonthlySeries(base: readonly number[], extraSteps: number): number[] {
  const out = base.slice();
  const len = base.length;
  for (let j = 0; j < extraSteps; j += 1) {
    // Mirror the last full 12-month cycle so appended December ≠ appended
    // January where the base year had a spike month.
    out.push(base[len - 12 + (j % 12)]);
  }
  return out;
}

/** Hold the final value across `extraYears` appended per-year entries. */
function extendYearlySeries(base: readonly number[], extraYears: number): number[] {
  const out = base.slice();
  const last = base.length > 0 ? base[base.length - 1] : 0;
  for (let j = 0; j < extraYears; j += 1) out.push(last);
  return out;
}

/** Append `extraSteps` zero months to a per-step ledger array (no
 *  contributions/deposits in the extended retirement years). */
function extendWithZeros(base: Float64Array, extraSteps: number): Float64Array {
  const out = new Float64Array(base.length + extraSteps);
  out.set(base);
  return out;
}

/** Repeat the final asset mix across `extraSteps` appended months. */
function extendMixSeries(
  base: ReadonlyArray<AssetMix>,
  extraSteps: number,
): AssetMix[] {
  const out = base.slice();
  const last = base[base.length - 1];
  for (let j = 0; j < extraSteps; j += 1) out.push(last);
  return out;
}

/** Hold the final month's value across `extraSteps` appended months of an
 *  injected per-month series (injected-returns test harness). The
 *  extended window repeats the last known month rather than resampling, so the
 *  strict length check in `monte-carlo-step-inputs.ts` still matches the new
 *  horizon after a longevity stress. */
function extendFloat64HoldLast(base: Float64Array, extraSteps: number): Float64Array {
  const out = new Float64Array(base.length + extraSteps);
  out.set(base);
  const last = base.length > 0 ? base[base.length - 1] : 0;
  for (let j = base.length; j < out.length; j += 1) out[j] = last;
  return out;
}

/** Mutable view of `MonteCarloInput` for the in-place field assignment the
 *  optional-series / survivor-state extension helpers perform (one
 *  `readonly`-strip at the type layer instead of a per-field unsafe cast). */
type MutableMonteCarloInput = { -readonly [K in keyof MonteCarloInput]: MonteCarloInput[K] };

/**
 * Assign an extended optional series onto the draft only when `base` carried it,
 * so an absent optional stays absent. The single localized cast lives here
 * instead of at every call site, and `K extends keyof MonteCarloInput` keeps the
 * key and the `extend` result type-checked (a renamed/removed field breaks the
 * call, not silently drops the extension).
 */
function assignExtended<K extends keyof MonteCarloInput>(
  draft: MutableMonteCarloInput,
  key: K,
  baseValue: MonteCarloInput[K] | undefined,
  extend: (value: NonNullable<MonteCarloInput[K]>) => MonteCarloInput[K],
): void {
  if (baseValue === undefined) return;
  draft[key] = extend(baseValue as NonNullable<MonteCarloInput[K]>);
}

/** Extend one per-account MC ledger entry to the longer horizon: contribution /
 *  deposit ledgers gain zero months (the extra years are retirement years), the
 *  optional planned-contribution and glide-mix series their held/mirrored tails. */
function extendLedgerEntry(
  entry: MonteCarloInput['accountMcLedger'][number],
  extraSteps: number,
): MonteCarloInput['accountMcLedger'][number] {
  return {
    ...entry,
    contribPre: extendWithZeros(entry.contribPre, extraSteps),
    contribPost: extendWithZeros(entry.contribPost, extraSteps),
    deposit: extendWithZeros(entry.deposit, extraSteps),
    ...(entry.depositPre ? { depositPre: extendWithZeros(entry.depositPre, extraSteps) } : {}),
    ...(entry.depositPost ? { depositPost: extendWithZeros(entry.depositPost, extraSteps) } : {}),
    ...(entry.plannedContribPostBase
      ? { plannedContribPostBase: extendWithZeros(entry.plannedContribPostBase, extraSteps) }
      : {}),
    ...(entry.assetMixSeries
      ? { assetMixSeries: extendMixSeries(entry.assetMixSeries, extraSteps) }
      : {}),
  };
}

/** Pad every optional horizon-length series `base` carries onto `next`
 *  (extracted from `extendHorizon` to keep it under the 60-line shape limit).
 *  Per-month medical/expense-bucket series mirror the final year; per-year
 *  income-tracking / guardrail series hold their last value; the injected
 *  test-harness arrays hold their last month. */
function extendOptionalSeries(
  next: MutableMonteCarloInput,
  base: MonteCarloInput,
  extraYears: number,
  extraSteps: number,
): void {
  assignExtended(next, 'monthlyExpenseBucketsBase', base.monthlyExpenseBucketsBase, (v) =>
    v.map((b) => ({ ratePct: b.ratePct, amount: extendMonthlySeries(b.amount, extraSteps) })),
  );
  assignExtended(next, 'monthlyMedicalDemandBase', base.monthlyMedicalDemandBase, (v) =>
    extendMonthlySeries(v, extraSteps),
  );
  assignExtended(next, 'monthlyMedicalDemandBucketsBase', base.monthlyMedicalDemandBucketsBase, (v) =>
    v.map((b) => ({ ratePct: b.ratePct, amount: extendMonthlySeries(b.amount, extraSteps) })),
  );
  assignExtended(next, 'tracksInflationIncomeByYear', base.tracksInflationIncomeByYear, (v) =>
    extendYearlySeries(v, extraYears),
  );
  assignExtended(
    next,
    'guardrailBaselineRealNetNeedByYear',
    base.guardrailBaselineRealNetNeedByYear,
    (v) => extendYearlySeries(v, extraYears),
  );
  assignExtended(next, 'guardrailEssentialRealByYear', base.guardrailEssentialRealByYear, (v) =>
    extendYearlySeries(v, extraYears),
  );
  assignExtended(next, 'guardrailBaselineTotalRealByYear', base.guardrailBaselineTotalRealByYear, (v) =>
    extendYearlySeries(v, extraYears),
  );
  // Injected-returns test harness — both companion arrays must grow with
  // the horizon or the strict length check in monte-carlo-step-inputs.ts throws.
  assignExtended(next, 'injectedReturns', base.injectedReturns, (v) =>
    extendFloat64HoldLast(v, extraSteps),
  );
  assignExtended(next, 'injectedCpi', base.injectedCpi, (v) =>
    extendFloat64HoldLast(v, extraSteps),
  );
}

/**
 * Keep the extended input's per-member death markers self-consistent with
 * the flat income/SS/expense padding, which continues to pay BOTH members as if
 * alive through the whole extended horizon. `taxContext` / `mcRmdContext` carry a
 * `primaryDeathYear` / `secondaryDeathYear` (`undefined` = alive every year;
 * `taxYear <= deathYear` = alive) that the tax + RMD engines read to gate
 * survivor benefits, filing status and RMD applicability.
 *
 * A death year that falls AT or AFTER the original horizon end (the member was
 * still modeled alive when the base run ended) would, once the horizon is
 * extended past it, gate the newly-appended years as post-death while the padded
 * income keeps paying that member — an internal contradiction. Those years are
 * pushed out to the new horizon so the member stays alive across the padded
 * window, matching the income. A death year STRICTLY BEFORE the original horizon
 * end is left unchanged (the member was already dead before the extension began,
 * and the padded income tail already reflects the survivor); `undefined` is
 * likewise left unchanged (already "alive every year").
 *
 * This deliberately does NOT re-derive a NEW survivor-benefit / filing-status
 * schedule for the extended window (that needs the upstream context builder, out
 * of this transform's reach — see the module note); it only removes the internal
 * contradiction the same-horizon padding would otherwise create.
 */
function reconcileSurvivorDeathState(
  next: MutableMonteCarloInput,
  base: MonteCarloInput,
  newHorizonYear: number,
): void {
  const reconcile = (deathYear: number | undefined): number | undefined =>
    deathYear === undefined || deathYear < base.horizonYear
      ? deathYear
      : Math.max(deathYear, newHorizonYear);
  if (base.taxContext) {
    next.taxContext = {
      ...base.taxContext,
      primaryDeathYear: reconcile(base.taxContext.primaryDeathYear),
      secondaryDeathYear: reconcile(base.taxContext.secondaryDeathYear),
    };
  }
  if (base.mcRmdContext) {
    next.mcRmdContext = {
      ...base.mcRmdContext,
      primaryDeathYear: reconcile(base.mcRmdContext.primaryDeathYear),
      secondaryDeathYear: reconcile(base.mcRmdContext.secondaryDeathYear),
    };
  }
}

/**
 * Extend a fully-assembled `MonteCarloInput` to a longer horizon (the longevity
 * stress). Every horizon-length series is padded: per-month spending repeats the
 * final year's flat-real pattern, per-year SS/income/guardrail series hold their
 * last value, per-account contribution/deposit arrays get zero months (the extra
 * years are retirement years), and the injected test-harness arrays hold their
 * last month. The per-member death markers are reconciled so the appended
 * years stay self-consistent with the padded income. The seed is
 * untouched, so the first `base.horizonYear` months draw the IDENTICAL sampled
 * paths — only the appended years add fresh market draws.
 *
 * DISCLOSED APPROXIMATION: padding is a same-horizon
 * approximation of what a full re-assembly at the longer horizon would build.
 * It does NOT re-derive a new survivor-benefit / filing-status transition
 * inside the extended window (it only reconciles the death markers so no
 * appended year is both alive-for-income and dead-for-tax), and Social Security
 * / other income hold their last NOMINAL dollar with no further COLA, so their
 * real value erodes across the appended years. Only that flat-nominal hold has
 * a knowable direction. Retaining the base run's survivor / filing state is NOT
 * directionally conservative — it can keep joint filing and both members'
 * income running through the extension, LOWERING modeled tax or retaining
 * income a rebuilt survivor schedule would have dropped — and the appended
 * fresh draws can help or hurt. The net direction is household-dependent, so
 * every user-facing disclosure states the approximation WITHOUT claiming one.
 * All three are DISCLOSED wherever a longevity-bearing comparison is shown —
 * the comparison footnote, the methodology modal, and the exported report — so
 * the approximation is never presented as an exact re-run. When
 * `newHorizonYear <= horizonYear` the input is returned UNCHANGED.
 */
export function extendHorizon(
  base: MonteCarloInput,
  newHorizonYear: number,
): MonteCarloInput {
  if (newHorizonYear <= base.horizonYear) return base;
  const extraYears = newHorizonYear - base.horizonYear;
  const extraSteps = extraYears * 12;

  const next: MutableMonteCarloInput = {
    ...base,
    horizonYear: newHorizonYear,
    monthlyExpenseBase: extendMonthlySeries(base.monthlyExpenseBase, extraSteps),
    ssByYear: extendYearlySeries(base.ssByYear, extraYears),
    incomeByYear: extendYearlySeries(base.incomeByYear, extraYears),
    accountMcLedger: base.accountMcLedger.map((entry) => extendLedgerEntry(entry, extraSteps)),
  };
  extendOptionalSeries(next, base, extraYears, extraSteps);
  reconcileSurvivorDeathState(next, base, newHorizonYear);
  return next;
}

/**
 * Apply a named stress case to `base`, producing the input for the stress run.
 * Composes all active levers: the fee/return/inflation overlay (same paths) and
 * the longevity horizon extension (age-105 capped). An all-zero case is a no-op.
 */
export function applyStress(
  base: MonteCarloInput,
  caseId: StressCaseId,
  context: StressContext,
): MonteCarloInput {
  const shocks = STRESS_CASES[caseId];
  const withShocks = applyReturnCostInflationShocks(base, shocks);
  if (shocks.longevityShockYears <= 0) return withShocks;
  const newHorizon = resolveStressHorizonYear(
    base.horizonYear,
    context.longestLivedBirthYear,
    shocks.longevityShockYears,
  );
  return extendHorizon(withShocks, newHorizon);
}

/**
 * The before/after comparison for one stress case: probability-of-success and
 * shortfall (median-depletion / ending-balance) deltas against the base run.
 * `successProbabilityDelta` is `stress − base` (≤ 0 for an adverse stress).
 */
export interface StressDelta {
  readonly caseId: StressCaseId;
  readonly baseSuccessProbability: number;
  readonly stressSuccessProbability: number;
  /** stress − base; negative means the stress lowers the success rate. */
  readonly successProbabilityDelta: number;
  readonly baseMedianDepletionYear: number | null;
  readonly stressMedianDepletionYear: number | null;
  readonly baseMedianEndingBalanceReal: number;
  readonly stressMedianEndingBalanceReal: number;
  /** stress − base; negative means the stress lowers the median ending balance. */
  readonly medianEndingBalanceRealDelta: number;
}

/** Compute the stress-vs-base delta result from two summaries. */
export function computeStressDelta(
  caseId: StressCaseId,
  base: MonteCarloSummary,
  stress: MonteCarloSummary,
): StressDelta {
  return {
    caseId,
    baseSuccessProbability: base.successProbability,
    stressSuccessProbability: stress.successProbability,
    successProbabilityDelta: stress.successProbability - base.successProbability,
    baseMedianDepletionYear: base.medianDepletionYear,
    stressMedianDepletionYear: stress.medianDepletionYear,
    baseMedianEndingBalanceReal: base.medianEndingBalanceReal,
    stressMedianEndingBalanceReal: stress.medianEndingBalanceReal,
    medianEndingBalanceRealDelta:
      stress.medianEndingBalanceReal - base.medianEndingBalanceReal,
  };
}
