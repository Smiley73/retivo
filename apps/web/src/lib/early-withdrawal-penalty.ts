/**
 * Early-withdrawal additional tax: 10% before 59½ (IRC §72(t)) and 20% on nonqualified HSA
 * distributions before 65 (IRC §223(f)(4)), pro-rated in the transition year. A Roth conversion never reaches it.
 */

import type { AccountType } from '../db/types';
import { retirementDate } from './retirement-date-math';

/** 10% IRC §72(t) additional tax rate. */
export const EARLY_WITHDRAWAL_PENALTY_RATE = 0.1;
/** 20% IRC §223(f)(4) HSA additional tax rate. */
export const HSA_ADDITIONAL_TAX_RATE = 0.2;

export interface PenaltyAccountInput {
  readonly id: string;
  readonly type: AccountType;
  readonly penaltyBasisDollars: number;
  readonly ownerBirthdate: string | null | undefined;
  /**
   * True when `penaltyBasisDollars` is a §408A/§402A additional-tax base the Roth ordering engine already
   * exemption-resolved (e.g. the governmental-457(b) §72(t)(9) carve-out, which does not cover rollover
   * recapture); suppresses only the `PENALTY_10_TYPES` test.
   */
  readonly rothOrderedAdditionalTaxBase?: boolean;
  /**
   * True for a distribution from an inherited account: made on account of the original owner's death, so
   * IRC §72(t)(2)(A)(ii) waives the 10% leg at any beneficiary age. The HSA 20% leg is unaffected (an
   * inherited HSA's §223(f)(8) treatment is not modeled).
   */
  readonly inheritedFromDeceasedOwner?: boolean;
}

export interface PenaltyResult {
  readonly penaltyDollars: number;
  readonly ira401kPenaltyDollars: number;
  readonly hsaAdditionalTaxDollars: number;
  /** True when a penalizable account had a missing or unparseable birthdate, so its penalty was skipped. */
  readonly skippedForMissingBirthdate: boolean;
}

// Account eligibility by AccountType:
//   401K / IRA / 403B / TSP / CASH_BALANCE            → 10% before 59½ (MIXED: pre-tax tranche only)
//   ROTH_401K / ROTH_403B / ROTH_TSP                  → 10% before 59½ on the designated-Roth additional-tax
//     base: pro rata basis/earnings split per §402A(d)(4), plus in-window taxable in-plan rollover
//     recapture (§402A(c)(4)(D))
//   ROTH_IRA                                          → 10% before 59½ on the §408A additional-tax base:
//     nonqualified earnings plus taxable converted principal inside its own five-tax-year recapture
//     window (roth-distribution-tax.ts orders basis, then conversion lots FIFO, then earnings)
//   457B                                              → none (governmental exception)
//   ROTH_457B                                         → none on ordinary earnings (governmental §72(t)(9));
//     rollover amounts from another plan type stay in the base, flagged `rothOrderedAdditionalTaxBase`
//   BROKERAGE / SAVINGS / MONEY_MARKET / CD / OTHER   → none
//   HSA                                               → 20% before 65
//   inherited (`inheritedFromDeceasedOwner`)          → no 10% at any age (IRC §72(t)(2)(A)(ii))
const PENALTY_10_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_IRA',
  'RETIREMENT_403B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_TSP',
]);

/** True when the AccountType is subject to the 10% pre-59½ penalty. */
export function carriesTenPercentPenalty(type: AccountType): boolean {
  return PENALTY_10_TYPES.has(type);
}

/**
 * Penalty fraction for a year: 1 before the cutoff year, 0 after it, and `(halfMonth - 1) / 12` in the
 * transition year, where `halfMonth` is the 1-based month the owner reaches the cutoff age. `null` when
 * the birthdate is missing or unparseable.
 */
export function penaltyFractionForYear(
  ownerBirthdate: string | null | undefined,
  taxYear: number,
  cutoffAge: { ageYears: number; ageMonths: number },
): number | null {
  if (!ownerBirthdate) return null;
  let cutoffIso: string;
  try {
    cutoffIso = retirementDate(ownerBirthdate, cutoffAge);
  } catch {
    return null;
  }
  const cutoffYear = Number(cutoffIso.slice(0, 4));
  const cutoffMonth1 = Number(cutoffIso.slice(5, 7)); // 1-based
  if (!Number.isFinite(cutoffYear) || !Number.isFinite(cutoffMonth1)) return null;

  if (taxYear < cutoffYear) return 1; // whole year before the cutoff
  if (taxYear > cutoffYear) return 0; // whole year at/after the cutoff
  return (cutoffMonth1 - 1) / 12;
}

/** Early-distribution additional tax for one projection year; `exemptAccountIds` are scenario-marked exempt accounts. */
export function computeEarlyWithdrawalPenalty(
  accounts: readonly PenaltyAccountInput[],
  taxYear: number,
  exemptAccountIds: readonly string[],
): PenaltyResult {
  const exempt = new Set(exemptAccountIds);
  let ira401kPenaltyDollars = 0;
  let hsaAdditionalTaxDollars = 0;
  let skippedForMissingBirthdate = false;

  for (const acc of accounts) {
    if (acc.penaltyBasisDollars <= 0) continue;
    if (exempt.has(acc.id)) continue;

    if (acc.type === 'HSA') {
      const fraction = penaltyFractionForYear(acc.ownerBirthdate, taxYear, {
        ageYears: 65,
        ageMonths: 0,
      });
      if (fraction === null) {
        skippedForMissingBirthdate = true;
        continue;
      }
      hsaAdditionalTaxDollars += acc.penaltyBasisDollars * HSA_ADDITIONAL_TAX_RATE * fraction;
      continue;
    }

    // Roth IRA earnings tranche: the owner-level tracker already split off the penalty-free §408A
    // contribution basis, so `penaltyBasisDollars` is the earnings excess. It is not in `PENALTY_10_TYPES`,
    // which would exempt the contribution tranche. An ordering-engine base arrives exemption-resolved
    // (`rothOrderedAdditionalTaxBase`), so the type test is skipped for it.
    const isRothIra = acc.type === 'RETIREMENT_ROTH_IRA';
    if (
      acc.rothOrderedAdditionalTaxBase !== true &&
      !carriesTenPercentPenalty(acc.type) &&
      !isRothIra
    ) {
      continue;
    }

    // §72(t)(2)(A)(ii): checked before the age proration so an inherited account never trips
    // `skippedForMissingBirthdate`.
    if (acc.inheritedFromDeceasedOwner === true) continue;

    const fraction = penaltyFractionForYear(acc.ownerBirthdate, taxYear, {
      ageYears: 59,
      ageMonths: 6,
    });
    if (fraction === null) {
      skippedForMissingBirthdate = true;
      continue;
    }
    ira401kPenaltyDollars += acc.penaltyBasisDollars * EARLY_WITHDRAWAL_PENALTY_RATE * fraction;
  }

  return {
    penaltyDollars: ira401kPenaltyDollars + hsaAdditionalTaxDollars,
    ira401kPenaltyDollars,
    hsaAdditionalTaxDollars,
    skippedForMissingBirthdate,
  };
}
