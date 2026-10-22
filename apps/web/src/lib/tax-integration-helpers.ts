/** Shared types, calibration bundle and pure helpers for the tax-integration layer, split out of tax-integration.ts. */

import type { CalibrationSnapshot } from './calibration';
import type { AccountPayload, AccountType } from '../db/types';
import type { FilingStatus } from './federal-tax';
import type { TaxConfig } from './federal-tax';
import type { SsTaxThresholds } from './ss-taxation';
import type { IrmaaTable } from './irmaa';
import type { AcaPtcTable, AcaFplRegion, AcaMemberCoverage } from './aca-ptc';
import { roughHouseholdAnnualBenchmarkCents } from './aca-ptc';
import type { IrmaaBeneficiaryEnrollment } from './irmaa';
import type {
  RmdTable,
  RmdAccountProfileFacts,
  RmdWithheldAccount,
  RmdFirstYearDeferralDetail,
} from './rmd';
import type { AssumedTaxableYieldConfig } from './assumed-taxable-yield-config';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { isValidRmdIsoDate } from '../db/rmd-fact-validation';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

/** The six calibration snapshots pinned once per projection run; pass `DEFAULT_TAX_CALIBRATION_BUNDLE` unless a caller needs a custom seed (test isolation). */
export interface TaxCalibrationBundle {
  readonly federalTax: CalibrationSnapshot<TaxConfig>;
  readonly ssTax: CalibrationSnapshot<SsTaxThresholds>;
  readonly irmaa: CalibrationSnapshot<IrmaaTable>;
  readonly acaPtc: CalibrationSnapshot<AcaPtcTable>;
  readonly rmd: CalibrationSnapshot<RmdTable>;
  /** Assumed annual taxable-account yield driving the per-year tax drag on brokerage-like balances (QDI plus ordinary interest) and reinvested-yield basis growth; calibration only, no per-scenario override. */
  readonly assumedTaxableYield: CalibrationSnapshot<AssumedTaxableYieldConfig>;
}

/** Default calibration bundle from the standard seed constants. */
export const DEFAULT_TAX_CALIBRATION_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

/** Thrown when required input fields fail the integration-layer guard. */
export class TaxIntegrationInvalidInputError extends Error {
  readonly code = 'TAX_INTEGRATION_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Tax integration invalid input: ${reason}`);
    this.name = 'TaxIntegrationInvalidInputError';
  }
}

/** Maps a thrown error to user-facing copy for a recognised configuration conflict, or `null` (none is recognised today). */
export function friendlyProjectionErrorMessage(e?: unknown): string | null {
  void e;
  return null;
}

/** Convert whole dollars to integer cents (round half-up). */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Convert integer cents to whole dollars. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}

/**
 * Splits `totalCents` across `weights` so the parts sum exactly to `totalCents` (largest-remainder allocation). Rounding
 * parts independently breaks conservation, and one cent can move the IRMAA look-back MAGI onto the next surcharge tier.
 * Parts are floored first, then leftover cents go to the largest fractional remainders, ties by position; all-zero or
 * negative-sum weights split equally.
 */
