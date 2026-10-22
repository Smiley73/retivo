/**
 * Shared types, calibration bundle, and pure helpers for the tax-integration
 * layer. Extracted from tax-integration.ts to keep that file within the shape limit.
 *
 * Consumers should continue importing from `./tax-integration` — that module
 * re-exports everything declared here.
 */

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
// The repo's ONE strict ISO-calendar-date validator —
// pure validation logic, no persistence dependency.
import { isValidRmdIsoDate } from '../db/rmd-fact-validation';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

// ---------------------------------------------------------------------------
// Calibration bundle
// ---------------------------------------------------------------------------

/**
 * All six CalibrationSnapshots pinned once per projection run.
 * Pass DEFAULT_TAX_CALIBRATION_BUNDLE unless a caller needs a custom seed
 * (e.g. test isolation).
 */
export interface TaxCalibrationBundle {
  readonly federalTax: CalibrationSnapshot<TaxConfig>;
  readonly ssTax: CalibrationSnapshot<SsTaxThresholds>;
  readonly irmaa: CalibrationSnapshot<IrmaaTable>;
  readonly acaPtc: CalibrationSnapshot<AcaPtcTable>;
  readonly rmd: CalibrationSnapshot<RmdTable>;
  /**
   * Assumed annual taxable-account investment yield. Drives the per-year
   * tax drag on brokerage-like balances (QDI + ordinary interest) and the
   * reinvested-yield basis growth. Calibration-only, no per-scenario override.
   */
  readonly assumedTaxableYield: CalibrationSnapshot<AssumedTaxableYieldConfig>;
}

/**
 * Default calibration bundle assembled from the standard seed constants.
 * Pass this to `applyTaxYear` / `applyTaxIntegrationToDrawdownYears` unless
 * a caller needs a custom seed (e.g. test isolation with trimmed tables).
 */
export const DEFAULT_TAX_CALIBRATION_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when required input fields fail the integration-layer guard. */
export class TaxIntegrationInvalidInputError extends Error {
  readonly code = 'TAX_INTEGRATION_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Tax integration invalid input: ${reason}`);
    this.name = 'TaxIntegrationInvalidInputError';
  }
}

/**
 * Map a thrown error to user-facing copy when it's a recognised, explainable
 * configuration conflict; returns `null` for anything else so callers keep
 * their existing fallback / rethrow behaviour.
 *
 * The withdrawal-strategy ⨯ allocation-override conflict that this used to map
 * is GONE: asset allocation works with every withdrawal strategy, so there is
 * no longer a recognised configuration conflict to
 * translate. Kept as the shared seam in case a future conflict needs friendly
 * copy; today it returns `null` for everything and callers fall back to the raw
 * error message.
 */
export function friendlyProjectionErrorMessage(e?: unknown): string | null {
  void e;
  return null;
}

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

/** Convert whole dollars to integer cents (round half-up). */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Convert integer cents to whole dollars. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}

/**
 * Split `totalCents` across `weights` so the parts sum EXACTLY to `totalCents`
 * (largest-remainder / Hare-quota allocation).
 *
 * Rounding each part independently does NOT conserve the total: two equal parts
 * of an odd-cent total each round up, and the sum comes out one cent high. That
 * cent is invisible in a dollar display but not in the IRMAA look-back, where
 * the household MAGI is compared against a tier threshold — a single cent above
 * it moves the whole household onto the next surcharge tier.
 *
 * Each part is floored to a whole cent first (so the running total is never
 * over), then the leftover cents go to the parts with the largest fractional
 * remainders, ties broken by position. Deterministic, and a part whose exact
 * share is a whole number of cents (notably a zero-weight part) never receives a
 * leftover cent: the leftover count is strictly smaller than the number of parts
 * carrying a fractional remainder.
 *
 * All-zero (or negative-sum) weights fall back to an equal split of the same
 * shape, so a zero-MAGI year with entries still conserves exactly.
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
  // `leftover` is a whole number of cents in [0, weights.length) whenever
  // `totalCents` is an integer, so this loop runs at most once per part.
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

// ---------------------------------------------------------------------------
// Snapshot year resolution
// ---------------------------------------------------------------------------

export interface SnapshotYearResolution {
  /** The effective key used for the snapshot lookup (clamped to latest if needed). */
  readonly effectiveYear: number;
  /** True when taxYear > latest snapshot key (lookup was clamped). */
  readonly taxYearExtrapolated: boolean;
  /**
   * Inflation multiplier for dollar-denominated thresholds when taxYear exceeds
   * the latest snapshot key: `(1 + inflationRatePct/100)^(taxYear - effectiveYear)`.
   * Always 1.0 when not extrapolating or when inflationRatePct is not provided.
   * Callers should deflate MAGI inputs by this factor before engine comparison,
   * which is mathematically equivalent to inflating the stored thresholds.
   */
  readonly thresholdScalingFactor: number;
}

/** Sorted numeric keys per snapshot, computed once. */
const SNAPSHOT_KEYS = new WeakMap<CalibrationSnapshot<unknown>, number[]>();
/** Per-snapshot memo of `resolveSnapshotYear` results,
 *  keyed by `` `${taxYear}|${inflationRatePct}` `` (template-string coercion
 *  distinguishes undefined-vs-0 `inflationRatePct` for free). FIFO-bounded to
 *  128 entries per snapshot — a long session probing many distinct
 *  `(taxYear, inflationRatePct)` pairs can't grow it unbounded; an evicted
 *  pair simply recomputes on next use. */
const SNAPSHOT_RESOLUTION_MEMO = new WeakMap<
  CalibrationSnapshot<unknown>,
  Map<string, SnapshotYearResolution>
>();
const SNAPSHOT_RESOLUTION_MEMO_MAX_ENTRIES = 128;

/**
 * Resolve the effective snapshot year for a given taxYear, clamping to the
 * latest available key when taxYear exceeds all stored years.
 *
 * IRMAA and ACA-PTC use strict-year lookup internally, so the integration
 * layer clamps first and passes the effectiveYear to those engines — this
 * layer never lets UnsupportedTaxYearError escape to callers.
 *
 * When taxYear > latest snapshot key AND inflationRatePct is provided, returns
 * a thresholdScalingFactor for deflating dollar-denominated MAGI inputs so they
 * compare correctly against the clamped (older) thresholds. Clamps upper bound
 * only; a taxYear below the minimum snapshot key still throws from the engine.
 *
 * Memoized per `(snapshot identity, taxYear, inflationRatePct)` —
 * the sorted keys + the resolved result are computed once and reused. An empty
 * snapshot still throws on EVERY call (checked before the memo is consulted).
 *
 * @param snapshot - Calibration snapshot with year-keyed values.
 * @param taxYear - The projection year to resolve.
 * @param inflationRatePct - Optional annual inflation rate (e.g. 2.5 for 2.5%).
 *   Used only when taxYear exceeds the latest snapshot key.
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
    // Clamp upward: find highest key ≤ taxYear (handles sparse tables)
    let resolved = keys[0];
    for (const k of keys) {
      if (k <= taxYear) resolved = k;
    }
    result = { effectiveYear: resolved, taxYearExtrapolated: false, thresholdScalingFactor: 1 };
  }
  Object.freeze(result);
  if (memo.size >= SNAPSHOT_RESOLUTION_MEMO_MAX_ENTRIES) {
    // FIFO eviction: Map iteration order is insertion order, so the first key
    // is the oldest-inserted one.
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(cacheKey, result);
  return result;
}

/**
 * Resolve the assumed-taxable-yield config for `taxYear`. Clamps to the
 * latest stored year for projection years beyond the snapshot (the assumption
 * is population-level, not inflation-scaled). Returns the latest entry when the
 * snapshot is non-empty; throws if the snapshot has no years.
 */
