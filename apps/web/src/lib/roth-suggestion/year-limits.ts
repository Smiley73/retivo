/**
 * The three limits that cap a window year's MAGI, each on the federal MAGI line
 * the row reports as `magiCents`, recorded with the components they recompute from.
 */
import {
  computeSeniorBonusDeduction,
  computeStandardDeduction,
  nextBracketCeiling,
  type FilingStatus,
} from '../federal-tax';
import { resolveFederalTaxSnapshotForYear } from '../federal-tax-extrapolation';
import { fplDollarsForRegion, type AcaFplRegion } from '../aca-ptc';
import { selectIrmaaScheduleEntries } from '../irmaa-tiers';
import { computeSsTaxation } from '../ss-taxation';
import { ACA_FPL_CLIFF_MULTIPLE } from '../roth-betr-apply-helpers';
import {
  householdMarketplaceCoverageMonths,
  resolveSnapshotYear,
  type TaxCalibrationBundle,
} from '../tax-integration-helpers';
import type { LookbackFacts, YearFacts } from './year-facts';
import type {
  AcaLimit,
  BracketLimit,
  IrmaaGuardTier,
  IrmaaLimit,
  LimitKind,
  YearLimits,
} from './types';

const CENTS_PER_DOLLAR = 100;
const RATE_EPSILON = 1e-9;
/** Bisection stops once the bracket on MAGI is narrower than this many dollars. */
const BISECTION_DOLLARS = 1e-9;
const BISECTION_MAX_STEPS = 80;
/** IRMAA tiers from lowest to highest, as the engine's rows name them. */
const IRMAA_TIER_ORDER = ['none', 'tier1', 'tier2', 'tier3', 'tier4', 'tier5'] as const;

/** What the limits read from the scenario and the year, fixed for a search. */
export interface LimitEnvironment {
  readonly bundle: TaxCalibrationBundle;
  readonly inflationPct: number;
  readonly acaFplRegion: AcaFplRegion | undefined;
}

/** What a zero-conversion row says about a year (the guard baseline, not the
 *  scenario's current plan), `null` when the row is missing. */
export interface ReferenceTiers {
  readonly lookbackIrmaaTier: string | null;
  readonly acaPtcTier: string | null;
}

interface YearLimitInputs {
  readonly rate: number;
  readonly guarded: boolean;
  readonly facts: YearFacts;
  readonly lookback: LookbackFacts;
  readonly reference: ReferenceTiers;
  /** The year's gross Social Security, from the cashflow series. */
  readonly grossSsDollars: number;
  /** MAGI the Fill step does not see while sizing this year's conversion. */
  readonly engineOffsetDollars: number;
}

/** A bracket on post-deduction taxable income and the deductions that turn it
 *  into MAGI. Shared by the limit and by the check that a row stayed under it. */
export interface BracketGeometry {
  readonly rate: number;
  readonly filingStatus: FilingStatus;
  readonly topDollars: number;
  readonly standardDeductionDollars: number;
  readonly age65AddOnDollars: number;
  /** Senior bonus deduction at a given MAGI (it phases out with MAGI). */
  readonly seniorBonusAt: (magiDollars: number) => number;
}

export function bracketGeometry(
  rate: number,
  facts: YearFacts,
  env: LimitEnvironment,
): BracketGeometry {
  const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(
    env.bundle.federalTax,
    facts.year,
    env.inflationPct,
  );
  const config = snapshot.values[lookupYear];
  const status = facts.filingStatus;
  const bracket = config.brackets[status].find((b) => Math.abs(b.rate - rate) < RATE_EPSILON);
  if (bracket === undefined) {
    throw new Error(`No ${rate} ordinary bracket for ${status} in ${facts.year}`);
  }
  const topCents = nextBracketCeiling(
    Math.round(bracket.floor * CENTS_PER_DOLLAR),
    lookupYear,
    status,
    snapshot,
  );
  if (!Number.isFinite(topCents)) {
    throw new Error(`The ${rate} bracket for ${status} in ${facts.year} has no upper bound`);
  }
  const standard = config.standardDeduction[status];
  return {
    rate,
    filingStatus: status,
    topDollars: topCents / CENTS_PER_DOLLAR,
    standardDeductionDollars: standard,
    age65AddOnDollars: computeStandardDeduction(status, facts.age65Count, config) - standard,
    seniorBonusAt: (magi) =>
      computeSeniorBonusDeduction(lookupYear, status, facts.age65Count, magi, config),
  };
}