export function allocateCentsByWeight(
  totalCents: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const useEqualSplit = !(weightSum > 0);
  const exact = weights.map((w) =>
    useEqualSplit ? totalCents / weights.length : (w / weightSum) * totalCents,
  );
  const parts = exact.map((v) => Math.floor(v));
  let leftover = totalCents - parts.reduce((sum, v) => sum + v, 0);
  // `leftover` is a whole number of cents in [0, weights.length) for an integer total, so this loop runs at most once per part.
  const order = exact
    .map((v, index) => ({ index, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (leftover <= 0) break;
    parts[index] += 1;
    leftover -= 1;
  }
  return parts;
}

export interface SnapshotYearResolution {
  readonly effectiveYear: number;
  readonly taxYearExtrapolated: boolean;
  /** Inflation multiplier `(1 + inflationRatePct/100)^(taxYear - effectiveYear)` for dollar thresholds when extrapolating, else 1.0; callers deflate MAGI inputs by it, equivalent to inflating the stored thresholds. */
  readonly thresholdScalingFactor: number;
}

const SNAPSHOT_KEYS = new WeakMap<CalibrationSnapshot<unknown>, number[]>();
// Per-snapshot memo of `resolveSnapshotYear`, keyed by `${taxYear}|${inflationRatePct}` (distinguishing undefined from 0) and FIFO-bounded to 128 entries.
const SNAPSHOT_RESOLUTION_MEMO = new WeakMap<
  CalibrationSnapshot<unknown>,
  Map<string, SnapshotYearResolution>
>();
const SNAPSHOT_RESOLUTION_MEMO_MAX_ENTRIES = 128;

/**
 * Resolves the effective snapshot year, clamping to the latest key when `taxYear` is past all stored years. IRMAA and
 * ACA-PTC look up strict years, so this layer clamps first and never lets UnsupportedTaxYearError escape; a year below the
 * minimum key still throws from the engine. When extrapolating with `inflationRatePct`, returns a `thresholdScalingFactor`
 * for deflating MAGI against the clamped (older) thresholds. Memoized per (snapshot, taxYear, inflationRatePct); an empty
 * snapshot throws on every call.
 */
export function resolveSnapshotYear(
  snapshot: CalibrationSnapshot<unknown>,
  taxYear: number,
  inflationRatePct?: number,
): SnapshotYearResolution {
  let keys = SNAPSHOT_KEYS.get(snapshot);
  if (keys === undefined) {
    keys = Object.keys(snapshot.values).map(Number).sort((a, b) => a - b);
    SNAPSHOT_KEYS.set(snapshot, keys);
  }
  if (keys.length === 0) {
    throw new TaxIntegrationInvalidInputError('Snapshot has no entries');
  }

  let memo = SNAPSHOT_RESOLUTION_MEMO.get(snapshot);
  if (memo === undefined) {
    memo = new Map();
    SNAPSHOT_RESOLUTION_MEMO.set(snapshot, memo);
  }
  const cacheKey = `${taxYear}|${inflationRatePct}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return cached;

  const latest = keys[keys.length - 1];
  let result: SnapshotYearResolution;
  if (taxYear > latest) {
    const yearsDelta = taxYear - latest;
    const scalingFactor =
      inflationRatePct !== undefined && inflationRatePct > 0
        ? Math.pow(1 + inflationRatePct / 100, yearsDelta)
        : 1;
    result = { effectiveYear: latest, taxYearExtrapolated: true, thresholdScalingFactor: scalingFactor };
  } else {
    let resolved = keys[0];
    for (const k of keys) {
      if (k <= taxYear) resolved = k;
    }
    result = { effectiveYear: resolved, taxYearExtrapolated: false, thresholdScalingFactor: 1 };
  }
  Object.freeze(result);
  if (memo.size >= SNAPSHOT_RESOLUTION_MEMO_MAX_ENTRIES) {
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(cacheKey, result);
  return result;
}

/** Assumed-taxable-yield config for `taxYear`, clamped to the latest stored year (the assumption is population-level, not inflation-scaled); throws on an empty snapshot. */
export function resolveAssumedTaxableYieldConfig(
  snapshot: CalibrationSnapshot<AssumedTaxableYieldConfig>,
  taxYear: number,
): AssumedTaxableYieldConfig {
  const { effectiveYear } = resolveSnapshotYear(snapshot, taxYear);
  return snapshot.values[effectiveYear];
}

/** Clamped three-way tax-character split of the assumed brokerage yield. */
export interface AssumedYieldComponents {
  readonly qdiFraction: number;
  /** Tax-exempt municipal share; explicit calibration only, never inferred from a bond allocation. */
  readonly taxExemptFraction: number;
  readonly ordinaryFraction: number;
}

// Module-scope so the per-path × per-year MC hot loop does not allocate a closure; not shared with the private copy in
// `balance-projection-runner-tax-helpers.ts`, which would create an import cycle.
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Resolves the assumed yield's tax-character components, each in [0, 1] and summing to at most 1 (the tax-exempt share
 * yields to the QDI share, the ordinary remainder absorbs the rest). One resolver so both engines classify a yield identically.
 */
export function resolveAssumedYieldComponents(
  config: AssumedTaxableYieldConfig,
): AssumedYieldComponents {
  const qdiFraction = clamp01(config.qualifiedDividendFraction);
  const taxExemptFraction = Math.min(
    clamp01(config.taxExemptMunicipalFraction ?? 0),
    1 - qdiFraction,
  );
  const ordinaryFraction = Math.max(0, 1 - qdiFraction - taxExemptFraction);
  return { qdiFraction, taxExemptFraction, ordinaryFraction };
}

export {
  buildScaledFederalTaxConfig,
  resolveFederalTaxSnapshotForYear,
} from './federal-tax-extrapolation';

/**
 * True for `RETIREMENT_ROTH_IRA` only. Designated-Roth employer plans follow their own pro rata rules
 * (`isPureRothEmployerType` / `isRothDesignatedPostBucket`, balance-calc.ts). Type-based, not treatment-based, because it
 * backs the pre-59½ penalty-basis builder (`buildPenaltyAccountsForYear`), which keys off the concrete account class.
 */
export function isRothAccount(account: Pick<AccountPayload, 'type'>): boolean {
  return account.type === 'RETIREMENT_ROTH_IRA';
}

export interface MagiInput {
  readonly ordinaryIncomeDollars: number;
  readonly ltcgDollars: number;
  /** Tax-exempt interest dollars (muni-bond interest, a §36B MAGI add-back). */
  readonly taxExemptInterestDollars: number;
}

/** Household MAGI per §36B (the ACA / IRMAA definition): ordinary income + LTCG/QDI + tax-exempt interest, with taxable SS already in ordinary income. Returns dollars. */
export function computeMagi(input: MagiInput): number {
  return input.ordinaryIncomeDollars + input.ltcgDollars + input.taxExemptInterestDollars;
}

/** Per-member info needed by the tax-integration layer each year. */
export interface TaxMemberInput {
  readonly memberId: string;
  readonly isoBirthdate: string;
  readonly onMedicare: boolean;
  readonly hasAcaCoverage: boolean;
  /** Month-aware health-coverage facts for the IRMAA / ACA engines, populated from `ScenarioOverrides.healthCoverageMonths` (opt-out precedence applied), whole months 0..12. Absent, the whole-year boolean governs (12 if true, 0 if false). Part B and Part D are independent; see `resolveCoverageMonths`. */
  readonly partBEnrollmentMonths?: number;
  readonly partDEnrollmentMonths?: number;
  readonly marketplaceCoverageMonths?: number;
  /** Calendar year this member separated from service, for the §401(a)(9)(C) "later of statutory age or retirement" first-distribution year when the still-working exception applied; absent withholds that resolution. */
  readonly retirementYear?: number;
}

/** Per-account balance snapshot for a single year (for RMD engine). */
export interface TaxAccountSnapshot {
  readonly id: string;
  readonly type: AccountType;
  readonly taxTreatment: AccountPayload['taxTreatment'];
  readonly ownerId: string;
  readonly balancePriorYearDollars: number;
  /**
   * Roth-designated (post) sub-bucket of `balancePriorYearDollars`, netted out of the RMD base via `rothPortionCents`
   * (SECURE 2.0 §325). Meaningful on any account with a Roth-designated pocket (`hasRothDesignatedPocket`): MIXED plans, or a
   * pure Roth account (POST_TAX / ROTH) whose whole balance is that pocket. Ignored for PRE_TAX / HSA. Absent on MIXED
   * treats the whole balance as pre-tax (conservative); absent on pure Roth still nets the whole balance out.
   */
  readonly postBalancePriorYearDollars?: number;
  readonly withdrawalDollars: number;
  /** Stored RMD profile facts normalized by `buildRmdProfileFacts`. Absent on every snapshot in a year, the RMD engine runs its legacy owner/Uniform-Lifetime path; present on any, per-account rule resolution applies. */
  readonly rmdFacts?: RmdAccountProfileFacts;
  /** Dec 31 balance two years before the tax year in whole dollars, sizing the first-year-deferral catch-up; absent reports a blocker rather than guessing. */
  readonly balanceTwoYearsPriorDollars?: number;
  /** Roth-designated sub-bucket of `balanceTwoYearsPriorDollars`, netted out of the catch-up base by `rmdTwoYearsPriorBaseCents` (SECURE 2.0 §325). */
  readonly postBalanceTwoYearsPriorDollars?: number;
}

/** Per-account current-year withdrawal data for the early-withdrawal / HSA additional tax; a different account set from the prior-year RMD snapshot (HSAs included, Roth excluded). */
export interface PenaltyAccountSnapshot {
  readonly id: string;
  readonly type: AccountType;
  readonly ownerId: string;
  /** Includible-in-gross-income (pre-tax) part of the current-year withdrawal in whole dollars, the 10% penalty basis: the whole withdrawal for PRE_TAX, the pre-tax tranche for MIXED; 0 for HSA (see `hsaWithdrawalDollars`). */
  readonly penaltyPreTaxWithdrawalDollars: number;
  /** True when `penaltyPreTaxWithdrawalDollars` is a §408A/§402A additional-tax base the fact-based Roth ordering engine already resolved (governmental-457(b) carve-out applied); forwarded to `PenaltyAccountInput.rothOrderedAdditionalTaxBase` so the type test is skipped. Absent means normal type-driven eligibility. */
  readonly rothOrderedAdditionalTaxBase?: boolean;
  /** True for a distribution from an inherited account (on account of the original owner's death); forwarded to `PenaltyAccountInput.inheritedFromDeceasedOwner`, waiving the 10% §72(t) leg per §72(t)(2)(A)(ii) at any beneficiary age. */
  readonly inheritedFromDeceasedOwner?: boolean;
  /** Current-year HSA withdrawal in whole dollars; the nonqualified fraction is ordinary income plus the 20% additional tax before 65. */
  readonly hsaWithdrawalDollars: number;
  /** Part of `hsaWithdrawalDollars` funded against modeled medical demand: 100% qualified, excluded from both the ordinary-income fold-in and the 20% penalty basis. The emergency portion governed by `hsaQualifiedMedicalExpensePct` is the residual `max(0, hsaWithdrawalDollars − hsaMedicalQualifiedDollars)`. Absent means 0. */
  readonly hsaMedicalQualifiedDollars?: number;
  /** Committed HSA withdrawal in integer cents; when present the emergency residual is derived in cents so the medical and emergency slices reconcile exactly with no penny drift. Absent falls back to the dollar fields. */
  readonly hsaWithdrawalCents?: number;
  /** Integer-cent counterpart of `hsaMedicalQualifiedDollars`, paired with `hsaWithdrawalCents`. */
  readonly hsaMedicalQualifiedCents?: number;
}

/** All inputs the tax-integration layer needs for one projection year. */
export interface TaxYearInput {
  readonly taxYear: number;
  readonly filingStatus: FilingStatus;
  readonly grossSsDollars: number;
  /** Non-SS household income is split by source so MAGI and taxable income compose correctly. */
  readonly preTaxWithdrawalDollars: number;
  readonly postTaxNonRothWithdrawalDollars: number;
  /** POST_TAX withdrawals from cash-like accounts (SAVINGS, MONEY_MARKET, CD, HSA): return of already-taxed principal, excluded from the LTCG proxy and MAGI. The interest those balances earn is taxed annually via `cashInterestDollars`. Absent means 0. */
  readonly postTaxCashLikeWithdrawalDollars?: number;
  /**
   * Annual ordinary taxable interest earned by cash-like POST_TAX balances (SAVINGS / MONEY_MARKET / CD, never HSA), in whole
   * dollars, from each account's realized growth (`max(0, endBalance + withdrawn − deposits − startBalance)`) so a high-yield
   * CD is taxed on its own rate. Folded into ordinary income, §86 provisional income, both MAGIs and the §1411 NIIT base;
   * assumed reinvested, and excluded from the effective-rate gross-income denominator. Absent means 0.
   */
  readonly cashInterestDollars?: number;
  readonly rothWithdrawalDollars: number;
  /**
   * Qualified Charitable Distribution amount excluded from ordinary income and MAGI, in whole dollars. Subtracted from pre-tax
   * IRA-withdrawal income before `computeSsTaxation` and from the shared AGI base feeding both the federal/IRMAA and ACA-PTC
   * MAGI; the QCD-reduced MAGI enters the IRMAA Y+2 look-back ring. Clamped at the pre-tax withdrawal total. Only the Monte
   * Carlo per-path tax site sets it; the deterministic engine excludes the gift structurally (debited from the source IRA's
   * pre-tax bucket, never drawn as a taxable withdrawal), so setting both would double-exclude.
   */
  readonly qcdIncomeExclusionDollars?: number;
  readonly otherOrdinaryIncomeDollars: number;
  /** Tax-exempt interest (muni bonds) — added back to MAGI per §36B. */
  readonly taxExemptInterestDollars: number;
  /** LTCG/QDI fraction (0..1) of POST_TAX non-Roth withdrawals; defaults to 0.5. */
  readonly assumedCostBasisFraction?: number;
  /**
   * Brokerage-like (POST_TAX BROKERAGE / OTHER) balance at the start of the tax year, in whole dollars. `applyTaxYear`
   * multiplies it by the year's `assumedTaxableYield` and splits the yield into three components: qualified dividends (into
   * `ltcgAndQdi`, preferential rates; both MAGIs and the NIIT base), ordinary interest (ordinary brackets; both MAGIs and the
   * NIIT base, §1411(c)), and tax-exempt municipal (no federal taxable income and not NII, but added to
   * `taxExemptInterestDollars` as the §86 and §36B/IRMAA add-back; seeded 0, explicit calibration only). Excludes cash-like,
   * pre-tax and Roth balances. Absent or 0 means no yield drag.
   */
  readonly brokerageLikeStartBalanceDollars?: number;
  readonly householdSize: number;
  readonly members: readonly TaxMemberInput[];
  readonly accounts: readonly TaxAccountSnapshot[];
  /** MAGI from two years prior for the IRMAA look-back; undefined skips IRMAA this year. */
  readonly magiTwoYearsPriorDollars?: number;
  /** ACA benchmark SLCSP override in whole dollars; absent uses the age-based formula. */
  readonly acaBenchmarkSlcspDollars?: number;
  /** Household's ACA FPL region, from `ScenarioOverrides.acaFplRegion`; absent means 'contiguous'. */
  readonly acaFplRegion?: AcaFplRegion;
  readonly taxpayersAge65Plus: number;
  /** Annual inflation percent scaling dollar IRMAA/ACA thresholds when taxYear exceeds the latest snapshot key; absent or 0 means no scaling. */
  readonly inflationRatePct?: number;
  /** Scenario medical inflation percent growing the rough ACA benchmark from its base year; absent means no growth. */
  readonly medicalInflationRatePct?: number;
  /** Percent (0–100) of emergency HSA withdrawals assumed to be qualified medical expenses (tax-free); modeled medical-qualified withdrawals are always 100% qualified. The rest is ordinary income and carries the 20% HSA additional tax before 65. Absent means 100. Scenario-level. */
  readonly hsaQualifiedMedicalExpensePct?: number;
  /** Account ids exempt from the early-withdrawal additional tax (10% before 59½; HSA 20% before 65); absent means none. */
  readonly earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  /** Current-year withdrawal data for the early-withdrawal / HSA additional tax; absent means no penalty. */
  readonly penaltyAccounts?: readonly PenaltyAccountSnapshot[];
}

/** Tax-integration result for one projection year. */
export interface TaxYearResult {
  readonly federalTaxCents: number;
  readonly taxableSsCents: number;
  readonly ssTaxationTier: 'none' | 'fifty' | 'eighty-five';
  readonly rmdFloorCents: number;
  /** True when at least one household owner reached the RMD trigger age this tax year; distinguishes an applicable year (per-account map present, possibly `{}` at a $0 floor) from a pre-trigger year (map absent). */
  readonly rmdApplicable: boolean;
  readonly rmdPerAccountCents: Record<string, number>;
  /** Accounts whose RMD could not be computed (a missing required fact or an unsupported fact combination): excluded from `rmdFloorCents` (withheld, never guessed) and surfaced as blockers with the exact missing inputs. Absent when no account carries RMD facts. */
  readonly rmdWithheldAccounts?: readonly RmdWithheldAccount[];
  /** Accounts deferred this year by the §401(a)(9)(C) still-working exception (a legitimate $0, not a blocker). */
  readonly rmdStillWorkingDeferredAccountIds?: readonly string[];
  /** Accounts whose first RMD is deferred to April 1 of the next year, with the deferred cents and due year; that following year carries two RMDs, hence the disclosure. */
  readonly rmdFirstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  /** Deferred-from-the-prior-year RMD cents folded into `rmdFloorCents` this year (two RMDs in one year). */
  readonly rmdDeferredCatchUpCents?: number;
  readonly irmaaSurchargeCents: number;
  readonly irmaaTier: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  readonly acaPtcSubsidyCents: number;
  readonly acaPtcTier: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  readonly fplPercentage: number;
  /** Cents of ACA MAGI above 100% of the poverty line where the credit ends: the smallest figure among returns that earn a credit, 0 when none does (projection-year dollars). */
  readonly acaMagiAboveFplCents: number;
  readonly magiCents: number;
  readonly effectiveTaxRate: number;
  readonly taxYearExtrapolated: boolean;
  /** IRA/401k-style early-distribution 10% additional tax (IRC §72(t)) in integer cents, already included in `federalTaxCents`; surfaced separately for display. */
  readonly earlyWithdrawalPenaltyCents: number;
  /** HSA 20% additional tax on nonqualified pre-65 withdrawals (IRC §223(f)(4)) in integer cents, already included in `federalTaxCents`; surfaced separately for display. */
  readonly hsaAdditionalTaxCents: number;
  /** True when a penalizable account's owner birthdate was missing or unparseable, so its penalty was skipped; the caller surfaces it in the estimate note. */
  readonly penaltySkippedForMissingBirthdate: boolean;
  /** This year's MAGI and filing status per tax unit (one entry per return filed), set by `applyTaxYearForFilingPlan`. The runners buffer these into the IRMAA two-year look-back ring so each return is tiered on its own look-back MAGI and schedule; one household MAGI plus the first unit's status would mis-tier a mixed MFS+HoH couple. */
  readonly filingUnitMagi?: readonly FilingUnitMagi[];
  /** The year's IRMAA surcharge per return, for a multi-return (separate-filing) year only; the household total is `irmaaSurchargeCents`. The cashflow solver withholds each beneficiary's surcharge from their own SS, and once two returns can land on different tiers an even re-split would attribute the wrong amount to each check. */
  readonly irmaaSurchargeCentsByUnit?: readonly UnitIrmaaSurcharge[];
  /**
   * The year's IRMAA surcharge per beneficiary, one entry per member with any enrolled Medicare month; absent when the year
   * ran no IRMAA calculation (no enrolled month, or unknown look-back MAGI), but a $0 `tier: 'none'` year still emits entries.
   * Month-aware IRMAA prorates Part B and D by each beneficiary's own months, so two beneficiaries on one return can owe
   * different amounts and an even re-division would withhold the wrong amount from each check. Entries sum to `irmaaSurchargeCents`.
   */
  readonly irmaaSurchargeCentsByMember?: readonly MemberIrmaaSurcharge[];
}

/** One return's IRMAA surcharge for a single year. */
export interface UnitIrmaaSurcharge {
  readonly memberIds: readonly string[];
  readonly surchargeCents: number;
}

/** One beneficiary's own IRMAA surcharge for a single year. */
export interface MemberIrmaaSurcharge {
  readonly memberId: string;
  readonly surchargeCents: number;
}

/** One tax unit's MAGI and filing facts for a year: an entry in the per-unit IRMAA look-back ring. */
export interface FilingUnitMagi {
  readonly memberIds: readonly string[];
  readonly filingStatus: FilingStatus;
  /** Whether this MFS return lived with the spouse (§86(c)(1)(C)(ii) / CMS). */
  readonly mfsLivedWithSpouse: boolean;
  readonly magiCents: number;
}

/** One return filed in a bootstrap look-back year, before the projection started: its status is resolvable from the stored plan but its MAGI is not. */
export interface BootstrapLookbackUnit {
  readonly memberIds: readonly string[];
  readonly filingStatus: FilingStatus;
  /** Whether this MFS return lived with the spouse (§86(c)(1)(C)(ii) / CMS). */
  readonly mfsLivedWithSpouse: boolean;
}

/**
 * Per-return IRMAA look-back ring for a bootstrap year. Projection years 0–1 tier IRMAA on returns filed before the
 * projection began, where only the household bootstrap MAGI scalar is known; collapsing to one status would tier a mixed
 * MFS+HoH couple on the first spouse's schedule, then switch once the ring filled. Each return keeps its own status and the
 * household MAGI splits evenly across them (exact to the cent, as `unitIrmaaLookback` splits the scalar). Returns `undefined`
 * when there is nothing per-unit to say: fewer than two returns, or an absent look-back MAGI (absent skips IRMAA but $0
 * tiers, so materializing $0 entries would change the reported tier).
 */
export function bootstrapLookbackRing(
  units: readonly BootstrapLookbackUnit[] | undefined,
  magiTwoYearsPriorDollars: number | undefined,
): readonly FilingUnitMagi[] | undefined {
  if (units === undefined || units.length < 2) return undefined;
  if (magiTwoYearsPriorDollars === undefined) return undefined;
  const shares = allocateCentsByWeight(
    dollarsToCents(magiTwoYearsPriorDollars),
    units.map(() => 1),
  );
  return units.map((unit, index) => ({
    memberIds: unit.memberIds,
    filingStatus: unit.filingStatus,
    mfsLivedWithSpouse: unit.mfsLivedWithSpouse,
    magiCents: shares[index],
  }));
}

/**
 * Default household SLCSP benchmark in whole dollars when no override is given: the sum over covered members of each
 * member's age-priced monthly premium × their Marketplace coverage months (delegated to `roughHouseholdAnnualBenchmarkCents`,
 * so the disclosed assumptions and the priced figure cannot drift). 0 when no member has covered months.
 *
 * @throws {AcaPtcInvalidInputError} when a covered member's age is not a non-negative integer (a caller bug).
 */
export function defaultHouseholdSlcspByAge(
  members: readonly TaxMemberInput[],
  taxYear: number,
): number {
  return roughHouseholdAnnualBenchmarkCents(acaCoveredMembers(members, taxYear)) / 100;
}

/**
 * Converts a user-entered whole-year benchmark into the covered-member-month sum `AcaPtcInput.benchmarkAnnualSlcspCents`
 * contracts for. §36B(b)(2) sums the credit over coverage months only, and `computeAcaPtc` prorates the contribution by
 * `coverageMonths`, so the benchmark must use the same count or a part-year household is over-credited by
 * `(12 − months) × monthly benchmark`. The rough age-priced fallback already multiplies by covered months. The 12-month
 * branch returns the cents unchanged so a whole-year household stays byte-identical.
 */
export function overrideBenchmarkCentsForCoverageMonths(
  annualOverrideDollars: number,
  coverageMonths: number,
): number {
  const annualCents = dollarsToCents(annualOverrideDollars);
  if (coverageMonths >= 12) return annualCents;
  return Math.round((annualCents * Math.max(0, coverageMonths)) / 12);
}

// Covered-member records for the rough per-member benchmark; members with zero covered months are dropped, so no age parse for someone who never buys a plan.
function acaCoveredMembers(
  members: readonly TaxMemberInput[],
  taxYear: number,
): readonly AcaMemberCoverage[] {
  const covered: AcaMemberCoverage[] = [];
  for (const m of members) {
    const { marketplaceMonths } = resolveCoverageMonths(m);
    if (marketplaceMonths <= 0) continue;
    covered.push({ age: ageInYear(m.isoBirthdate, taxYear), marketplaceMonths });
  }
  return covered;
}

/** The household-level health facts `applyTaxYear` needs for one year. */
export interface HealthCoverageYearFacts {
  readonly anyMedicareMonths: boolean;
  readonly irmaaBeneficiaries: readonly IrmaaMemberEnrollment[];
  /** Household Marketplace coverage months (the §36B(b)(2) summation range). */
  readonly marketplaceCoverageMonths: number;
  readonly defaultBenchmarkAnnualDollars: number;
}

/**
 * Resolves and memoizes one year's household health facts. Each field is a pure function of `(members, taxYear)`, but
 * `applyTaxYear` runs once per Monte Carlo path per year while the year's survivor array is built once per run
 * (`buildSurvivorStatesByYear`), so keying the memo on that array's identity collapses N_paths recomputations into one;
 * `taxYear` is stored alongside so reuse across years recomputes. It hits only for a stable array, so the separate-filing
 * path memoizes its per-unit subset on the household array (`unitMembersFor` in `tax-integration.ts`). The WeakMap entry
 * dies with the array.
 */
export function healthCoverageYearFacts(
  members: readonly TaxMemberInput[],
  taxYear: number,
): HealthCoverageYearFacts {
  const cached = HEALTH_YEAR_FACTS_CACHE.get(members);
  if (cached !== undefined && cached.taxYear === taxYear) return cached.facts;
  const marketplaceCoverageMonths = householdMarketplaceCoverageMonths(members);
  const facts: HealthCoverageYearFacts = {
    anyMedicareMonths: anyMemberOnMedicare(members),
    irmaaBeneficiaries: irmaaBeneficiaryEnrollments(members),
    marketplaceCoverageMonths,
    // Priced only with covered months: the age curve throws for an off-curve age, and an uncovered household must not pay that cost or risk.
    defaultBenchmarkAnnualDollars:
      marketplaceCoverageMonths > 0 ? defaultHouseholdSlcspByAge(members, taxYear) : 0,
  };
  // Written only after a successful pricing pass, so a throwing year is never memoized as a silent zero.
  HEALTH_YEAR_FACTS_CACHE.set(members, { taxYear, facts });
  return facts;
}

const HEALTH_YEAR_FACTS_CACHE = new WeakMap<
  readonly TaxMemberInput[],
  { taxYear: number; facts: HealthCoverageYearFacts }
>();

/**
 * One member's resolved Part B / Part D / Marketplace months for the year. A month field is the authority when present;
 * when absent the whole-year boolean it replaces governs (true is 12, false is 0). Part B and Part D resolve independently,
 * and values are clamped to 0..12 and floored so a corrupt stored value cannot over-charge a surcharge.
 */
export interface ResolvedCoverageMonths {
  readonly partBMonths: number;
  readonly partDMonths: number;
  readonly marketplaceMonths: number;
}

function clampMonths(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(12, Math.max(0, Math.floor(value)));
}

function partBMonthsOf(m: TaxMemberInput): number {
  return clampMonths(m.partBEnrollmentMonths, m.onMedicare ? 12 : 0);
}

function partDMonthsOf(m: TaxMemberInput): number {
  return clampMonths(m.partDEnrollmentMonths, m.onMedicare ? 12 : 0);
}

// Marketplace months after the §36B(c)(2)(B) clamp: a Medicare month is never a PTC coverage month, so the stated count
// cannot exceed the months not enrolled in Part B or D (else more than 12 covered months would inflate the benchmark and
// credit, in the optimistic direction).
function marketplaceMonthsOf(m: TaxMemberInput): number {
  const stated = clampMonths(
    m.marketplaceCoverageMonths,
    m.hasAcaCoverage && !m.onMedicare ? 12 : 0,
  );
  const medicareMonths = Math.max(partBMonthsOf(m), partDMonthsOf(m));
  return Math.max(0, Math.min(stated, 12 - medicareMonths));
}

/**
 * Resolves one member's Part B / Part D / Marketplace months (see `ResolvedCoverageMonths`): the one resolver every
 * production pricing path shares (`acaCoveredMembers`, `irmaaBeneficiaryEnrollments`), so the two engines cannot resolve
 * different months for a member. The boolean gates below stay scalar to avoid per-member allocation in the Monte Carlo loop.
 */
export function resolveCoverageMonths(m: TaxMemberInput): ResolvedCoverageMonths {
  return {
    partBMonths: partBMonthsOf(m),
    partDMonths: partDMonthsOf(m),
    marketplaceMonths: marketplaceMonthsOf(m),
  };
}

/** True when any member has an enrolled Medicare month (the IRMAA engagement gate). */
export function anyMemberOnMedicare(members: readonly TaxMemberInput[]): boolean {
  return members.some((m) => partBMonthsOf(m) > 0 || partDMonthsOf(m) > 0);
}

/** True when any member has covered Marketplace months (the ACA-PTC engagement gate). */
export function anyMemberHasAcaCoverage(members: readonly TaxMemberInput[]): boolean {
  return members.some((m) => marketplaceMonthsOf(m) > 0);
}

/**
 * Household Marketplace coverage months, the range IRC §36B(b)(2) sums the monthly credit over. The model stores per-member
 * counts, not calendar masks, so this is the largest member count: exact for nested coverage periods (everyone's runs from
 * January to their own Medicare month), but two spouses covered in disjoint ranges are credited the larger count rather
 * than the sum, which would need a stored month mask.
 */
export function householdMarketplaceCoverageMonths(
  members: readonly TaxMemberInput[],
): number {
  let months = 0;
  for (const m of members) months = Math.max(months, marketplaceMonthsOf(m));
  return months;
}

/**
 * Per-beneficiary Part B / Part D months the month-aware IRMAA engine prorates by, one entry per member with an enrolled
 * month, capped at two (one household; `computeMonthAwareIrmaa` rejects more). Each carries its `memberId` so the cashflow
 * solver can withhold a beneficiary's own surcharge from their own SS.
 */
export function irmaaBeneficiaryEnrollments(
  members: readonly TaxMemberInput[],
): readonly IrmaaMemberEnrollment[] {
  const out: IrmaaMemberEnrollment[] = [];
  for (const m of members) {
    const { partBMonths, partDMonths } = resolveCoverageMonths(m);
    if (partBMonths === 0 && partDMonths === 0) continue;
    out.push({ memberId: m.memberId, partBMonths, partDMonths });
    if (out.length === 2) break;
  }
  return out;
}

/** One IRMAA beneficiary's enrollment months tagged with its member; a superset of `IrmaaBeneficiaryEnrollment`, accepted by `computeMonthAwareIrmaa`. */
export interface IrmaaMemberEnrollment extends IrmaaBeneficiaryEnrollment {
  readonly memberId: string;
}

/**
 * Months in `taxYear` a member is entitled to Medicare when the scenario states no count ("Automatic"). Entitlement begins
 * the month the member turns 65, or the preceding month when the birthday is the 1st (Medicare.gov, "When does Medicare
 * coverage start?"), so a January-1 birthday starts in December of the prior year (the IRS born-Jan-1 rule treats the
 * member as attaining 65 in that year too, Pub 590-B). A whole-year approximation would charge a full year of IRMAA to a
 * June birthday and none to an October one. An empty, malformed or impossible birthdate gives 0 (`isUsableBirthdate`).
 */
export function automaticMedicareMonthsInYear(
  isoBirthdate: string | null | undefined,
  taxYear: number,
): number {
  if (!isUsableBirthdate(isoBirthdate)) return 0;
  const birthYear = Number(isoBirthdate.slice(0, 4));
  const birthMonth = Number(isoBirthdate.slice(5, 7));
  const birthDay = Number(isoBirthdate.slice(8, 10));
  let startYear = birthYear + MEDICARE_ELIGIBILITY_AGE;
  let startMonth = birthMonth;
  if (birthDay === 1) {
    startMonth -= 1;
    if (startMonth === 0) {
      startMonth = 12;
      startYear -= 1;
    }
  }
  if (taxYear < startYear) return 0;
  if (taxYear > startYear) return 12;
  return 13 - startMonth;
}

/** Medicare entitlement age (§1811 / 42 U.S.C. §1395c). */
const MEDICARE_ELIGIBILITY_AGE = 65;

// A usable birthdate is a complete real YYYY-MM-DD date, via the repo's one strict ISO-date validator
// (`db/rmd-fact-validation.ts`): an imported member payload is not shape-validated, so an impossible date like `1961-99-99`
// would otherwise become month 1 / day 99 and charge 12 months of Medicare, with real IRMAA surcharges and a full-year
// Marketplace lock-out. An unusable birthdate gets no Medicare and no Marketplace months (the withhold direction).
function isUsableBirthdate(iso: string | null | undefined): iso is string {
  return isValidRmdIsoDate(iso);
}

/** One member's stored coverage-month facts for a year (`ScenarioOverrides.healthCoverageMonths`); the editor stores only the counts the user stated. */
export interface StoredMemberCoverageMonths {
  readonly partBMonths?: number;
  readonly partDMonths?: number;
  readonly marketplaceMonths?: number;
}

/** The sparse stored map both engines read (structurally `HealthCoverageMonthsOverride` in `db/types`, declared here so this helper carries no persistence dependency). */
export interface StoredHealthCoverageMonths {
  readonly perMember?: Record<string, Record<number, StoredMemberCoverageMonths>> | null;
}

export interface StoredCoverageMonthEntry {
  readonly memberId: string;
  readonly taxYear: number;
  readonly months: StoredMemberCoverageMonths;
}

// `computeAcaPtc` and `computeMonthAwareIrmaa` reject years outside [2000, 2100], so a stored year outside it can never price anything.
const MIN_STORED_TAX_YEAR = 2000;
const MAX_STORED_TAX_YEAR = 2100;

function isSupportedStoredTaxYear(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_STORED_TAX_YEAR &&
    value <= MAX_STORED_TAX_YEAR
  );
}

// Keys never used to index a plain-object dictionary built from user-controlled ids (CWE-1321): import validation rejects
// these as keys but permits them as aggregate-id values, so an imported member can carry the id `__proto__`.
const DANGEROUS_DICTIONARY_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True when an identifier must not be used as a dictionary key. */
export function isDangerousDictionaryKey(key: string): boolean {
  return DANGEROUS_DICTIONARY_KEYS.has(key);
}

export interface StoredAcaBenchmarkOverride {
  readonly taxYear: number;
  readonly annualSlcspDollars: number;
}

/**
 * The shared reader for `ScenarioOverrides.acaPtcBenchmark`. Import validation checks only the envelope, so a reader
 * trusting well-formed rows would throw on an imported object or leak a NaN year or negative price into copy and pricing.
 * One enumerator keeps the rules from drifting: a non-array or absent payload is no override, a non-object row is dropped,
 * the year must be an integer in the supported domain, the price a finite positive figure (a $0 benchmark would floor the
 * credit to $0; see `pruneBenchmarkRows`); survivors are sorted by tax year.
 */
export function storedAcaBenchmarkOverrides(
  stored: unknown,
): readonly StoredAcaBenchmarkOverride[] {
  if (!Array.isArray(stored)) return [];
  const rows: StoredAcaBenchmarkOverride[] = [];
  for (const row of stored) {
    if (typeof row !== 'object' || row === null) continue;
    const { taxYear, annualSlcspDollars } = row as {
      taxYear?: unknown;
      annualSlcspDollars?: unknown;
    };
    if (!isSupportedStoredTaxYear(taxYear)) continue;
    if (typeof annualSlcspDollars !== 'number') continue;
    if (!Number.isFinite(annualSlcspDollars) || annualSlcspDollars <= 0) continue;
    rows.push({ taxYear, annualSlcspDollars });
  }
  return rows.sort((a, b) => a.taxYear - b.taxYear);
}

/**
 * Reads one member/year entry from the stored coverage-month map. The map arrives from an imported scenario whose envelope
 * validation does not check override shapes, so every level is shape-checked and a non-object reads as nothing stated (the
 * whole-year boolean behaviour), never a TypeError. Every level is read through `Object.hasOwn` (CWE-1321): an imported
 * member may carry the id `__proto__`, and a plain lookup would resolve to `Object.prototype` and read its inherited
 * members as stated coverage.
 */
export function readStoredCoverageMonths(
  stored: StoredHealthCoverageMonths | null | undefined,
  memberId: string,
  taxYear: number,
): StoredMemberCoverageMonths | undefined {
  const perMember = stored?.perMember;
  if (typeof perMember !== 'object' || perMember === null) return undefined;
  if (!Object.hasOwn(perMember, memberId)) return undefined;
  const byYear = perMember[memberId];
  if (typeof byYear !== 'object' || byYear === null) return undefined;
  if (!Object.hasOwn(byYear, taxYear)) return undefined;
  const entry = byYear[taxYear];
  if (typeof entry !== 'object' || entry === null) return undefined;
  return entry;
}

/**
 * Enumerates every stated (member, year) entry, ordered by tax year then member id, for the UI and report surfaces that walk
 * the whole map; one shape-checked reader stops those walkers from throwing on an imported `{ perMember: { "m-1": null } }`.
 * A non-object at any level contributes nothing, and `Object.entries` walks own keys only. A year key outside the supported
 * domain is dropped: a NaN year compares equal to everything, would print "NaN", seed a Select with a value the picker
 * lacks, and be discarded by the next save anyway.
 */
export function storedCoverageMonthEntries(
  stored: StoredHealthCoverageMonths | null | undefined,
): readonly StoredCoverageMonthEntry[] {
  const perMember = stored?.perMember;
  if (typeof perMember !== 'object' || perMember === null) return [];
  const entries: StoredCoverageMonthEntry[] = [];
  for (const [memberId, byYear] of Object.entries(perMember)) {
    if (typeof byYear !== 'object' || byYear === null) continue;
    for (const [year, months] of Object.entries(byYear)) {
      if (typeof months !== 'object' || months === null) continue;
      const taxYear = Number(year);
      if (!isSupportedStoredTaxYear(taxYear)) continue;
      entries.push({ memberId, taxYear, months });
    }
  }
  return entries.sort((a, b) => a.taxYear - b.taxYear || a.memberId.localeCompare(b.memberId));
}

export interface MemberHealthCoverageFacts {
  /** ISO birthdate (`YYYY-MM-DD`); empty / unparseable → no age, no Marketplace. */
  readonly isoBirthdate: string;
  readonly taxYear: number;
  readonly retired: boolean;
  /** True when the scenario marked the member as having OTHER coverage. */
  readonly optedOut: boolean;
  readonly stored?: StoredMemberCoverageMonths;
}

/** One member's fully resolved coverage for a year, as a `TaxMemberInput` fragment both engines spread verbatim. */
export interface ResolvedMemberHealthCoverage {
  readonly onMedicare: boolean;
  readonly hasAcaCoverage: boolean;
  readonly partBEnrollmentMonths: number;
  readonly partDEnrollmentMonths: number;
  readonly marketplaceCoverageMonths: number;
}

/**
 * The shared health-coverage resolver both production engines call (`buildMemberInputs` and `buildYearMemberFlags`), so
 * they cannot drift on Medicare timing, Marketplace eligibility or the overlap rule. Order: (1) automatic Medicare months
 * from the birthday (the entitlement); (2) a stated Part B / Part D count wins for that part; (3) automatic Marketplace
 * months are the complement of the entitlement for a retired, age-known, non-opted-out member, and a stated count wins even
 * when opted out; (4) §36B(c)(2)(B): a Medicare month is never a PTC coverage month, so Marketplace is capped at
 * `12 − max(Part B, Part D, entitlement)`, the entitlement term because Part A eligibility is itself minimum essential
 * coverage. `ageKnown` gates Marketplace and the automatic Medicare entitlement: an empty, malformed or impossible birthdate
 * is dropped rather than priced off a garbage age (NaN throws `AcaPtcInvalidInputError`); only stated month counts survive,
 * since they need no birthday.
 */
export function resolveMemberHealthCoverage(
  facts: MemberHealthCoverageFacts,
): ResolvedMemberHealthCoverage {
  const { isoBirthdate, taxYear, retired, optedOut, stored } = facts;
  // The same completeness test the entitlement derivation applies: an impossible date is no age at all.
  const ageKnown = isUsableBirthdate(isoBirthdate);
  const entitlementMonths = automaticMedicareMonthsInYear(isoBirthdate, taxYear);
  const partBEnrollmentMonths = clampMonths(numericOrUndefined(stored?.partBMonths), entitlementMonths);
  const partDEnrollmentMonths = clampMonths(numericOrUndefined(stored?.partDMonths), entitlementMonths);
  const medicareMonths = Math.max(
    partBEnrollmentMonths,
    partDEnrollmentMonths,
    entitlementMonths,
  );
  const automaticMarketplaceMonths =
    retired && ageKnown && !optedOut ? 12 - entitlementMonths : 0;
  const statedMarketplaceMonths = ageKnown
    ? clampMonths(numericOrUndefined(stored?.marketplaceMonths), automaticMarketplaceMonths)
    : 0;
  const marketplaceCoverageMonths = Math.max(
    0,
    Math.min(statedMarketplaceMonths, 12 - medicareMonths),
  );
  return {
    onMedicare: medicareMonths > 0,
    hasAcaCoverage: marketplaceCoverageMonths > 0,
    partBEnrollmentMonths,
    partDEnrollmentMonths,
    marketplaceCoverageMonths,
  };
}

// Treats a non-numeric stored month value as absent (imported data is not shape-validated beyond the envelope).
function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function ageInYear(isoBirthdate: string, taxYear: number): number {
  const birthYear = parseInt(isoBirthdate.slice(0, 4), 10);
  return taxYear - birthYear;
}