export function resolveAssumedTaxableYieldConfig(
  snapshot: CalibrationSnapshot<AssumedTaxableYieldConfig>,
  taxYear: number,
): AssumedTaxableYieldConfig {
  const { effectiveYear } = resolveSnapshotYear(snapshot, taxYear);
  return snapshot.values[effectiveYear];
}

/** Clamped three-way tax-character split of the assumed brokerage yield. */
export interface AssumedYieldComponents {
  /** Qualified-dividend share of the total yield (0..1). */
  readonly qdiFraction: number;
  /** Tax-exempt municipal-interest share (0..1). Explicit calibration only —
   *  never inferred from a bond allocation. */
  readonly taxExemptFraction: number;
  /** Ordinary interest / non-qualified dividend remainder (0..1). */
  readonly ordinaryFraction: number;
}

/** Clamp a number to [0, 1] (non-finite → 0). Module-scope — this
 *  runs inside `applyTaxYear`'s per-path × per-year MC hot loop, so the helper
 *  must not be re-allocated as a closure per call. NOT shared with the
 *  identical private helper in `balance-projection-runner-tax-helpers.ts`:
 *  importing from there would create an import cycle (that module imports
 *  `./tax-integration`, which imports this file). */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Resolve the assumed yield's explicit tax-character components, clamped
 * so the three fractions are each in [0, 1] and sum to ≤ 1 (the tax-exempt
 * share yields to the QDI share when the raw pair over-commits; the ordinary
 * remainder absorbs the rest). One shared resolver so the deterministic and
 * Monte Carlo engines can never classify the same yield differently.
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

// ---------------------------------------------------------------------------
// Federal tax-config inflation extrapolation — extracted to a focused
// sibling module to keep this file within the shape limit. Re-exported here so existing
// importers of `./tax-integration-helpers` keep working unchanged.
// ---------------------------------------------------------------------------

export {
  buildScaledFederalTaxConfig,
  resolveFederalTaxSnapshotForYear,
} from './federal-tax-extrapolation';

// ---------------------------------------------------------------------------
// Roth helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the account is a Roth IRA (taxTreatment === 'ROTH', no RMD,
 * no ordinary income on withdrawal). Only RETIREMENT_ROTH_IRA qualifies. The
 * Roth 401(k)/403(b)/457(b)/TSP types exist too, but they are deliberately not
 * matched here: designated-Roth employer-plan accounts follow their own
 * pro rata rules and are classified through `isPureRothEmployerType` /
 * `isRothDesignatedPostBucket` (balance-calc.ts).
 *
 * Kept type-based (not treatment-based) on purpose: this guard backs the
 * pre-59½ penalty-basis builder (`buildPenaltyAccountsForYear`), which must key
 * off the concrete account class, not the broader 'ROTH' treatment value.
 */
export function isRothAccount(account: Pick<AccountPayload, 'type'>): boolean {
  return account.type === 'RETIREMENT_ROTH_IRA';
}

// ---------------------------------------------------------------------------
// MAGI composition
// ---------------------------------------------------------------------------

export interface MagiInput {
  /** Ordinary income dollars (wages, RMDs, pre-tax withdrawals, taxable SS). */
  readonly ordinaryIncomeDollars: number;
  /** LTCG + QDI dollars (from POST_TAX non-Roth withdrawals). */
  readonly ltcgDollars: number;
  /** Tax-exempt interest dollars (muni-bond interest — §36B MAGI add-back). */
  readonly taxExemptInterestDollars: number;
}

/**
 * Compute household MAGI per §36B (the ACA / IRMAA definition).
 * MAGI = ordinaryIncome + LTCG/QDI + taxExemptInterest.
 * (Taxable SS is already included in ordinaryIncome by the caller.)
 *
 * Returns dollars (not cents) — callers convert for engine inputs.
 */
export function computeMagi(input: MagiInput): number {
  return input.ordinaryIncomeDollars + input.ltcgDollars + input.taxExemptInterestDollars;
}

// ---------------------------------------------------------------------------
// Public per-year input/output types
// ---------------------------------------------------------------------------

/** Per-member info needed by the tax-integration layer each year. */
export interface TaxMemberInput {
  /** Aggregate ID of the household member. Used to scope RMD accounts. */
  readonly memberId: string;
  /** Member's ISO birth date (YYYY-MM-DD). Required for RMD trigger-age check. */
  readonly isoBirthdate: string;
  /** True when this member is enrolled in Medicare (Part B/D) this year. */
  readonly onMedicare: boolean;
  /** True when this member has active ACA marketplace coverage this year. */
  readonly hasAcaCoverage: boolean;
  /**
   * The month-aware health-coverage facts the
   * month-aware IRMAA / ACA engines consume. Populated by the runner from
   * `ScenarioOverrides.healthCoverageMonths` (applying the opt-out precedence).
   * Each is a whole month count 0..12; absent → the whole-year boolean
   * derivation above still governs (12 months when the boolean is true, 0 when
   * it is false), so a scenario carrying no monthly facts is unchanged. Part B
   * and Part D are independent — see `resolveCoverageMonths`.
   */
  readonly partBEnrollmentMonths?: number;
  readonly partDEnrollmentMonths?: number;
  readonly marketplaceCoverageMonths?: number;
  /**
   * The calendar year this member separated from service. Feeds the
   * §401(a)(9)(C) "later of statutory age or retirement" first-distribution-year
   * resolution for an account whose still-working exception applied. Absent →
   * that resolution WITHHOLDS rather than assuming the trigger-age year.
   */
  readonly retirementYear?: number;
}

/** Per-account balance snapshot for a single year (for RMD engine). */
export interface TaxAccountSnapshot {
  readonly id: string;
  /** Account type — matches `AccountPayload.type` (not `.accountType`). */
  readonly type: AccountType;
  readonly taxTreatment: AccountPayload['taxTreatment'];
  /** Owner member ID — used to scope RMD computation to this account's owner. */
  readonly ownerId: string;
  /** Dec 31 balance of the PRIOR year in whole dollars (for RMD). */
  readonly balancePriorYearDollars: number;
  /**
   * Post-tax (Roth-designated) sub-bucket of `balancePriorYearDollars`. The
   * RMD engine subtracts it via `rothPortionCents` per SECURE 2.0 §325 so
   * designated-Roth money never inflates a required withdrawal. Meaningful on any
   * account with a Roth-designated pocket (`hasRothDesignatedPocket`): a MIXED
   * 401(k)/403(b)/457(b)/TSP, or a PURE Roth account (POST_TAX / ROTH) whose whole
   * balance is that pocket — the INHERITED Roth case, where omitting
   * it would make the beneficiary's entire Roth balance a pre-tax RMD base.
   * Ignored for PRE_TAX / HSA (no Roth pocket). Absent on a MIXED account → the
   * engine treats the whole balance as pre-tax (conservative over-estimate); absent
   * on a pure Roth account → the engine nets the whole balance out anyway, since
   * such an account holds no pre-tax dollars.
   */
  readonly postBalancePriorYearDollars?: number;
  /** Withdrawal from this account in the current year, in whole dollars. */
  readonly withdrawalDollars: number;
  /**
   * This account's stored RMD profile facts, normalized at the
   * runtime boundary by `buildRmdProfileFacts`. Absent on EVERY snapshot in a
   * year → the RMD engine runs its legacy owner/Uniform-Lifetime path verbatim.
   * Present on ≥ 1 → per-account rule resolution (still-working exception,
   * Tables I/II/III, inherited blockers, first-year deferral).
   */
  readonly rmdFacts?: RmdAccountProfileFacts;
  /**
   * Dec 31 balance TWO years before the tax year, whole dollars. Sizes the
   * first-year-deferral catch-up ("two RMDs in one year"); absent → that catch-up
   * is reported as a blocker rather than guessed.
   */
  readonly balanceTwoYearsPriorDollars?: number;
  /**
   * The Roth-designated (post) sub-bucket of `balanceTwoYearsPriorDollars`,
   * whole dollars, on any account with a Roth-designated pocket. Netted out of the
   * catch-up base by the shared `rmdTwoYearsPriorBaseCents` resolver (SECURE 2.0
   * §325), exactly as `postBalancePriorYearDollars` is netted out of the
   * current-year base.
   */
  readonly postBalanceTwoYearsPriorDollars?: number;
}

