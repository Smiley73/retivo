/**
 * Splits a linked Cash Balance Pension lump-sum rollover in or after the owner's RMD trigger year: that
 * year's RMD is not rollover-eligible, so it comes out first. Plain pension lump-sums are not split
 * (their gross/net semantics are undefined).
 */
import type { CalibrationSnapshot } from './calibration';
import {
  computeRmd,
  rmdTriggerAge,
  type AccountTaxTreatment,
  type RmdTable,
} from './rmd';

/** Arguments to {@link splitRolloverByRmd}; dollar amounts are integer cents. */
export interface SplitRolloverByRmdArgs {
  readonly basisCents: number;
  /** Source-account owner's ISO `YYYY-MM-DD` birthdate; `null`/`undefined` gives `rmdPortionCents = 0`. */
  readonly ownerBirthdate: string | null | undefined;
  readonly eventYear: number;
  readonly sourceTaxTreatment: AccountTaxTreatment;
  /** Roth-designated portion of a MIXED source, so the engine does not over-distribute (SECURE 2.0 §325). */
  readonly rothPortionCents?: number;
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
}

/** `rmdPortionCents + rolloverExcessCents === basisCents`, in integer cents. */
export interface SplitRolloverByRmdResult {
  readonly rmdPortionCents: number;
  readonly rolloverExcessCents: number;
}

/**
 * `rmdPortionCents` is 0 (the whole amount rolls) on a missing or unparseable birthdate (never throws),
 * an event year before the trigger year, or a source with no RMD; otherwise `min(ownerRmdCents, basisCents)`.
 *
 * Approximation: the CBP is modeled as a defined-contribution-equivalent account, so the RMD uses the
 * Uniform Lifetime Method (IRS Pub. 590-B Appendix B Table III); a true defined-benefit plan follows
 * annuity rules (IRS FAQ Q15, Pub. 590-B) and would need plan-provided RMD amounts.
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
    return noSplit;
  }
  const birthYear = Number(ownerBirthdate.slice(0, 4));
  if (!Number.isFinite(birthYear) || birthYear <= 0) return noSplit;
  // Before the trigger-age year there is no RMD to carve.
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
            // rothPortionCents is valid only with a Roth pocket (computeRmd throws on PRE_TAX / HSA).
            ...(sourceTaxTreatment === 'MIXED' && args.rothPortionCents !== undefined
              ? { rothPortionCents: args.rothPortionCents }
              : {}),
          },
        ],
      },
      args.rmdSnapshot,
    );
  } catch {
    // A malformed birthdate that passed the prefix check falls back to no split.
    return noSplit;
  }

  if (!rmdResult.applicable || rmdResult.ownerRmdCents <= 0) return noSplit;
  const rmdPortionCents = Math.min(rmdResult.ownerRmdCents, basisCents);
  return {
    rmdPortionCents,
    rolloverExcessCents: Math.max(0, basisCents - rmdPortionCents),
  };
}
