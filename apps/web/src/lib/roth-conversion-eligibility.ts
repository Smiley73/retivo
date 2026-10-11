/**
 * Working-years Roth-conversion eligibility predicates.
 *
 * Single source of truth for source/target/pair validation shared by the
 * editor picker, save helpers, scenario resolver, and projection pre-pass.
 * Keep this module free of UI/React imports so it can be loaded in any
 * engine context.
 *
 * - `isConvertibleRothConversionSource`  — active, non-CBP, PRE_TAX or MIXED.
 * - `isWorkingYearsRothConversionTarget` — active, NON-INHERITED RETIREMENT_ROTH_IRA.
 * - `isSameAccountMixedInPlanConversion` — same id + active MIXED + Roth-designated.
 * - `isValidWorkingYearsRothConversionPair` — source is convertible, same owner,
 *    and target is a Roth IRA target OR a same-account in-plan conversion.
 *    Cross-owner pairs → false.
 * - `shouldCreditWorkingYearsConversionBasisSeparately` — true only for Roth
 *    IRA targets; false for same-account MIXED in-plan targets (no double-credit).
 */
import type { AccountPayload, AccountType } from '../db/types';
import { isRothDesignatedPostBucket } from './balance-calc';

/** Minimal account shape consumed by these predicates. Full `AccountPayload`
 *  satisfies this; callers may pass slimmer objects in tests. */
export interface AccountEligibilityPayload {
  readonly active: boolean;
  readonly taxTreatment: AccountPayload['taxTreatment'];
  readonly type: AccountType;
  readonly ownerId: string;
  /** The account is INHERITED (`AccountPayload.rmdInheritedAccount`).
   *  Absent → an owner account. Read by the target predicate only. */
  readonly rmdInheritedAccount?: boolean;
}

export interface AccountEligibilityRecord {
  readonly id: string;
  readonly payload: AccountEligibilityPayload;
}

/**
 * True when an account is a valid working-years Roth-conversion source:
 * active, NOT a cash-balance pension, and PRE_TAX or MIXED tax treatment.
 *
 * `RETIREMENT_CASH_BALANCE` is excluded: CBP value is projected via the
 * cash-balance formula + linked income streams, not as a sliceable balance.
 */
export function isConvertibleRothConversionSource(
  payload: AccountEligibilityPayload,
): boolean {
  if (!payload.active) return false;
  if (payload.type === 'RETIREMENT_CASH_BALANCE') return false;
  return payload.taxTreatment === 'PRE_TAX' || payload.taxTreatment === 'MIXED';
}

/**
 * True when an account is a valid working-years Roth-conversion target:
 * active, of type `RETIREMENT_ROTH_IRA`, and NOT inherited.
 *
 * An INHERITED Roth IRA cannot receive a conversion: §408A(e) admits a rollover
 * only from the individual's own plan, and a beneficiary may not roll into an
 * inherited IRA. Accepting one also credited the converted principal to the
 * BENEFICIARY's own §408A pool (`computePreRetirementRothConversions` keys the
 * basis map by owner id, and `mergeFactBasedRothIraSeeds` merges it into the
 * bare-owner pool key), so dollars deposited into the inherited account bought
 * tax-free basis on the owner's own Roth IRAs.
 */
export function isWorkingYearsRothConversionTarget(
  payload: AccountEligibilityPayload,
): boolean {
  if (payload.rmdInheritedAccount === true) return false;
  return payload.active && payload.type === 'RETIREMENT_ROTH_IRA';
}

/**
 * True when `source` and `target` are the SAME account (same id) AND the
 * account is an active MIXED Roth-designated employer-plan type (401k/403b/457b/TSP).
 *
 * Models a same-account in-plan Roth conversion: the pre-tax sub-bucket shrinks
 * and the Roth-designated post sub-bucket grows within one account.
 *
 * MIXED OTHER accounts are excluded: their post-tax sub-bucket is plain taxable
 * money, not Roth-designated.
 */
export function isSameAccountMixedInPlanConversion(
  source: AccountEligibilityRecord,
  target: AccountEligibilityRecord,
): boolean {
  if (source.id !== target.id) return false;
  const p = source.payload; // same object as target.payload when ids match
  if (!p.active) return false;
  if (p.taxTreatment !== 'MIXED') return false;
  return isRothDesignatedPostBucket(p.taxTreatment, p.type);
}

/**
 * True when `source` + `target` form a valid working-years Roth-conversion
 * pair: source is convertible, both accounts share an owner (`ownerId`), and
 * target is a Roth IRA target OR a same-account MIXED in-plan conversion.
 *
 * Cross-owner pairs → false. IRC §408A is per-individual; converting one
 * spouse's pre-tax money into the other's Roth is not a valid rollover.
 */
export function isValidWorkingYearsRothConversionPair(
  source: AccountEligibilityRecord,
  target: AccountEligibilityRecord,
): boolean {
  if (!isConvertibleRothConversionSource(source.payload)) return false;
  if (source.payload.ownerId !== target.payload.ownerId) return false;
  return (
    isWorkingYearsRothConversionTarget(target.payload) ||
    isSameAccountMixedInPlanConversion(source, target)
  );
}

/**
 * True when a same-account MIXED in-plan conversion target should credit
 * `preRetirementConversionBasisCentsByOwner` separately — i.e., ONLY for Roth
 * IRA targets.
 *
 * Same-account MIXED in-plan targets must NOT credit `preRetirementConversionBasisCentsByOwner`
 * (they use a separate deterministic-only carrier). Crediting both would double-shield the same
 * dollars.
 *
 * Instead, callers accumulate the converted amount into `mixedInPlanBasisCentsByOwner` (the
 * `PreRetirementRothConversionResult` field), which is stored at context-build time in
 * `PipelineContext.mixedInPlanConversionBasisCentsByOwner` — kept separate from the
 * fact-mirroring `mixedRothDesignatedBasisCentsByOwner` (see `roth-conversion-projection.ts`).
 */
export function shouldCreditWorkingYearsConversionBasisSeparately(
  target: AccountEligibilityRecord,
): boolean {
  return target.payload.type === 'RETIREMENT_ROTH_IRA';
}