/**
 * Per-account CURRENT-year withdrawal data driving the early-withdrawal / HSA
 * additional tax. Separate from {@link TaxAccountSnapshot}
 * (which is a PRIOR-year balance snapshot scoped to RMD-qualifying accounts):
 * the penalty applies to current-year withdrawals across a different account
 * set (HSAs included, Roth excluded).
 */
export interface PenaltyAccountSnapshot {
  readonly id: string;
  readonly type: AccountType;
  /** Owner member id — maps to the member's birthdate for the age cutoff. */
  readonly ownerId: string;
  /**
   * Includible-in-gross-income (pre-tax) portion of this account's current-year
   * withdrawal, in whole dollars — the 10% penalty basis. For PRE_TAX accounts
   * the whole withdrawal; for MIXED accounts the pre-tax tranche only.
   * 0 for HSA (use `hsaWithdrawalDollars`).
   */
  readonly penaltyPreTaxWithdrawalDollars: number;
  /**
   * `true` when `penaltyPreTaxWithdrawalDollars` is a §408A/§402A
   * additional-tax base the fact-based Roth ordering engine already resolved
   * (earnings + in-window conversion / in-plan-rollover recapture, with the
   * governmental-457(b) carve-out applied at the source). Forwarded to
   * `PenaltyAccountInput.rothOrderedAdditionalTaxBase`, which then skips the
   * account-type membership test so a legitimate 457(b) rollover recapture is not
   * dropped. Absent → the normal type-driven eligibility applies.
   */
  readonly rothOrderedAdditionalTaxBase?: boolean;
  /**
   * `true` for a distribution from an INHERITED account (made on account of
   * the original owner's death). Forwarded to
   * `PenaltyAccountInput.inheritedFromDeceasedOwner`, which waives the 10% §72(t)
   * leg per §72(t)(2)(A)(ii) regardless of the beneficiary's age. Absent → the
   * beneficiary's own 59½ proration applies.
   */
  readonly inheritedFromDeceasedOwner?: boolean;
  /**
   * Current-year HSA withdrawal in whole dollars (HSA accounts only). The
   * nonqualified fraction is ordinary income + the 20% additional tax pre-65.
   */
  readonly hsaWithdrawalDollars: number;
  /**
   * Portion of `hsaWithdrawalDollars` funded against modeled `isMedical`
   * demand (the medical-qualified drawdown pass), in whole dollars.
   * These dollars are 100% qualified/tax-free — EXCLUDED from BOTH the
   * ordinary-income fold-in AND the 20% additional-tax penalty basis. The
   * EMERGENCY/nonmedical portion that `hsaQualifiedMedicalExpensePct` governs
   * is the residual `max(0, hsaWithdrawalDollars − hsaMedicalQualifiedDollars)`.
   * Absent → 0 (legacy callers: the whole HSA draw is treated as emergency).
   */
  readonly hsaMedicalQualifiedDollars?: number;
  /**
   * Committed HSA withdrawal in INTEGER CENTS (HSA accounts only). When
   * present the tax pass derives the emergency residual in cents
   * (`max(0, hsaWithdrawalCents − hsaMedicalQualifiedCents)`) so the medical +
   * emergency slices reconcile EXACTLY to the committed cents with no penny
   * drift in the nonqualified-income / 20%-additional-tax basis. Absent → the
   * pass falls back to the dollar fields (legacy callers).
   */
  readonly hsaWithdrawalCents?: number;
  /**
   * Medical-qualified HSA cents, the integer-cent counterpart of
   * `hsaMedicalQualifiedDollars`. Paired with `hsaWithdrawalCents`; the
   * emergency slice is the never-independently-rounded residual.
   */
  readonly hsaMedicalQualifiedCents?: number;
}

/**
 * All inputs the tax-integration layer needs for one projection year.
 * Assembled by the runner from per-account drawdown output.
 */
