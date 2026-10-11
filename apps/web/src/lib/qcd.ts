/**
 * Pure-function Qualified Charitable Distribution (QCD) math.
 *
 * Covers: the precise 70½ first-eligible-tax-year gate (the only half-year date
 * test in the feature), and the per-owner-year QCD computation that
 * caps each entry at `min(inflated amount, remaining per-person limit, source
 * IRA available pre-tax balance)` in integer cents, consuming the indexed
 * per-person §408(d)(8) limit once across all of that member's entries,
 * and derives the IRA-pool RMD offset + income exclusion.
 *
 * No I/O; mirrors `rmd.ts` purity — engines pass resolved inputs in.
 *
 * Config: apps/web/src/lib/qcd-limits.ts (the indexed per-person limit).
 */

/**
 * Payload T for `CalibrationSnapshot<QcdLimits>` — the IRS §408(d)(8) per-person
 * annual QCD exclusion limit for one calendar year, in whole dollars. Indexed by
 * SECURE 2.0 §307; consumers inflation-extrapolate forward past the latest
 * published year. See `qcd-limits.ts`.
 */
export interface QcdLimits {
  readonly annualLimitDollars: number;
}

/**
 * One resolved QCD entry as the engine consumes it for a given owner-year.
 * `annualAmountDollars` is the REAL (today's-dollars) figure — the engine
 * inflates it to nominal via `inflationFactor` before the cap comparison.
 * Entries are pre-sorted by the caller (stable: start year then accountId).
 */
export interface QcdEntryForOwnerYear {
  readonly sourceAccountId: string;
  readonly annualAmountDollars: number;
}

/** Inputs to {@link computeQcdForOwnerYear}. All cents fields are integers. */
export interface ComputeQcdParams {
  /** This owner's active entries for the year, in stable order. */
  readonly entries: readonly QcdEntryForOwnerYear[];
  /** The projection tax year (informational; the limit is resolved by caller). */
  readonly year: number;
  /** Cumulative inflation factor applied to the REAL annual amount. */
  readonly inflationFactor: number;
  /** Prior-year-end PRE_TAX balance per source account id, integer cents. */
  readonly sourceBalancesPreTaxCents: ReadonlyMap<string, number>;
  /** This owner's gross IRA-pool RMD for the year, integer cents. 0 when
   *  the owner is below the RMD trigger age (70½–72 pre-RMD case). */
  readonly grossIraPoolRmdCents: number;
  /** The indexed per-person QCD exclusion limit for the year, integer cents. */
  readonly qcdLimitCentsForYear: number;
}

/** Per-entry resolved QCD amount (integer cents) keyed by the entry's index in
 *  the input `entries` array. */
interface PerEntryQcd {
  readonly entryIndex: number;
  readonly qcdCents: number;
}

/** Result of {@link computeQcdForOwnerYear}. */
export interface ComputeQcdResult {
  /** Per-entry resolved amounts (input order; integer cents). */
  readonly perEntry: readonly PerEntryQcd[];
  /** Sum of all per-entry amounts, integer cents. */
  readonly totalQcdCents: number;
  /** Amount that offsets the owner's IRA-pool RMD: `min(total, grossRMD)`. */
  readonly rmdOffsetCents: number;
  /** Amount excluded from ordinary income / MAGI: the full QCD total. */
  readonly incomeExclusionCents: number;
}

/** Convert dollars to integer cents (same rounding seam used elsewhere). */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Returns the first tax year in which a member is QCD-eligible: the calendar
 * year containing `birthdate + 70 years + 6 calendar months` (precise half-year).
 * This deliberately diverges from the engine-wide Dec-31 age convention
 * because a QCD becomes legal the day the donor turns 70½, not at a year-end age.
 *
 * Examples:
 *  - born 1954-01-15 → eligible 2024-07-15 → first eligible tax year 2024.
 *  - born 1954-07-01 → eligible 2025-01-01 → first eligible tax year 2025.
 *  - born 1954-12-01 → eligible 2025-06-01 → first eligible tax year 2025.
 *
 * @param isoBirthdate - Owner's birthdate in ISO 8601 `YYYY-MM-DD` format.
 * @throws {Error} when `isoBirthdate` is not a valid `YYYY-MM-DD` string.
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

  // Validate month range.
  if (birthMonth < 1 || birthMonth > 12) {
    throw new Error(
      `qcdFirstEligibleTaxYear: isoBirthdate "${isoBirthdate}" has an invalid month`,
    );
  }
  // Validate day range (respecting month lengths and leap years).
  // `new Date(year, month, 0).getDate()` with a 1-based `month` returns the
  // number of days in `month` (Feb 29 in leap years, Feb 28 otherwise).
  const daysInMonth = new Date(birthYear, birthMonth, 0).getDate();
  if (birthDay < 1 || birthDay > daysInMonth) {
    throw new Error(
      `qcdFirstEligibleTaxYear: isoBirthdate "${isoBirthdate}" has an invalid day`,
    );
  }

  // Add exactly 70 years and 6 calendar months. `birthMonth + 6` may overflow
  // past December; carry the overflow into the following year.
  const monthIndexFromYearStart = birthMonth - 1 + 6; // 0-based, may exceed 11
  const eligibleYear = birthYear + 70 + Math.floor(monthIndexFromYearStart / 12);
  return eligibleYear;
}

/**
 * Compute the owner-year QCD totals for one member.
 *
 * For each entry (in the caller's stable order):
 *  1. Inflate the REAL amount to nominal integer cents.
 *  2. Cap at `min(inflated, remaining per-person limit, source IRA available
 *     pre-tax balance)`, clamped ≥ 0.
 *  3. Decrement the remaining per-person limit by the resolved amount (the
 *     §408(d)(8) limit is consumed once across all the member's entries).
 *
 * Then derive the owner-year aggregates:
 *  - `totalQcdCents` — sum of all per-entry amounts.
 *  - `rmdOffsetCents = min(total, grossIraPoolRmdCents)` — the QCD satisfies
 *    only the IRA-pool RMD; when the owner is below RMD age the gross is 0
 *    and the offset is 0.
 *  - `incomeExclusionCents = totalQcdCents` — the full QCD is excluded from
 *    income regardless of any RMD relation.
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
  // Local mutable copy so same-source entries correctly deplete each other.
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
