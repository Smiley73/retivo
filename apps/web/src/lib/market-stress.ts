// Market-stress transforms: turn a base `MonteCarloInput` into a stressed one for the four named cases.
// See docs/math-projections.md, "The four market stress tests".

import type { MonteCarloInput, MonteCarloSummary } from './monte-carlo-types.js';
import type { AssetMix } from '../db/types.js';

/**
 * Maximum simulated age for the longevity stress. Distinct from `MAX_AGE` and
 * `LIFE_MAX` (both 100): the stress may reach 105 without moving the bounds on
 * the user's editable plan.
 */
export const STRESS_MAX_AGE = 105;

export type StressCaseId =
  | 'higherFees'
  | 'lowerReturns'
  | 'higherInflation'
  | 'longerLife';

export const STRESS_CASE_IDS: readonly StressCaseId[] = [
  'higherFees',
  'lowerReturns',
  'higherInflation',
  'longerLife',
];

/** Each field is a positive "worse than base" delta; a case leaves inactive levers at 0. */
interface StressShocks {
  /** Annual investment cost (pp); the base plan carries none, so this is the modeled fee. */
  readonly investmentCostPctDelta: number;
  readonly returnShockStocksPct: number;
  readonly returnShockBondsPct: number;
  readonly returnShockCashPct: number;
  readonly inflationShockPct: number;
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

// One formatter so the comparison table and the exported report read the same approved number.
function stressPct(n: number): string {
  return `${Number(n.toFixed(2))}%`;
}

export interface StressCaseCopy {
  readonly name: string;
  readonly changed: string;
}

/**
 * The one place a stress case is named and described; every magnitude comes from
 * `STRESS_CASES`. The "bonds and cash <n>% a year lower" phrasing is accurate
 * only while `returnShockBondsPct === returnShockCashPct`, which
 * `market-stress.test.ts` asserts.
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
 * Household-specific "What changes" reading for the longevity stress. It names
 * the age actually reached rather than the age-105 cap, which only binds for a
 * plan already running past 100. The age belongs to the last surviving member
 * (`survivor`), not the cap anchor (the youngest member): the added years extend
 * the survivor's life. `survivor` is null without a usable birthdate and
 * `survivor.firstName` is null when no single member owns the last death year;
 * the reading then drops the name, then the age, rather than name the wrong person.
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
  // The years actually added, which the cap can shorten: an imported scenario can hold a
  // life expectancy past 100, pushing the base horizon beyond the cap.
  const added = stressedHorizonYear - baseHorizonYear;
  const years = `${added} more year${added === 1 ? '' : 's'} of retirement`;
  if (survivor === null) {
    // No usable birthdate, so there is no age to report.
    return added <= 0 ? 'No added years' : years;
  }
  const age = stressedHorizonYear - survivor.birthYear;
  if (added <= 0) {
    return survivor.firstName === null
      ? `No added years — already at age ${age}`
      : `No added years — ${survivor.firstName} already at age ${age}`;
  }
  const who = survivor.firstName === null ? 'to age' : `${survivor.firstName} age`;
  return `${years} (${who} ${age})`;
}

/**
 * True when the case lengthens the plan rather than only re-pricing it. For
 * these the "same simulated market histories" claim holds only through the
 * original end of the plan: the appended years draw fresh months.
 */
export function stressExtendsHorizon(caseId: StressCaseId): boolean {
  return STRESS_CASES[caseId].longevityShockYears > 0;
}

export interface StressContext {
  /** Birth year of the youngest member; anchors the age-105 cap. */
  readonly longestLivedBirthYear: number;
}

/**
 * The longevity-stressed horizon year: the base horizon extended by
 * `longevityShockYears`, capped at age 105 for the youngest member (even when
 * the base horizon already sits at 100), and never shortened.
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
 * Overlays the fee, return and inflation levers onto `base` without changing the
 * horizon, so the run keeps `base`'s random paths. An all-zero shock returns
 * `base` itself so callers can detect the no-op.
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

function extendMonthlySeries(base: readonly number[], extraSteps: number): number[] {
  const out = base.slice();
  const len = base.length;
  for (let j = 0; j < extraSteps; j += 1) {
    out.push(base[len - 12 + (j % 12)]);
  }
  return out;
}

function extendYearlySeries(base: readonly number[], extraYears: number): number[] {
  const out = base.slice();
  const last = base.length > 0 ? base[base.length - 1] : 0;
  for (let j = 0; j < extraYears; j += 1) out.push(last);
  return out;
}

function extendWithZeros(base: Float64Array, extraSteps: number): Float64Array {
  const out = new Float64Array(base.length + extraSteps);
  out.set(base);
  return out;
}

function extendMixSeries(
  base: ReadonlyArray<AssetMix>,
  extraSteps: number,
): AssetMix[] {
  const out = base.slice();
  const last = base[base.length - 1];
  for (let j = 0; j < extraSteps; j += 1) out.push(last);
  return out;
}

function extendFloat64HoldLast(base: Float64Array, extraSteps: number): Float64Array {
  const out = new Float64Array(base.length + extraSteps);
  out.set(base);
  const last = base.length > 0 ? base[base.length - 1] : 0;
  for (let j = base.length; j < out.length; j += 1) out[j] = last;
  return out;
}

type MutableMonteCarloInput = { -readonly [K in keyof MonteCarloInput]: MonteCarloInput[K] };

function assignExtended<K extends keyof MonteCarloInput>(
  draft: MutableMonteCarloInput,
  key: K,
  baseValue: MonteCarloInput[K] | undefined,
  extend: (value: NonNullable<MonteCarloInput[K]>) => MonteCarloInput[K],
): void {
  if (baseValue === undefined) return;
  draft[key] = extend(baseValue as NonNullable<MonteCarloInput[K]>);
}

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
  assignExtended(next, 'monthlyMedicalExpenseBase', base.monthlyMedicalExpenseBase, (v) =>
    extendMonthlySeries(v, extraSteps),
  );
  assignExtended(next, 'monthlyMedicalExpenseBucketsBase', base.monthlyMedicalExpenseBucketsBase, (v) =>
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
  // The injected arrays must grow with the horizon or the length check in monte-carlo-step-inputs.ts throws.
  assignExtended(next, 'injectedReturns', base.injectedReturns, (v) =>
    extendFloat64HoldLast(v, extraSteps),
  );
  assignExtended(next, 'injectedCpi', base.injectedCpi, (v) =>
    extendFloat64HoldLast(v, extraSteps),
  );
}

// Death years at or after the original horizon end move to the new horizon, so a
// member the padded income keeps paying is not taxed as dead in the appended
// years. Earlier or `undefined` death years are unchanged. It does not rebuild a
// survivor-benefit or filing-status schedule for the extension.
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
 * Extends a fully-assembled input to a longer horizon (the longevity stress),
 * padding every horizon-length series and reconciling the death markers. The
 * seed is untouched, so the first `base.horizonYear` months draw identical paths.
 * Returns `base` when `newHorizonYear <= horizonYear`.
 *
 * Disclosed approximation: padding stands in for a full re-assembly. It does not
 * rebuild the survivor-benefit or filing transition, and Social Security and other
 * income hold their last nominal dollar with no further COLA. Retaining the base
 * survivor and filing state is not directionally conservative, and the appended
 * fresh draws can help or hurt, so the disclosures claim no direction.
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

/** Composes the fee/return/inflation overlay with the age-105-capped horizon extension. */
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

/** Probability-of-success and shortfall deltas for one stress case against the base run. */
export interface StressDelta {
  readonly caseId: StressCaseId;
  readonly baseSuccessProbability: number;
  readonly stressSuccessProbability: number;
  readonly successProbabilityDelta: number;
  readonly baseMedianDepletionYear: number | null;
  readonly stressMedianDepletionYear: number | null;
  readonly baseMedianEndingBalanceReal: number;
  readonly stressMedianEndingBalanceReal: number;
  readonly medianEndingBalanceRealDelta: number;
}

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