export interface TaxYearInput {
  readonly taxYear: number;
  readonly filingStatus: FilingStatus;
  /** Gross SS benefit dollars for the year (before taxation). */
  readonly grossSsDollars: number;
  /**
   * Household income besides SS (portfolio withdrawals + other income).
   * Split by source so MAGI / taxable-income can be composed correctly.
   */
  readonly preTaxWithdrawalDollars: number;
  readonly postTaxNonRothWithdrawalDollars: number;
  /**
   * POST_TAX withdrawals from cash-like accounts ({SAVINGS, MONEY_MARKET,
   * CD, HSA}) — return of already-taxed principal. Threaded through for
   * completeness but EXCLUDED from the LTCG proxy AND from the MAGI sum: these
   * dollars contribute $0 to `ltcgAndQdi` and $0 to MAGI. The interest those
   * balances EARN is taxed annually via `cashInterestDollars` — since the
   * growth is taxed the year it accrues, the withdrawal itself stays
   * already-taxed principal. Defaults to 0 when absent (older callers).
   */
  readonly postTaxCashLikeWithdrawalDollars?: number;
  /**
   * Annual ordinary taxable interest earned by cash-like POST_TAX
   * balances (`SAVINGS` / `MONEY_MARKET` / `CD`; NEVER HSA — HSA growth is
   * tax-free) for the year, in whole dollars. Both engines derive it from the
   * account's own realized growth (`max(0, endBalance + withdrawn − deposits −
   * startBalance)` per account — the same documented approximation), so a
   * high-yield CD is taxed on its own configured rate, not a population
   * assumption. Folded into ordinary income, §86 provisional income, both
   * MAGIs, and the §1411 NIIT base; assumed reinvested (no balance effect
   * here — the growth path already carries it), and excluded from the
   * effective-tax-rate gross-income denominator like the reinvested yield.
   * Absent → 0 (no cash-like balances / legacy callers).
   */
  readonly cashInterestDollars?: number;
  readonly rothWithdrawalDollars: number;
  /**
   * Qualified Charitable Distribution amount EXCLUDED from ordinary income /
   * MAGI for the year, in whole dollars. Subtracted from the pre-tax
   * IRA-withdrawal income BEFORE `computeSsTaxation` (§86 runs before MAGI
   * composition) and from the shared AGI base feeding BOTH the federal/IRMAA
   * MAGI and the ACA-PTC MAGI; the QCD-reduced MAGI is the value advanced into
   * the IRMAA Y+2 look-back ring. Clamped at the pre-tax withdrawal total (a QCD
   * is part of, never on top of, the IRA distribution). Absent / 0 → no
   * exclusion.
   *
   * RESERVED seam for the Monte Carlo per-path tax site: MC
   * draws the gross IRA distribution and then subtracts the QCD here. The
   * DETERMINISTIC engine must NOT populate this field — it achieves the exclusion
   * STRUCTURALLY (the gift is debited to the source IRA's pre-tax bucket and is
   * never drawn as a taxable pre-tax withdrawal, so it never enters
   * `preTaxWithdrawalDollars`). Setting BOTH would double-exclude the QCD.
   */
  readonly qcdIncomeExclusionDollars?: number;
  /** Non-portfolio ordinary income (pensions, part-time wages, etc.). */
  readonly otherOrdinaryIncomeDollars: number;
  /** Tax-exempt interest (muni bonds) — added back to MAGI per §36B. */
  readonly taxExemptInterestDollars: number;
  /**
   * Fraction of POST_TAX non-Roth withdrawal that is LTCG/QDI.
   * 0..1; defaults to 0.5 when absent.
   */
  readonly assumedCostBasisFraction?: number;
  /**
   * Brokerage-like (POST_TAX `BROKERAGE` / `OTHER`) account balance at the
   * START of the tax year, in whole dollars. Drives the annual
   * assumed-yield tax drag: `applyTaxYear` multiplies this by the year's
   * `assumedTaxableYield` config and splits the yield across the three
   * character components, each with its own MAGI-vs-§1411-NIIT treatment:
   *   - qualified-dividend → folds into `ltcgAndQdi` (preferential rates);
   *     feeds both MAGIs AND the NIIT base;
   *   - ordinary-interest → ordinary brackets; feeds both MAGIs AND the NIIT
   *     base (interest is net investment income too, §1411(c));
   *   - tax-exempt-municipal → $0 federal taxable income and NOT NII (outside
   *     the §1411 base), but added to `taxExemptInterestDollars` — the §86
   *     provisional-income and §36B/IRMAA MAGI add-back (seeded 0; explicit
   *     calibration only, never inferred from a bond allocation).
   * Excludes cash-like, pre-tax, and Roth balances. Absent or 0 → no yield drag.
   */
  readonly brokerageLikeStartBalanceDollars?: number;
  /** Number of household members. Used for ACA household-size calculation. */
  readonly householdSize: number;
  readonly members: readonly TaxMemberInput[];
  /** Per-account snapshots (for RMD computation). */
  readonly accounts: readonly TaxAccountSnapshot[];
  /**
   * MAGI from two years prior for IRMAA look-back.
   * Undefined → IRMAA skipped for this year.
   */
  readonly magiTwoYearsPriorDollars?: number;
  /**
   * ACA benchmark SLCSP override for this year, in whole dollars.
   * Absent → age-based formula used.
   */
  readonly acaBenchmarkSlcspDollars?: number;
  /**
   * Federal-poverty-level region for the
   * household's ACA FPL denominator (`'contiguous'` | `'alaska'` | `'hawaii'`).
   * Threaded from `ScenarioOverrides.acaFplRegion`; absent → `'contiguous'`
   * (the default, unchanged output for every scenario that sets no region).
   */
  readonly acaFplRegion?: AcaFplRegion;
  /**
   * Number of taxpayers in the household who are age 65+ this year
   * (for federal-tax standard-deduction add-on).
   */
  readonly taxpayersAge65Plus: number;
  /**
   * Assumed annual inflation rate as a percentage (e.g. 2.5 for 2.5%).
   * Used to scale dollar-denominated IRMAA/ACA thresholds when taxYear
   * exceeds the latest calibration snapshot key.
   * Absent or 0 → no scaling (thresholds used as-is from latest snapshot).
   */
  readonly inflationRatePct?: number;
  /** Scenario medical inflation rate (percent) that grows the rough ACA
   *  benchmark from its base year. Absent → no growth. */
  readonly medicalInflationRatePct?: number;
  /**
   * Percentage (0–100) of EMERGENCY HSA withdrawals assumed to be qualified
   * medical expenses (tax-free); modeled medical-qualified withdrawals are
   * always 100% qualified. The remaining nonqualified fraction is ordinary
   * income and, before age 65, carries the 20% HSA additional tax. Absent →
   * 100 (fully qualified, the tax-free default). Scenario-level.
   */
  readonly hsaQualifiedMedicalExpensePct?: number;
  /**
   * Account ids exempt from the early-withdrawal additional tax (10% before
   * 59½; HSA 20% before 65). Scenario-marked. Absent → [] (none exempt).
   */
  readonly earlyWithdrawalPenaltyExemptAccountIds?: readonly string[];
  /**
   * Per-account CURRENT-year withdrawal data for the early-withdrawal / HSA
   * additional tax. Absent → no penalty assessed.
   */
  readonly penaltyAccounts?: readonly PenaltyAccountSnapshot[];
}

