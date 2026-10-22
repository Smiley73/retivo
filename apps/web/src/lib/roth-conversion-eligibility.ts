/**
 * Working-years Roth-conversion eligibility predicates: the one source of truth for source, target and pair
 * validation shared by the editor, save helpers, scenario resolver and projection pre-pass. UI-free.
 */
import type { AccountPayload, AccountType } from '../db/types';
import { isRothDesignatedPostBucket } from './balance-calc';

/** Minimal account shape the predicates read. */
export interface AccountEligibilityPayload {
  readonly active: boolean;
  readonly taxTreatment: AccountPayload['taxTreatment'];
  readonly type: AccountType;
  readonly ownerId: string;
  /** Inherited account (`AccountPayload.rmdInheritedAccount`); absent means an owner account. */
  readonly rmdInheritedAccount?: boolean;
}

export interface AccountEligibilityRecord {
  readonly id: string;
  readonly payload: AccountEligibilityPayload;
}

/**
 * Valid source: active, PRE_TAX or MIXED, and not a cash-balance pension (its value is projected by the
 * cash-balance formula and linked income streams, not as a sliceable balance).
 */
export function isConvertibleRothConversionSource(
  payload: AccountEligibilityPayload,
): boolean {
  if (!payload.active) return false;
  if (payload.type === 'RETIREMENT_CASH_BALANCE') return false;
  return payload.taxTreatment === 'PRE_TAX' || payload.taxTreatment === 'MIXED';
}

/**
 * Valid target: an active, non-inherited `RETIREMENT_ROTH_IRA`. §408A(e) admits a rollover only from the
 * individual's own plan, and accepting an inherited one would credit the converted principal to the
 * beneficiary's own §408A pool (keyed by owner id), buying tax-free basis on the owner's own Roth IRAs.
 */
export function isWorkingYearsRothConversionTarget(
  payload: AccountEligibilityPayload,
): boolean {
  if (payload.rmdInheritedAccount === true) return false;
  return payload.active && payload.type === 'RETIREMENT_ROTH_IRA';
}

/**
 * Same account (same id) that is an active MIXED Roth-designated employer-plan type (401k/403b/457b/TSP): an
 * in-plan conversion moving pre-tax to the Roth-designated sub-bucket. MIXED OTHER is excluded because its
 * post-tax sub-bucket is plain taxable money.
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
 * Valid pair: convertible source, same owner, and a Roth IRA target or a same-account in-plan conversion.
 * IRC §408A is per-individual, so cross-owner pairs are invalid.
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
 * True only for Roth IRA targets: a same-account MIXED in-plan target must not credit
 * `preRetirementConversionBasisCentsByOwner` (callers use `mixedInPlanBasisCentsByOwner`, a separate
 * deterministic-only carrier), or the same dollars would be double-shielded.
 */
export function shouldCreditWorkingYearsConversionBasisSeparately(
  target: AccountEligibilityRecord,
): boolean {
  return target.payload.type === 'RETIREMENT_ROTH_IRA';
}
