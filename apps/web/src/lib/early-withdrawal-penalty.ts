/**
 * Early-withdrawal / HSA additional-tax engine.
 *
 * Models two IRS additional taxes on early distributions:
 *   - IRA / 401k-style 10% additional tax on taxable distributions before age
 *     59½ (IRC §72(t)).
 *   - HSA 20% additional tax on nonqualified distributions before age 65
 *     (IRC §223(f)(4)).
 *
 * Roth conversion exclusion: a Fill-mode pre-tax → Roth conversion
 * is NOT a distribution, so it incurs ordinary income tax but $0 §72(t) penalty
 * even before 59½. This engine only ever sees the dollars the caller routes in
 * as `penaltyBasisDollars`; the conversion is deliberately never added to the
 * per-year `penaltyAccounts` (it is recognized as ordinary income through a
 * separate channel), so it is structurally excluded here with no special case.
 *
 * Both are pro-rated in the transition year using the exact half-birthday
 * (59½ / 65) date the `retirementDate` helper computes, with the penalty
 * fraction `(halfMonth - 1) / 12` (0 = fully penalty-free year, 1 = fully
 * penalized). MIXED-treatment accounts apply the 10% only to the
 * pre-tax (includible-in-gross-income) tranche per IRC §72(t). For
 * MIXED Roth-designated types (401k/403b/457b/TSP), the post sub-bucket is
 * Roth-designated: any earnings portion above the owner's §408A basis is
 * penalized via the basis-ordering path in the projection engines,
 * not directly by this function — this function receives only the
 * pre-tax-tranche `penaltyBasisDollars`, as for any other MIXED account.
 * Scenario-marked exempt accounts skip the penalty. A missing or
 * unparseable owner birthdate skips the penalty and is flagged to the caller.
 *
 * Account eligibility by AccountType:
 *   RETIREMENT_401K / IRA / 403B / TSP / CASH_BALANCE → 10% before 59½
 *   RETIREMENT_457B  → none (governmental exception)
 *   RETIREMENT_ROTH_IRA → 10% before 59½ on the §408A ADDITIONAL-TAX BASE. That
 *     base is FACT-BASED: `roth-distribution-tax.ts` consumes the owner's
 *     recorded regular-contribution basis first, then conversion lots FIFO
 *     (aggregated by tax year), then earnings — and the base it hands this engine
 *     is nonqualified earnings PLUS taxable converted principal still inside its
 *     OWN five-tax-year recapture window. Regular contributions and nontaxable
 *     converted principal never reach here. Exemption waives only the 10% leg;
 *     the ordinary-income tax on the earnings (routed upstream) still applies.
 *   RETIREMENT_ROTH_401K / ROTH_403B / ROTH_TSP → 10% before 59½ on the
 *     designated-Roth additional-tax base. The basis/earnings
 *     split is PRO RATA per §402A(d)(4) against the account's own recorded basis
 *     (NOT contribution-first, and no longer "the whole at-retirement balance is
 *     basis"), plus any in-window taxable in-plan Roth rollover recapture
 *     (§402A(c)(4)(D)).
 *   RETIREMENT_ROTH_457B → governmental §72(t)(9) exception: ordinary Roth 457(b)
 *     earnings carry NO 10%, same as the traditional 457(b). The exception does
 *     NOT reach amounts attributable to a rollover from a different plan type, so
 *     the ordering engine keeps that recapture in the base and marks it
 *     `rothOrderedAdditionalTaxBase` — see that field for why the type test is
 *     bypassed for such a pre-resolved base.
 *   BROKERAGE / SAVINGS / MONEY_MARKET / CD / OTHER → none
 *   HSA → 20% before 65 (different rate + threshold)
 *   ANY inherited account (`inheritedFromDeceasedOwner`) → NO 10% leg at any
 *     beneficiary age (IRC §72(t)(2)(A)(ii) death exception).
 */

import type { AccountType } from '../db/types';
import { retirementDate } from './retirement-date-math';

/** 10% IRC §72(t) additional tax rate. */
export const EARLY_WITHDRAWAL_PENALTY_RATE = 0.1;
/** 20% IRC §223(f)(4) HSA additional tax rate. */
export const HSA_ADDITIONAL_TAX_RATE = 0.2;