/** Tax-integration result for one projection year. */
export interface TaxYearResult {
  /** Federal income tax owed, in integer cents. */
  readonly federalTaxCents: number;
  /** Taxable portion of SS benefits per §86, in integer cents. */
  readonly taxableSsCents: number;
  /** §86 tier: 'none' / 'fifty' / 'eighty-five'. */
  readonly ssTaxationTier: 'none' | 'fifty' | 'eighty-five';
  /** Total RMD required for all qualifying accounts, in integer cents. */
  readonly rmdFloorCents: number;
  /** True when ≥ 1 household owner reached their SECURE 2.0 RMD trigger age this
   *  tax year. Distinguishes an applicable year (per-account map present — a
   *  possibly-empty `{}` at a $0 floor) from a pre-trigger year (map absent). */
  readonly rmdApplicable: boolean;
  /** Per-account RMD in integer cents (qualifying accounts only). */
  readonly rmdPerAccountCents: Record<string, number>;
  /**
   * Accounts whose RMD could NOT be computed this year because a
   * required fact is missing or a fact combination is unsupported. Each is
   * EXCLUDED from `rmdFloorCents` (the result is withheld, never guessed) and is
   * surfaced to the user as a blocker with the exact missing inputs. Absent when
   * no account carries RMD facts (the legacy path).
   */
  readonly rmdWithheldAccounts?: readonly RmdWithheldAccount[];
  /** Accounts whose RMD is deferred this year by the §401(a)(9)(C)
   *  still-working exception (a legitimate $0, not a blocker). */
  readonly rmdStillWorkingDeferredAccountIds?: readonly string[];
  /** Accounts whose first RMD is deferred to April 1 of the following
   *  year, with the deferred cents and the year they become due. The following
   *  year therefore carries TWO RMDs, which is why this is disclosed. */
  readonly rmdFirstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  /** Deferred-from-the-prior-year RMD cents folded into `rmdFloorCents`
   *  this year (the "two RMDs in one year" tax/IRMAA consequence). */
  readonly rmdDeferredCatchUpCents?: number;
  /** Total household Medicare IRMAA surcharge, in integer cents. 0 when not applicable. */
  readonly irmaaSurchargeCents: number;
  /** IRMAA tier applied. 'none' when not applicable or skipped. */
  readonly irmaaTier: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  /** ACA PTC subsidy for the year, in integer cents. 0 when not applicable. */
  readonly acaPtcSubsidyCents: number;
  /** ACA PTC tier. 'below-fpl' when not applicable or skipped. */
  readonly acaPtcTier: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  /** ACA FPL percentage for the year (0 when not applicable). */
  readonly fplPercentage: number;
  /** Cents of ACA MAGI above 100% of the poverty line, where the credit ends;
   *  the smallest figure among the returns that earn a credit, 0 when none does.
   *  Projection-year dollars. */
  readonly acaMagiAboveFplCents: number;
  /** Household MAGI for the year, in integer cents. */
  readonly magiCents: number;
  /** Effective federal tax rate: totalTax / grossIncome (0..1). */
  readonly effectiveTaxRate: number;
  /** True when the snapshot year was clamped (future year beyond table). */
  readonly taxYearExtrapolated: boolean;
  /**
   * IRA/401k-style early-distribution 10% additional tax for the year (IRC
   * §72(t)), in integer cents. Already INCLUDED in `federalTaxCents`. Surfaced
   * separately for display. 0 when not applicable.
   */
  readonly earlyWithdrawalPenaltyCents: number;
  /**
   * HSA 20% additional tax on nonqualified pre-65 withdrawals (IRC §223(f)(4)),
   * in integer cents. Already INCLUDED in `federalTaxCents`. Surfaced separately
   * for display. 0 when not applicable.
   */
  readonly hsaAdditionalTaxCents: number;
  /**
   * True when a penalizable account's owner birthdate was missing/unparseable,
   * so its penalty was skipped — the caller surfaces this in the estimate note.
   */
  readonly penaltySkippedForMissingBirthdate: boolean;
  /**
   * This year's MAGI and filing status PER TAX UNIT (one entry per
   * return actually filed). Populated by `applyTaxYearForFilingPlan`; absent
   * from a bare `applyTaxYear` call.
   *
   * The runners buffer these into the IRMAA two-year look-back ring so each
   * return is tiered on ITS OWN look-back MAGI and ITS OWN schedule two years
   * later. Storing a single household MAGI + the first unit's status instead
   * would mis-tier a mixed `MFS`+`HoH` couple (both scored on one schedule) and
   * charged a survivor on the merged household MAGI of the last two-return year.
   */
  readonly filingUnitMagi?: readonly FilingUnitMagi[];
  /**
   * The year's IRMAA surcharge PER RETURN. Populated only for a
   * multi-return (separate-filing) year; the household total is always
   * `irmaaSurchargeCents`.
   *
   * The cashflow solver withholds each Medicare beneficiary's surcharge from
   * THAT beneficiary's own Social Security, so it needs the per-return split:
   * once two returns can land on DIFFERENT IRMAA tiers, re-splitting the merged
   * household surcharge equally attributes the wrong amount to each spouse's SS
   * check (the household total stays right, the withheld-vs-cash split does not).
   */
  readonly irmaaSurchargeCentsByUnit?: readonly UnitIrmaaSurcharge[];
  /**
   * The year's IRMAA surcharge PER BENEFICIARY, one entry per member
   * with any enrolled Medicare month.
   *
   * Absent when the year ran no IRMAA calculation at all — no member had an
   * enrolled Medicare month, or the two-year look-back MAGI is unknown. It is
   * NOT absent for a $0 surcharge: a `tier: 'none'` year still emits one entry
   * per beneficiary with `surchargeCents: 0`.
   *
   * Month-aware IRMAA prorates Part B and Part D by each beneficiary's OWN
   * enrolment months, so two beneficiaries on one return can owe very different
   * amounts. The cashflow solver withholds each member's surcharge from THAT
   * member's own Social Security, and re-dividing the household total evenly
   * would withhold the wrong amount from each check. The
   * entries always sum to `irmaaSurchargeCents`.
   */
  readonly irmaaSurchargeCentsByMember?: readonly MemberIrmaaSurcharge[];
}

/** One return's IRMAA surcharge for a single year. */
export interface UnitIrmaaSurcharge {
  readonly memberIds: readonly string[];
  readonly surchargeCents: number;
}

/** One BENEFICIARY's own IRMAA surcharge for a single year. */
export interface MemberIrmaaSurcharge {
  readonly memberId: string;
  readonly surchargeCents: number;
}

/** One tax unit's MAGI + filing facts for a single year — the per-unit IRMAA
 *  look-back ring entry. */
export interface FilingUnitMagi {
  /** Household member ids this return covers. Empty only when the caller could
   *  not map the unit's roles (the fail-open path). */
  readonly memberIds: readonly string[];
  /** The status this return was filed under. */
  readonly filingStatus: FilingStatus;
  /** §86(c)(1)(C)(ii) / CMS — whether this `MFS` return lived with the spouse. */
  readonly mfsLivedWithSpouse: boolean;
  /** This return's own MAGI, in integer cents. */
  readonly magiCents: number;
}

/** One return the household filed in a BOOTSTRAP look-back year — a year BEFORE
 *  the projection started, so its status is resolvable from the stored filing
 *  plan but its MAGI is not. */
export interface BootstrapLookbackUnit {
  /** Household member ids this return covered. */
  readonly memberIds: readonly string[];
  /** The status this return was filed under. */
  readonly filingStatus: FilingStatus;
  /** §86(c)(1)(C)(ii) / CMS — whether this `MFS` return lived with the spouse. */
  readonly mfsLivedWithSpouse: boolean;
}

/**
 * The per-return IRMAA look-back ring for a BOOTSTRAP projection year.
 *
 * Projection years 0–1 tier IRMAA on returns filed BEFORE the projection began,
 * so the per-unit ring (`TaxYearResult.filingUnitMagi`) has no entry for
 * them and only the household-wide bootstrap MAGI scalar is known. Collapsing
 * that to ONE status would leave a mixed `MFS`+`HoH` couple tiering BOTH spouses on the
 * first spouse's schedule for the first two years, then switching to their own
 * once the ring filled — a discontinuity in the surcharge with no cause in the
 * plan.
 *
 * Reconstructing the ring instead keeps every year on ONE code path: each return
 * carries its OWN status, and the one household MAGI figure divides evenly
 * across the returns — the same even split `unitIrmaaLookback` already applies
 * to the household scalar (`magiTwoYearsPriorDollars * share`), now exact to the
 * cent.
 *
 * @returns `undefined` when there is nothing per-unit to say, so the caller
 *          passes the untouched household fallback: no bootstrap returns, a
 *          single return (the household scalars already handle that case
 *          identically), or an ABSENT look-back MAGI. The absent case matters —
 *          `applyTaxYear` skips IRMAA entirely for an undefined look-back MAGI
 *          but tiers a $0 one, so materializing $0 entries here would turn a
 *          skipped surcharge into a computed (still $0) one and change the
 *          reported tier.
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

// ---------------------------------------------------------------------------
// ACA benchmark formula
// ---------------------------------------------------------------------------

/**
 * Default household SLCSP benchmark (whole dollars)
 * when no per-year override is provided: the SUM over covered members of that
 * member's OWN age-priced monthly premium × their Marketplace coverage MONTHS.
 *
 * This is not the OLDEST covered member's annual
 * premium × the covered-member count, which would over-price a younger spouse and
 * charge a full year for a member covered only part of the year. The per-member
 * sum is delegated to `roughHouseholdAnnualBenchmarkCents` so the disclosed
 * assumptions and the priced figure can never drift apart.
 *
 * Returns 0 when no member has covered Marketplace months (the caller's
 * engagement gate already guards this, but the formula stays total).
 *
 * @param members  Per-member info for the year (already alive-filtered).
 * @param taxYear  Calendar year (for the age-curve lookup).
 * @throws {AcaPtcInvalidInputError} a covered member's age is not a
 *   non-negative integer (the boundary that builds `members` gates coverage on a
 *   parseable birthdate, so this signals a caller bug rather than pricing an
 *   off-curve premium).
 */
export function defaultHouseholdSlcspByAge(
  members: readonly TaxMemberInput[],
  taxYear: number,
): number {
  return roughHouseholdAnnualBenchmarkCents(acaCoveredMembers(members, taxYear)) / 100;
}