/** Upper bound on the post-deduction ordinary income a MAGI leaves: capital
 *  gains and qualified dividends are not on the row, so it is conservative. */
export function taxableOrdinaryBoundDollars(g: BracketGeometry, magiDollars: number): number {
  return (
    magiDollars - g.standardDeductionDollars - g.age65AddOnDollars - g.seniorBonusAt(magiDollars)
  );
}

/** Largest whole-dollar MAGI whose taxable ordinary income stays at the bracket
 *  top: solves `C = top + deductions + bonus(C)` by bisection from below, since
 *  the senior bonus falls as MAGI rises. */
function bracketLimit(g: BracketGeometry): BracketLimit {
  const base = g.topDollars + g.standardDeductionDollars + g.age65AddOnDollars;
  let lo = base;
  let hi = base + g.seniorBonusAt(base);
  for (let step = 0; step < BISECTION_MAX_STEPS && hi - lo > BISECTION_DOLLARS; step += 1) {
    const mid = lo + (hi - lo) / 2;
    if (base + g.seniorBonusAt(mid) - mid >= 0) lo = mid;
    else hi = mid;
  }
  const seniorBonusDollars = g.seniorBonusAt(lo);
  return {
    kind: 'bracket',
    valueDollars: Math.floor(base + seniorBonusDollars),
    bracketRate: g.rate,
    filingStatus: g.filingStatus,
    bracketTopDollars: g.topDollars,
    standardDeductionDollars: g.standardDeductionDollars,
    age65AddOnDollars: g.age65AddOnDollars,
    seniorBonusDollars,
  };
}

/** Position of an IRMAA tier in the engine's order, -1 for a name it does not use. */
export function irmaaTierRank(tier: string): number {
  return IRMAA_TIER_ORDER.indexOf(tier as (typeof IRMAA_TIER_ORDER)[number]);
}

/** The IRMAA line of year Y+2 just above the reference's tier, rounded down
 *  (the engine compares deflated MAGI with the unscaled table), on the
 *  schedule of year Y's filing status, the return Medicare reads. */
function irmaaLimit(
  inputs: YearLimitInputs,
  env: LimitEnvironment,
): IrmaaLimit {
  const { facts, lookback, reference } = inputs;
  if (!inputs.guarded) return { kind: 'irmaa', applies: false, reason: 'unguarded' };
  if (!lookback.withinHorizon || reference.lookbackIrmaaTier === null) {
    return { kind: 'irmaa', applies: false, reason: 'beyond-horizon' };
  }
  if (lookback.medicareBeneficiaries === 0) return { kind: 'irmaa', applies: false, reason: 'no-medicare' };
  const referenceRank = irmaaTierRank(reference.lookbackIrmaaTier);
  if (referenceRank < 0 || referenceRank >= IRMAA_TIER_ORDER.length - 1) {
    return { kind: 'irmaa', applies: false, reason: 'reference-over-line' };
  }
  const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
    env.bundle.irmaa,
    lookback.year,
    env.inflationPct,
  );
  const entries = selectIrmaaScheduleEntries(
    env.bundle.irmaa.values[effectiveYear],
    facts.filingStatus,
  );
  const thresholdDollars = entries[referenceRank].thresholdDollars;
  return {
    kind: 'irmaa',
    applies: true,
    valueDollars: Math.floor(thresholdDollars * thresholdScalingFactor),
    lookbackYear: lookback.year,
    filingStatus: facts.filingStatus,
    referenceTier: IRMAA_TIER_ORDER[referenceRank] as IrmaaGuardTier,
    thresholdDollars,
    scalingFactor: thresholdScalingFactor,
  };
}

/** The 400 % FPL line moved onto the federal MAGI line: the ACA MAGI adds back
 *  nontaxable Social Security, so the federal line is `line - (gross SS -
 *  taxable SS)`, with the taxable part evaluated by §86 at the line itself. */