/** Per-account withdrawal input for the penalty computation. */
export interface PenaltyAccountInput {
  readonly id: string;
  readonly type: AccountType;
  /**
   * Includible-in-gross-income (pre-tax) withdrawal dollars this year. For
   * PRE_TAX accounts this is the whole withdrawal; for MIXED accounts it is
   * the pre-tax tranche only (the post-tax basis tranche carries no penalty).
   * For HSA accounts this is the nonqualified portion of the EMERGENCY
   * draw only (the caller narrows the basis to `emergencyDollars × (1 − pct/100)`
   * — medical-qualified HSA dollars carry $0 penalty); the 20% rate + the
   * age-65 proration (`penaltyFractionForYear`, cutoff 65y0m) apply to that
   * narrowed basis. For Roth accounts (fact-based) this is
   * the §408A/§402A **additional-tax base** — nonqualified earnings PLUS taxable
   * converted / in-plan-rolled-over principal still inside its own five-tax-year
   * recapture window — already split by the ordering engine in the projection
   * engines; recovered contribution basis and nontaxable converted principal are
   * excluded here so they stay penalty-free.
   */
  readonly penaltyBasisDollars: number;
  /** Owner member's ISO birthdate (YYYY-MM-DD). Drives the age cutoff. */
  readonly ownerBirthdate: string | null | undefined;
  /**
   * `true` when `penaltyBasisDollars` is a §408A/§402A **additional-tax
   * base** already produced by the fact-based Roth ordering engine
   * (`roth-distribution-tax.ts`), i.e. nonqualified earnings PLUS taxable
   * conversion / in-plan-rollover principal still inside its own five-tax-year
   * recapture window.
   *
   * That engine has ALREADY applied every source-level statutory exemption —
   * notably the governmental-457(b) §72(t)(9) carve-out, which exempts ordinary
   * Roth 457(b) earnings but NOT amounts attributable to a rollover from a
   * different plan type. Re-testing the account type here would therefore DROP a
   * legitimate 457(b) rollover recapture, so this flag suppresses the
   * `PENALTY_10_TYPES` membership test only. Everything else is unchanged: the
   * scenario-marked exempt-account-id skip still waives the leg, and the 59½
   * half-birthday proration still applies.
   */
  readonly rothOrderedAdditionalTaxBase?: boolean;
  /**
   * `true` when this distribution comes from an INHERITED account, i.e. it
   * is made on account of the ORIGINAL owner's death.
   *
   * IRC §72(t)(2)(A)(ii) exempts a distribution made on account of the employee's /
   * IRA owner's death from the 10% additional tax REGARDLESS of the beneficiary's
   * own age. Applying the beneficiary's 59½ test to an inherited distribution — as
   * this engine once did — charged a 10% additional tax the statute does not
   * impose, on money a beneficiary is in fact REQUIRED to withdraw. The exception
   * waives the 10% §72(t) leg only; the ordinary income tax on the taxable portion
   * (routed upstream) is unaffected, as is the HSA 20% leg (an inherited HSA's
   * different §223(f)(8) treatment is not modeled).
   */
  readonly inheritedFromDeceasedOwner?: boolean;
}

/** Result of the per-year penalty computation. */
export interface PenaltyResult {
  /** Total early-distribution additional tax for the year, in dollars. */
  readonly penaltyDollars: number;
  /** Portion attributable to the IRA/401k-style 10% penalty, in dollars. */
  readonly ira401kPenaltyDollars: number;
  /** Portion attributable to the HSA 20% additional tax, in dollars. */
  readonly hsaAdditionalTaxDollars: number;
  /** True when at least one penalizable account had an unparseable/missing
   *  birthdate, so its penalty was skipped (caller flags an estimate note). */
  readonly skippedForMissingBirthdate: boolean;
}

/**
 * AccountTypes that carry the 10% §72(t) penalty before 59½.
 * The four designated-Roth employer-plan types are split: 401K/403B/TSP carry
 * the 10% (same as their pre-tax counterparts); 457B is exempt (governmental
 * §72(t) exception). `RETIREMENT_ROTH_IRA` is deliberately NOT in this set —
 * Roth IRA earnings are handled via the dedicated `isRothIra` branch below,
 * which keeps the contribution tranche penalty-free; only the earnings excess
 * above the owner's §408A basis is penalized.
 */
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

/** True when this AccountType is subject to the 10% pre-59½ penalty. */
export function carriesTenPercentPenalty(type: AccountType): boolean {
  return PENALTY_10_TYPES.has(type);
}

/**
 * Penalty fraction for a year given the owner's birthdate and the half-birthday
 * age cutoff (ageYears + ageMonths). Returns:
 *   - 1 for years entirely before the cutoff (fully penalized),
 *   - 0 for years entirely at/after the cutoff (penalty-free),
 *   - `(cutoffMonth0) / 12`-style proration in the transition year: the share
 *     of the year (in whole months) that falls BEFORE the cutoff month.
 *     The transition-year fraction is `(halfMonth - 1) / 12` where `halfMonth`
 *     is the 1-based calendar month the owner reaches the cutoff age.
 *
 * Returns `null` when the birthdate is missing or unparseable (caller skips).
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
  // Transition year: months before the cutoff month are penalized.
  // halfMonth = cutoffMonth1 (1-based); fraction = (halfMonth - 1) / 12.
  return (cutoffMonth1 - 1) / 12;
}

/**
 * Compute the early-distribution additional tax for one projection year.
 *
 * @param accounts  Per-account penalty inputs (pre-tax/nonqualified basis).
 * @param taxYear   Calendar year.
 * @param exemptAccountIds  Scenario-marked exempt account ids (skip penalty).
 */
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

    // Roth IRA earnings tranche. The owner-level tracker already split
    // off the tax/penalty-free §408A contribution basis upstream, so
    // `penaltyBasisDollars` here is the pre-59½ earnings excess. It carries the
    // same 10% §72(t) additional tax at the 59½ cutoff. `RETIREMENT_ROTH_IRA`
    // is deliberately NOT in `PENALTY_10_TYPES` (that set must stay
    // contribution-penalty-free); this dedicated branch keeps the contribution
    // tranche untouched. The exempt-id skip at the top of the loop already
    // waived the penalty for an exempt Roth IRA (the income tax on the earnings
    // is routed separately by the engine and is unaffected by the exemption).
    // A §408A/§402A-ordered additional-tax base arrives exemption-resolved
    // (the ordering engine already applied the governmental-457(b) carve-out and
    // kept only the genuinely penalizable rollover recapture), so the type test
    // is skipped for it — see `rothOrderedAdditionalTaxBase`.
    const isRothIra = acc.type === 'RETIREMENT_ROTH_IRA';
    if (
      acc.rothOrderedAdditionalTaxBase !== true &&
      !carriesTenPercentPenalty(acc.type) &&
      !isRothIra
    ) {
      continue;
    }

    // §72(t)(2)(A)(ii): a distribution made on account of the original owner's
    // DEATH carries no 10% additional tax at ANY beneficiary age. Checked before
    // the age proration so an inherited account never consumes the 59½ test (and
    // never trips `skippedForMissingBirthdate` — the beneficiary's birthdate is
    // irrelevant to it).
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