/**
 * Convert a user-entered ANNUAL benchmark SLCSP into the
 * covered-member-month sum `AcaPtcInput.benchmarkAnnualSlcspCents` contracts for.
 *
 * The editor asks for the "Benchmark plan cost for the year" — a WHOLE-YEAR
 * household price — but §36B(b)(2) sums the credit over COVERAGE MONTHS only, so
 * a non-coverage month must contribute zero on BOTH sides. `computeAcaPtc`
 * prorates the expected contribution by `coverageMonths`; the benchmark it is
 * subtracted from must be prorated by the SAME month count or a part-year
 * household is credited `12 × benchmark − months × contribution` instead of the
 * statutory `months × (benchmark − contribution)` — an over-credit of
 * `(12 − months) × monthly benchmark`, in the optimistic direction.
 *
 * The rough age-priced fallback (`defaultHouseholdSlcspByAge`) already multiplies
 * each member's monthly premium by that member's covered months, so it needs no
 * proration; this helper is the override's equivalent.
 *
 * The 12-month branch returns the converted cents unchanged so a whole-year
 * household stays BYTE-identical to the plain annual formula.
 *
 * @param annualOverrideDollars The user's whole-year household benchmark price.
 * @param coverageMonths        Household Marketplace coverage months (0..12).
 */
export function overrideBenchmarkCentsForCoverageMonths(
  annualOverrideDollars: number,
  coverageMonths: number,
): number {
  const annualCents = dollarsToCents(annualOverrideDollars);
  if (coverageMonths >= 12) return annualCents;
  return Math.round((annualCents * Math.max(0, coverageMonths)) / 12);
}

/**
 * The covered-member records the rough per-member benchmark prices: each
 * member's age this tax year plus their resolved Marketplace coverage months.
 * Members with zero covered months are dropped (they contribute $0 and would
 * otherwise force an age parse for a member who never buys a plan).
 */
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

// ---------------------------------------------------------------------------
// Per-YEAR household health facts (memoized — Monte Carlo hot-loop budget)
// ---------------------------------------------------------------------------

/** The household-level health facts `applyTaxYear` needs for one year. */
export interface HealthCoverageYearFacts {
  /** IRMAA engagement gate — any member has an enrolled Medicare month. */
  readonly anyMedicareMonths: boolean;
  /** Per-beneficiary Part B / Part D months, tagged with the owning member. */
  readonly irmaaBeneficiaries: readonly IrmaaMemberEnrollment[];
  /** Household Marketplace coverage months (§36B(b)(2) summation range). */
  readonly marketplaceCoverageMonths: number;
  /** Rough age-priced household benchmark (whole dollars); 0 when uncovered. */
  readonly defaultBenchmarkAnnualDollars: number;
}

/**
 * Resolve (and memoize) one year's household health facts.
 *
 * Every field is a pure function of `(members, taxYear)` and carries NO seed
 * dependence, but `applyTaxYear` runs once per Monte Carlo PATH per year while
 * the year's survivor array is built exactly once per run
 * (`buildSurvivorStatesByYear`). Keying the memo on that array's identity
 * therefore collapses ~N_paths recomputations of the per-member benchmark sum
 * and the IRMAA enrolment list into one, restoring the once-per-run-year
 * hot-loop contract. The `taxYear` is stored
 * alongside so a caller that reuses one array across years still recomputes.
 *
 * The memo hits only for callers that hand it a STABLE array. The
 * separate-filing path builds a per-unit subset rather than passing the
 * household array, so `buildUnitTaxYearInput` memoizes that subset on the same
 * household array's identity (`unitMembersFor` in `tax-integration.ts`); without
 * that, a two-return household re-derived these facts once per PATH-year.
 *
 * A `WeakMap` key means the entry dies with the survivor array; nothing is
 * retained across runs.
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
    // Priced only when the household actually has covered months — the age
    // curve throws for an off-curve age, and an uncovered household must not
    // pay that cost (or that risk) at all.
    defaultBenchmarkAnnualDollars:
      marketplaceCoverageMonths > 0 ? defaultHouseholdSlcspByAge(members, taxYear) : 0,
  };
  // Written only after a successful pricing pass, so a throwing year is never
  // memoized as a silent zero.
  HEALTH_YEAR_FACTS_CACHE.set(members, { taxYear, facts });
  return facts;
}

const HEALTH_YEAR_FACTS_CACHE = new WeakMap<
  readonly TaxMemberInput[],
  { taxYear: number; facts: HealthCoverageYearFacts }
>();

// ---------------------------------------------------------------------------
// Per-tax-unit federal input construction
// ---------------------------------------------------------------------------
//
// The scalar pipeline (`applyTaxYear`) collapses the whole household onto ONE
// `deriveFilingStatus` value. The per-tax-unit path below resolves a year's
// filing plan (`resolveFilingPlanForYear`) into one or more tax units — a joint
// couple is one unit; a `separate` couple is two — and builds each unit's own
// federal input carrying its own `FilingStatus` (including MFS/QSS). It is NOT
// the FEDERAL-INPUT seam: the production per-year path resolves its
// units the same way but applies the COMPLETE `applyTaxYear` per unit
// (`applyTaxYearForFilingPlan`). Every export here is covered by
// `tax-integration.test.ts` so it stays knip-clean.

// ---------------------------------------------------------------------------
// Engagement gates — used internally by applyTaxYear
// ---------------------------------------------------------------------------

/**
 * One member's resolved health-coverage MONTHS for the year.
 *
 * The month fields are the authority when present; when a field is absent the
 * whole-year boolean it replaces still governs (`true` → 12, `false` → 0), so a
 * scenario carrying no monthly facts resolves to the whole-year boolean behaviour.
 * Part B and Part D resolve INDEPENDENTLY — a member may enrol in one and not
 * the other, or start each in a different month of an ACA→Medicare transition
 * year. Values are clamped to the statutory 0..12 range and floored to whole
 * months so a corrupt stored value can never over-charge a surcharge.
 */
export interface ResolvedCoverageMonths {
  readonly partBMonths: number;
  readonly partDMonths: number;
  readonly marketplaceMonths: number;
}

/** Clamp a stored month count to a whole number of months in [0, 12]. */
function clampMonths(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(12, Math.max(0, Math.floor(value)));
}

/** Medicare Part B enrolment months for the year. */
function partBMonthsOf(m: TaxMemberInput): number {
  return clampMonths(m.partBEnrollmentMonths, m.onMedicare ? 12 : 0);
}

/** Medicare Part D enrolment months for the year (independent of Part B). */
function partDMonthsOf(m: TaxMemberInput): number {
  return clampMonths(m.partDEnrollmentMonths, m.onMedicare ? 12 : 0);
}

/**
 * ACA Marketplace coverage months for the year, after the §36B(c)(2)(B)
 * mutual-exclusivity clamp: a month of Medicare enrolment is never a PTC
 * coverage month, so the stated Marketplace count can never exceed the months
 * the member is NOT enrolled in Part B or Part D. Without the clamp a stated
 * `marketplaceMonths` and an independently-resolved Medicare count could charge
 * more than 12 covered months in one year, which inflates both the benchmark
 * and the credit (the error direction is optimistic).
 */
function marketplaceMonthsOf(m: TaxMemberInput): number {
  const stated = clampMonths(
    m.marketplaceCoverageMonths,
    m.hasAcaCoverage && !m.onMedicare ? 12 : 0,
  );
  const medicareMonths = Math.max(partBMonthsOf(m), partDMonthsOf(m));
  return Math.max(0, Math.min(stated, 12 - medicareMonths));
}

