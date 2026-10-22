/**
 * Qualified Charitable Distribution math: the 70½ first-eligible-year gate and the per-owner-year cap,
 * RMD offset and income exclusion. Pure; the indexed limit comes from qcd-limits.ts.
 */

/** IRS §408(d)(8) per-person annual QCD exclusion limit for one year in whole dollars, indexed by SECURE 2.0 §307. */
export interface QcdLimits {
  readonly annualLimitDollars: number;
}

/**
 * One resolved QCD entry for an owner-year; `annualAmountDollars` is in today's dollars and the engine
 * inflates it before the cap. Entries are pre-sorted by the caller (start year, then accountId).
 */
export interface QcdEntryForOwnerYear {
  readonly sourceAccountId: string;
  readonly annualAmountDollars: number;
}

export interface ComputeQcdParams {
  readonly entries: readonly QcdEntryForOwnerYear[];
  readonly year: number;
  readonly inflationFactor: number;
  readonly sourceBalancesPreTaxCents: ReadonlyMap<string, number>;
  /** This owner's gross IRA-pool RMD, integer cents; 0 below the RMD trigger age. */
  readonly grossIraPoolRmdCents: number;
  readonly qcdLimitCentsForYear: number;
}

interface PerEntryQcd {
  readonly entryIndex: number;
  readonly qcdCents: number;
}

export interface ComputeQcdResult {
  readonly perEntry: readonly PerEntryQcd[];
  readonly totalQcdCents: number;
  /** Amount that offsets the owner's IRA-pool RMD: `min(total, grossRMD)`. */
  readonly rmdOffsetCents: number;
  /** Amount excluded from ordinary income / MAGI: the full QCD total. */
  readonly incomeExclusionCents: number;
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * First tax year a member is QCD-eligible: the calendar year containing `birthdate + 70 years + 6
 * calendar months`. A precise half-year test, unlike the engine-wide Dec-31 age convention, because a
 * QCD is legal from the day the donor turns 70½.
 *
 * Examples: born 1954-01-15 gives 2024; born 1954-07-01 gives 2025.
 *
 * @throws {Error} when `isoBirthdate` is not a valid `YYYY-MM-DD` date.
 */
export function qcdFirstEligibleTaxYear(isoBirthdate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoBirthdate);
  if (!match) {
    throw new Error(
      `qcdFirstEligibleTaxYear: isoBirthdate "${isoBirthdate}" is not a valid YYYY-MM-DD date`,
    );
  }
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]); // 1-based
  const birthDay = Number(match[3]);

  if (birthMonth < 1 || birthMonth > 12) {
    throw new Error(
      `qcdFirstEligibleTaxYear: isoBirthdate "${isoBirthdate}" has an invalid month`,
    );
  }
  // `new Date(year, month, 0)` with a 1-based month gives that month's day count.
  const daysInMonth = new Date(birthYear, birthMonth, 0).getDate();
  if (birthDay < 1 || birthDay > daysInMonth) {
    throw new Error(
      `qcdFirstEligibleTaxYear: isoBirthdate "${isoBirthdate}" has an invalid day`,
    );
  }

  // Add 70 years and 6 months; `birthMonth + 6` may pass December, so carry into the next year.
  const monthIndexFromYearStart = birthMonth - 1 + 6; // 0-based, may exceed 11
  const eligibleYear = birthYear + 70 + Math.floor(monthIndexFromYearStart / 12);
  return eligibleYear;
}

/**
 * Per entry, in the caller's order: inflate the real amount to nominal cents, cap at `min(inflated,
 * remaining per-person §408(d)(8) limit, source IRA pre-tax balance)`, and draw the limit down so it is
 * consumed once across the member's entries.
 */
export function computeQcdForOwnerYear(
  params: ComputeQcdParams,
): ComputeQcdResult {
  const {
    entries,
    inflationFactor,
    sourceBalancesPreTaxCents,
    grossIraPoolRmdCents,
    qcdLimitCentsForYear,
  } = params;

  let remainingLimitCents = Math.max(0, qcdLimitCentsForYear);
  // Local copy so same-source entries deplete each other.
  const remainingSourceCents = new Map<string, number>(
    sourceBalancesPreTaxCents,
  );
  const perEntry: PerEntryQcd[] = [];
  let totalQcdCents = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const inflatedAmountCents = Math.max(
      0,
      dollarsToCents(entry.annualAmountDollars * inflationFactor),
    );
    const availableCents = Math.max(
      0,
      remainingSourceCents.get(entry.sourceAccountId) ?? 0,
    );
    const qCents = Math.max(
      0,
      Math.min(inflatedAmountCents, remainingLimitCents, availableCents),
    );
    remainingLimitCents -= qCents;
    remainingSourceCents.set(
      entry.sourceAccountId,
      (remainingSourceCents.get(entry.sourceAccountId) ?? 0) - qCents,
    );
    totalQcdCents += qCents;
    perEntry.push({ entryIndex: i, qcdCents: qCents });
  }

  const rmdOffsetCents = Math.min(
    totalQcdCents,
    Math.max(0, grossIraPoolRmdCents),
  );

  return {
    perEntry,
    totalQcdCents,
    rmdOffsetCents,
    incomeExclusionCents: totalQcdCents,
  };
}
