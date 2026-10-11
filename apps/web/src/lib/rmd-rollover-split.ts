/**
 * Shared pure split site for a linked Cash Balance Pension (CBP) lump-sum
 * rollover that lands in or after the source-account owner's RMD trigger year.
 *
 * IRS rule: a Required Minimum Distribution for a distribution year is NOT
 * rollover-eligible. So when a linked-CBP lump-sum is rolled in/after the
 * owner's RMD trigger-age year, that year's RMD must come out first (taxable
 * ordinary income) and only the excess rolls into the target's pre-tax bucket.
 *
 * This is the SINGLE split site: the deterministic seam
 * (`collectPostRetirementCbpLumpSumDeposits`) and the Monte Carlo event builder
 * both call it so cross-engine parity is structural, not test-only. All
 * arithmetic is in integer cents (`computeRmd` returns cents) so the two engines
 * agree to the cent.
 *
 * Plain (non-linked-CBP) pension lump-sums are NOT split here — the user-typed
 * `lumpSumAmount` has undefined gross/net/post-RMD semantics, so an RMD on it
 * could invent or double-count tax (a known limitation).
 */
import type { CalibrationSnapshot } from './calibration';
import {
  computeRmd,
  rmdTriggerAge,
  type AccountTaxTreatment,
  type RmdTable,
} from './rmd';

/** Arguments to {@link splitRolloverByRmd}. All dollar amounts in integer cents. */
export interface SplitRolloverByRmdArgs {
  /** The rolled lump-sum basis in integer cents. For a linked-CBP rollover this
   *  IS the rolled amount (= the source CBP projected balance in cents), so the
   *  split is self-consistent. */
  readonly basisCents: number;
  /** Source-account owner's ISO `YYYY-MM-DD` birthdate, or `null`/`undefined`
   *  on an owner-meta / birthdate miss (→ `rmdPortionCents = 0`). */
  readonly ownerBirthdate: string | null | undefined;
  /** Calendar year the rollover event occurs. */
  readonly eventYear: number;
  /** Tax treatment of the real source CBP account (PRE_TAX or MIXED). */
  readonly sourceTaxTreatment: AccountTaxTreatment;
  /** For a MIXED source CBP, the Roth-designated portion in integer cents so
   *  the engine does not over-distribute (SECURE 2.0 §325). Ignored on a
   *  PRE_TAX source. */
  readonly rothPortionCents?: number;
  /** The run's RMD calibration snapshot (no hard-coded trigger ages / divisors). */
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
}

/** Result of {@link splitRolloverByRmd}. Both fields in integer cents;
 *  `rmdPortionCents + rolloverExcessCents === basisCents`. */
export interface SplitRolloverByRmdResult {
  /** RMD carved out of the rollover (taxable ordinary income, distributed). */
  readonly rmdPortionCents: number;
  /** Remainder that rolls into the target's pre-tax bucket (not a taxable event). */
  readonly rolloverExcessCents: number;
}

/**
 * Carve the rollover-year RMD out of a linked-CBP lump-sum.
 *
 * Returns `rmdPortionCents = 0` (whole amount rolls) when:
 *  - the owner birthdate is missing/unparseable (never throws),
 *  - the event year is before the owner's RMD trigger-age year (no RMD),
 *  - the source account is not RMD-qualifying / has no pre-tax balance.
 *
 * Otherwise `rmdPortionCents = min(ownerRmdCents, basisCents)` (clamped to the
 * basis so the excess is never negative) and
 * `rolloverExcessCents = basisCents − rmdPortionCents`.
 *
 * Approximation: the Cash Balance Pension (CBP) is modeled as a
 * defined-contribution-EQUIVALENT account, so the carved RMD uses the Uniform
 * Lifetime Method (IRS Pub. 590-B Appendix B Table III) via `computeRmd` — the
 * same account-balance-÷-divisor math the rest of the engine uses. IRS FAQ Q15
 * and Pub. 590-B note that a true DEFINED-BENEFIT plan's RMD is ordinarily
 * determined by the plan's annuity-payment rules, NOT an account-balance
 * divisor. This approximation is accepted for plans structured as
 * defined-contribution-equivalent (the only CBP shape this app models); a plan
 * following true DB-plan annuity rules would require plan-provided RMD amounts.
 */
export function splitRolloverByRmd(
  args: SplitRolloverByRmdArgs,
): SplitRolloverByRmdResult {
  const { basisCents, ownerBirthdate, eventYear, sourceTaxTreatment } = args;
  const noSplit: SplitRolloverByRmdResult = {
    rmdPortionCents: 0,
    rolloverExcessCents: Math.max(0, basisCents),
  };
  if (basisCents <= 0) return noSplit;
  if (typeof ownerBirthdate !== 'string' || ownerBirthdate.length === 0) {
    // Owner-meta / birthdate miss → whole amount rolls, never throw.
    return noSplit;
  }
  const birthYear = Number(ownerBirthdate.slice(0, 4));
  if (!Number.isFinite(birthYear) || birthYear <= 0) return noSplit;
  // Pre-trigger-age fast path: the rollover year is before the owner's RMD
  // trigger year, so there is no RMD to carve (avoids computeRmd on an
  // unparseable-but-not-empty birthdate too, since the YYYY prefix is valid).
  if (eventYear < birthYear + rmdTriggerAge(birthYear)) return noSplit;

  let rmdResult;
  try {
    rmdResult = computeRmd(
      {
        isoBirthdate: ownerBirthdate,
        taxYear: eventYear,
        accounts: [
          {
            id: 'rmd-rollover-source-cbp',
            balanceDec31PriorYearCents: basisCents,
            accountType: 'RETIREMENT_CASH_BALANCE',
            taxTreatment: sourceTaxTreatment,
            // A CBP source is PRE_TAX or MIXED, and `rothPortionCents` is
            // meaningful only where a Roth-designated pocket exists (computeRmd
            // throws on PRE_TAX / HSA); only pass it through on a MIXED source.
            ...(sourceTaxTreatment === 'MIXED' && args.rothPortionCents !== undefined
              ? { rothPortionCents: args.rothPortionCents }
              : {}),
          },
        ],
      },
      args.rmdSnapshot,
    );
  } catch {
    // Any malformed-input throw (e.g. an out-of-range calendar birthdate that
    // slipped the prefix check) falls back to the no-split, never-throw contract.
    return noSplit;
  }

  if (!rmdResult.applicable || rmdResult.ownerRmdCents <= 0) return noSplit;
  const rmdPortionCents = Math.min(rmdResult.ownerRmdCents, basisCents);
  return {
    rmdPortionCents,
    rolloverExcessCents: Math.max(0, basisCents - rmdPortionCents),
  };
}