/**
 * Resolve one member's Part B / Part D / Marketplace months for the year
 * (see `ResolvedCoverageMonths`). This is the ONE composed resolver every
 * production pricing path shares: the household benchmark (`acaCoveredMembers`)
 * and the month-aware IRMAA beneficiary list (`irmaaBeneficiaryEnrollments`)
 * both read it, so the two engines cannot resolve different months for the same
 * member. The boolean engagement gates below stay scalar — they run per member
 * per year inside the Monte Carlo per-path loop, where allocating a record
 * would be pure garbage.
 */
export function resolveCoverageMonths(m: TaxMemberInput): ResolvedCoverageMonths {
  return {
    partBMonths: partBMonthsOf(m),
    partDMonths: partDMonthsOf(m),
    marketplaceMonths: marketplaceMonthsOf(m),
  };
}

/** Returns true when at least one member has any enrolled Medicare month
 *  (IRMAA engagement gate). Month-aware; identical to
 *  `some(m.onMedicare)` when no monthly facts are stored. */
export function anyMemberOnMedicare(members: readonly TaxMemberInput[]): boolean {
  return members.some((m) => partBMonthsOf(m) > 0 || partDMonthsOf(m) > 0);
}

/**
 * Returns true when at least one member has covered ACA Marketplace months
 * (ACA-PTC engagement gate). Month-aware.
 */
export function anyMemberHasAcaCoverage(members: readonly TaxMemberInput[]): boolean {
  return members.some((m) => marketplaceMonthsOf(m) > 0);
}

/**
 * The number of calendar months the HOUSEHOLD had Marketplace coverage,
 * which is what IRC §36B(b)(2) sums the monthly credit over.
 *
 * The stored model carries per-member month COUNTS, not calendar masks, so the
 * household count is taken as the LARGEST member count. That is exact whenever
 * members' coverage periods are nested — which is what the automatic derivation
 * always produces (everyone's Marketplace coverage runs from January until
 * their own Medicare month) — and is the least-surprising reading of two
 * hand-entered counts. Two spouses covered in genuinely DISJOINT month ranges
 * (say 5 months each, non-overlapping) are therefore credited 5 household
 * coverage months rather than 10; recording that case exactly needs a stored
 * month MASK, which the app does not store.
 */
export function householdMarketplaceCoverageMonths(
  members: readonly TaxMemberInput[],
): number {
  let months = 0;
  for (const m of members) months = Math.max(months, marketplaceMonthsOf(m));
  return months;
}

/**
 * The per-beneficiary Part B / Part D enrolment months the
 * month-aware IRMAA engine prorates each part by, one entry per member with any
 * enrolled month. Each entry carries its own `memberId` so the cashflow solver
 * can withhold each beneficiary's OWN surcharge from that member's own Social
 * Security instead of re-dividing the household total evenly.
 * Capped at two entries (one household) because `computeMonthAwareIrmaa`
 * rejects more.
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

/** One IRMAA beneficiary's enrolment months, tagged with the member the
 *  surcharge belongs to. Structurally a superset of the engine's
 *  `IrmaaBeneficiaryEnrollment`, so it is accepted verbatim by
 *  `computeMonthAwareIrmaa`. */
export interface IrmaaMemberEnrollment extends IrmaaBeneficiaryEnrollment {
  readonly memberId: string;
}

// ---------------------------------------------------------------------------
// Automatic (birthday-based) Medicare timing — the ONE shared resolver
// ---------------------------------------------------------------------------

/**
 * The number of months in `taxYear` a member is entitled to Medicare when
 * the scenario states no month count of its own ("Automatic" in the editor).
 *
 * Medicare Part A/B entitlement begins in the month the member turns 65 — or in
 * the PRECEDING month when the birthday falls on the FIRST day of a month, which
 * Medicare treats as turning 65 the previous month (Medicare.gov, "When does
 * Medicare coverage start?"). A January-1 birthday therefore starts in December
 * of the previous calendar year, which is also the year the IRS born-Jan-1 rule
 * treats the member as attaining 65 (§1.72-... / Pub 590-B).
 *
 * A whole-year approximation (12 months for a January–June birthday, 0 for
 * July–December) would charge a full year of IRMAA to a June birthday and none
 * at all to an October one.
 *
 * Empty, malformed or impossible birthdate → 0 (see `isUsableBirthdate`); the
 * caller's own `ageKnown` guard, which applies the SAME validity test, decides
 * what to do with a member whose age is unknown.
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

/**
 * A birthdate the health resolver may derive coverage
 * from: a COMPLETE, real `YYYY-MM-DD` calendar date.
 *
 * Checking only that the YEAR parses is not enough. A member aggregate reaches
 * the engines straight off an IMPORTED payload, whose validation checks the
 * envelope and not the field shapes, so a structurally-numeric but impossible
 * date (`1961-99-99`, `1961-02-30`, `1961-13-01`) is reachable. A
 * defaulting-then-deriving path would turn that into month 1 / day 99 and charge a
 * full 12 months of Medicare — with real IRMAA surcharges and a full-year
 * Marketplace lock-out — for a date that does not exist.
 *
 * Reuses the repo's ONE strict ISO-date validator (`db/rmd-fact-validation.ts`,
 * also the source of truth for the stored RMD birth/death dates) rather than a
 * second hand-rolled parser: it requires the exact `YYYY-MM-DD` shape, rejects
 * impossible calendar days via a UTC round-trip (Feb 30, Apr 31, non-leap
 * Feb 29), and rejects implausible years outside `[1900, 2200]`.
 *
 * An unusable birthdate resolves to NO Medicare months and NO Marketplace
 * months — the withhold direction: the projection never invents an
 * entitlement or a subsidy from data it cannot read.
 */
function isUsableBirthdate(iso: string | null | undefined): iso is string {
  return isValidRmdIsoDate(iso);
}

/** One member's STORED health-coverage month facts for a year, as read
 *  off `ScenarioOverrides.healthCoverageMonths`. Every field is optional: the
 *  editor stores only the counts the user actually stated. */
export interface StoredMemberCoverageMonths {
  readonly partBMonths?: number;
  readonly partDMonths?: number;
  readonly marketplaceMonths?: number;
}

/** The sparse stored map both engines read (structurally identical to
 *  `HealthCoverageMonthsOverride` in `db/types`, declared here so this pure
 *  engine helper carries no persistence-layer dependency). */
export interface StoredHealthCoverageMonths {
  readonly perMember?: Record<string, Record<number, StoredMemberCoverageMonths>> | null;
}

/** One stated (member, year) coverage-month entry. */
export interface StoredCoverageMonthEntry {
  readonly memberId: string;
  readonly taxYear: number;
  readonly months: StoredMemberCoverageMonths;
}

/**
 * The tax-year domain the health engines accept. Both
 * `computeAcaPtc` and `computeMonthAwareIrmaa` reject anything outside
 * `[2000, 2100]` (`AcaPtcInvalidInputError` / `IrmaaInvalidInputError`), so a
 * stored year outside it can never price anything — it can only render as a
 * bogus label or seed a picker with a value that does not exist.
 */
const MIN_STORED_TAX_YEAR = 2000;
const MAX_STORED_TAX_YEAR = 2100;

/** A stored (or imported) tax-year value the engines can use. */
function isSupportedStoredTaxYear(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_STORED_TAX_YEAR &&
    value <= MAX_STORED_TAX_YEAR
  );
}