function acaLimit(inputs: YearLimitInputs, env: LimitEnvironment): AcaLimit {
  const { facts, reference, grossSsDollars } = inputs;
  if (!inputs.guarded) return { kind: 'aca', applies: false, reason: 'unguarded' };
  const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
    env.bundle.acaPtc,
    facts.year,
    env.inflationPct,
  );
  const table = env.bundle.acaPtc.values[effectiveYear];
  if (table.regime !== 'pre-arpa') return { kind: 'aca', applies: false, reason: 'not-pre-arpa' };
  if (householdMarketplaceCoverageMonths(facts.members) === 0) {
    return { kind: 'aca', applies: false, reason: 'no-marketplace' };
  }
  if (reference.acaPtcTier === null || reference.acaPtcTier === 'above-400-cliff') {
    return { kind: 'aca', applies: false, reason: 'reference-over-line' };
  }
  const fplDollars = fplDollarsForRegion(
    table.fpl,
    facts.householdSize,
    env.acaFplRegion ?? 'contiguous',
  );
  const line = ACA_FPL_CLIFF_MULTIPLE * fplDollars * thresholdScalingFactor;
  const taxableSsDollars = taxableSsAtAcaLine(inputs, line, env);
  const nontaxableSsDollars = Math.max(0, grossSsDollars - taxableSsDollars);
  return {
    kind: 'aca',
    applies: true,
    valueDollars: Math.max(0, Math.floor(line - nontaxableSsDollars)),
    multiple: ACA_FPL_CLIFF_MULTIPLE,
    fplDollars,
    householdSize: facts.householdSize,
    scalingFactor: thresholdScalingFactor,
    grossSsDollars,
    taxableSsDollars,
    nontaxableSsDollars,
  };
}

/** Taxable Social Security when the other income sits exactly at the ACA line
 *  (the line less the gross benefit; tax-exempt interest is part of it). */
function taxableSsAtAcaLine(
  inputs: YearLimitInputs,
  acaLineDollars: number,
  env: LimitEnvironment,
): number {
  if (inputs.grossSsDollars <= 0) return 0;
  const otherIncomeDollars = Math.max(0, acaLineDollars - inputs.grossSsDollars);
  const { taxableSsCents } = computeSsTaxation(
    {
      grossSsCents: Math.round(inputs.grossSsDollars * CENTS_PER_DOLLAR),
      otherAgiCents: Math.round(otherIncomeDollars * CENTS_PER_DOLLAR),
      taxExemptInterestCents: 0,
      filingStatus: inputs.facts.filingStatus,
      taxYear: inputs.facts.year,
    },
    env.bundle.ssTax,
  );
  return taxableSsCents / CENTS_PER_DOLLAR;
}

/** The smallest applicable limit. A tie is labelled bracket, then IRMAA, then
 *  ACA, because only a strictly smaller limit displaces an earlier one. */
export function pickBindingLimit(
  bracket: BracketLimit,
  irmaa: IrmaaLimit,
  aca: AcaLimit,
): { limitDollars: number; binding: LimitKind } {
  let limitDollars = bracket.valueDollars;
  let binding: LimitKind = 'bracket';
  if (irmaa.applies && irmaa.valueDollars < limitDollars) {
    limitDollars = irmaa.valueDollars;
    binding = 'irmaa';
  }
  if (aca.applies && aca.valueDollars < limitDollars) {
    limitDollars = aca.valueDollars;
    binding = 'aca';
  }
  return { limitDollars: Math.max(0, limitDollars), binding };
}

export function deriveYearLimits(inputs: YearLimitInputs, env: LimitEnvironment): YearLimits {
  const bracket = bracketLimit(bracketGeometry(inputs.rate, inputs.facts, env));
  const irmaa = irmaaLimit(inputs, env);
  const aca = acaLimit(inputs, env);
  const { limitDollars, binding } = pickBindingLimit(bracket, irmaa, aca);
  const engineOffsetDollars = Math.max(0, inputs.engineOffsetDollars);
  return {
    year: inputs.facts.year,
    bracket,
    irmaa,
    aca,
    limitDollars,
    binding,
    engineOffsetDollars,
    ceilingDollars: Math.max(0, Math.floor(limitDollars - engineOffsetDollars)),
  };
}