/**
 * Object keys that must never be used to index a plain-object
 * dictionary built from user-controlled identifiers (CWE-1321).
 *
 * Import validation (`data-import.ts`) rejects these strings in KEY position
 * but permits them as aggregate-id VALUES, so an imported household member can
 * genuinely carry the id `"__proto__"`.
 */
const DANGEROUS_DICTIONARY_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True when an identifier must not be used as a dictionary key. */
export function isDangerousDictionaryKey(key: string): boolean {
  return DANGEROUS_DICTIONARY_KEYS.has(key);
}

/** One validated per-year benchmark (SLCSP) override row. */
export interface StoredAcaBenchmarkOverride {
  readonly taxYear: number;
  readonly annualSlcspDollars: number;
}

/**
 * THE shared reader for `ScenarioOverrides.acaPtcBenchmark`.
 *
 * The override reaches every engine, the modal, the on-screen report and the
 * PDF settings straight off a scenario aggregate, and import validation checks
 * the ENVELOPE only — never override shapes. A reader that trusted the
 * payload to be an array of well-formed rows would throw on an imported object
 * (rather than an array) out of a spread / iteration or later at `.find`, taking
 * down the modal, the Report page, the PDF build, the deterministic projection
 * or the Monte Carlo context assembly; a malformed row would leak a `NaN` year or a
 * negative price into user-facing copy and into the benchmark the engines
 * price from.
 *
 * Routing every reader through this ONE enumerator keeps the shape rules from
 * drifting the way several hand-written guards would:
 *   - a non-array (or absent) payload reads as "no override",
 *   - a non-object row is dropped,
 *   - the year must be an integer inside the supported tax-year domain,
 *   - the price must be a finite POSITIVE dollar figure (a `$0` benchmark would
 *     floor the credit to $0 — see `pruneBenchmarkRows`),
 * and the survivors are returned ascending by tax year so every surface lists
 * them in the same order.
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
 * Read one member/year entry out of the stored coverage-month map.
 *
 * Every level is optional-chained and shape-checked: the map arrives from an
 * IMPORTED scenario aggregate, whose envelope validation checks forbidden keys
 * but not override shapes, so `{ perMember: null }` or a `null` year entry are
 * both reachable. A non-object at any level reads as "nothing stated", which is
 * the whole-year boolean behaviour — never a thrown TypeError that would blank the
 * whole projection.
 *
 * Every level is also read through `Object.hasOwn` (CWE-1321). An
 * imported household member may legitimately carry the id `"__proto__"` (import
 * validation rejects that string as a KEY, not as an id VALUE), and a plain
 * stored map would then resolve `perMember["__proto__"]` to `Object.prototype`
 * — an object that passes the shape check and whose inherited members would be
 * read as this member's stated coverage.
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
 * Enumerate every stated (member, year) entry in the stored
 * coverage-month map, ordered by tax year then member id.
 *
 * The engines read ONE entry at a time (`readStoredCoverageMonths`); the UI and
 * report surfaces instead walk the whole map — to seed the editor rows, to list
 * the years a scenario states, and to count them on the scenario card. Those
 * three walking it inline with only `perMember` guarded would throw a TypeError on an imported
 * `{ perMember: { "m-1": null } }` out of the modal seed, the
 * scenario card, the Report page and the PDF settings build. Routing them all
 * through this ONE reader keeps the shape guard from drifting the way four
 * hand-written copies would.
 *
 * Every level is shape-checked exactly as `readStoredCoverageMonths` checks it:
 * a non-object at any level contributes nothing rather than throwing.
 * `Object.entries` walks own enumerable keys only, so an inherited
 * `Object.prototype` member cannot appear as a stated entry.
 *
 * A year key that is not an integer inside the supported tax-year domain
 * is DROPPED. Keeping it (on the theory that a `NaN` year would sort last) is
 * unsound: `NaN` comparisons are false, so such an entry compares EQUAL to every
 * other and stays wherever it happens to land, after which the report would print
 * `"NaN"`, the modal would seed a year Select with a value the picker does not
 * offer, and the very next health save would discard the entry anyway (the save
 * path requires an integer year). No surface could ever act on the value, so
 * showing it only misrepresents what the projection charges.
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

/** The facts one member's health coverage for a year resolves from. */
export interface MemberHealthCoverageFacts {
  /** ISO birthdate (`YYYY-MM-DD`); empty / unparseable → no age, no Marketplace. */
  readonly isoBirthdate: string;
  readonly taxYear: number;
  /** True once the member has separated from service by this year. */
  readonly retired: boolean;
  /** True when the scenario marked the member as having OTHER coverage. */
  readonly optedOut: boolean;
  /** The stored month facts for this member/year, if any. */
  readonly stored?: StoredMemberCoverageMonths;
}

/** One member's fully resolved coverage for a year, as a `TaxMemberInput`
 *  fragment both engines spread verbatim. */
export interface ResolvedMemberHealthCoverage {
  readonly onMedicare: boolean;
  readonly hasAcaCoverage: boolean;
  readonly partBEnrollmentMonths: number;
  readonly partDEnrollmentMonths: number;
  readonly marketplaceCoverageMonths: number;
}

/**
 * THE shared health-coverage resolver. Both production engines
 * (`buildMemberInputs` in the deterministic runner and `buildYearMemberFlags`
 * in Monte Carlo) call this and nothing else, so the twin engines cannot drift
 * on Medicare timing, Marketplace eligibility, or the overlap rule.
 *
 * Resolution order:
 *  1. Automatic Medicare months from the birthday
 *     (`automaticMedicareMonthsInYear`) — the member's Medicare ENTITLEMENT.
 *  2. A stated Part B / Part D count WINS over the automatic one for that part
 *     (the parts are independent — a member may take one and decline the other).
 *  3. Automatic Marketplace months are the complement of the entitlement months
 *     for a retired, age-known, non-opted-out member; a stated count wins, even
 *     for an opted-out member (a stated count takes precedence over opt-out).
 *  4. §36B(c)(2)(B) — a month of Medicare is never a PTC coverage month, so the
 *     Marketplace count is capped at `12 − max(Part B, Part D, entitlement)`.
 *     The entitlement term matters because eligibility for Medicare Part A (or
 *     an Advantage plan) is itself minimum essential coverage: declining Part B
 *     does not restore PTC eligibility at 65+.
 *
 * `ageKnown` gates the Marketplace side: the rough benchmark prices a covered
 * member off their age, so a member whose birthdate is empty, malformed or an
 * impossible calendar date (`isUsableBirthdate`) is dropped from Marketplace
 * coverage rather than priced off a garbage age (an `NaN` age throws
 * `AcaPtcInvalidInputError` out of the engine). The same test gates the
 * automatic Medicare entitlement, so such a member is charged no Part B / Part D
 * months either; only STATED month counts survive, because those are recorded
 * enrolment facts that need no birthday at all.
 */
export function resolveMemberHealthCoverage(
  facts: MemberHealthCoverageFacts,
): ResolvedMemberHealthCoverage {
  const { isoBirthdate, taxYear, retired, optedOut, stored } = facts;
  // The SAME completeness test the entitlement derivation applies: a malformed
  // or impossible calendar date is no age at all, so the member is priced off
  // neither the Medicare clock nor the age-based Marketplace benchmark.
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

/** Treat a non-numeric stored month value as absent (imported data is not
 *  shape-validated beyond the envelope). */
function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Derive the primary member's current age from ISO birthdate and tax year.
 * Used for ACA benchmark age-based formula fallback.
 */
function ageInYear(isoBirthdate: string, taxYear: number): number {
  const birthYear = parseInt(isoBirthdate.slice(0, 4), 10);
  return taxYear - birthYear;
}
