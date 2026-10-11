/**
 * Internal helpers shared between the annual (`projectSsByYear`) and
 * monthly (`projectSsByMonth`) SS projection engines. Not part of the
 * public module API — import from `ss-projection.ts` for all external
 * consumers.
 */
import {
  adjustmentFactor,
  birthMonthForBenefitPurposes,
  birthYearForBenefitPurposes,
  fraMonthsForBirthdate,
  monthlyBenefitAtAge,
  spousalAdjustmentFactor,
  survivorFraMonthsForBirthdate,
} from './ssa-formulas';
import {
  SSA_EARNINGS_TEST,
  computeEarningsTest,
  resolveEarningsTestThresholds,
} from './ss-earnings-test';
import {
  deemedFilingEligible,
  SPOUSAL_PIA_FRACTION,
} from './ss-spousal-survivor';
import type { RetirementAgePerMember } from '../db/types';
import type { SsContextMember } from './ss-projection-types';
import type { DeceasedMember, SurvivorMember, SurvivorStructs } from './ss-spousal-survivor';
export type { SurvivorStructs } from './ss-spousal-survivor';

export const claimAgeMonths = (a: RetirementAgePerMember): number =>
  a.ageYears * 12 + a.ageMonths;

export const fraMonthsFor = (member: SsContextMember): number => {
  const bd = member.payload.birthdate;
  if (!bd) return 67 * 12;
  try {
    // Route through fraMonthsForBirthdate so the SSA day-1 rule
    // (POMS GN 00302.400) is applied: Jan 1 1960 → 1959 cohort.
    return fraMonthsForBirthdate(bd);
  } catch {
    return 67 * 12;
  }
};

/** Widow(er) (survivor) FRA in total months — the SURVIVOR cohort table
 *  (POMS RS 00615.003), distinct from the retirement FRA for 1943–1961
 *  births. Same 67×12 fallback shape as `fraMonthsFor`.
 *  Module-private: consumed via `buildSurvivorStructs`. */
const survivorFraMonthsFor = (member: SsContextMember): number => {
  const bd = member.payload.birthdate;
  if (!bd) return 67 * 12;
  try {
    return survivorFraMonthsForBirthdate(bd);
  } catch {
    return 67 * 12;
  }
};

export const claimYearFor = (member: SsContextMember): number | null => {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    // Use benefit-year birth year (SSA day-1 rule) for consistent
    // cohort derivation across all SS calculations.
    const birthYear = birthYearForBenefitPurposes(bd);
    return birthYear + member.claimAge.ageYears;
  } catch {
    return null;
  }
};

/**
 * Age-62 eligibility year (`birthYear + 62`, SSA day-1 birth year) — the
 * FALLBACK COLA anchor for a benefit with no statement date on file.
 * Returns `null` when the birthdate is absent/invalid. Module-private:
 * external consumers read the anchor via `colaAnchorYearFor`.
 */
const age62YearFor = (member: SsContextMember): number | null => {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    return birthYearForBenefitPurposes(bd) + 62;
  } catch {
    return null;
  }
};

/**
 * Statement-anchored COLA anchor year: the SSA statement's as-of year
 * when `piaAsOfDate` exists — the quoted FRA benefit already includes every
 * COLA through that date, so nominal COLAs are layered only for years AFTER
 * it (applying earlier COLAs would double-count the statement's own). Falls
 * back to the age-62 eligibility year when no
 * statement date is on file. `null` when neither is derivable.
 */
export const colaAnchorYearFor = (member: SsContextMember): number | null =>
  member.statementAnchorYear ?? age62YearFor(member);

/** Calendar year the member attains FRA (benefit-purpose birth year/month +
 *  FRA months). `null` when the birthdate is absent/invalid. */
export const fraYearFor = (member: SsContextMember): number | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  return Math.floor((b.year * 12 + b.month0 + fraMonthsFor(member)) / 12);
};

/** 0-indexed calendar month the member attains FRA within `fraYearFor`'s
 *  year (the ARF restoration is effective only with the FRA month,
 *  20 CFR 404.412(b), so the FRA year mixes pre-/post-restoration rates at
 *  this boundary). `null` when the birthdate is absent/invalid. */
export const fraMonth0For = (member: SsContextMember): number | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  return (b.month0 + fraMonthsFor(member)) % 12;
};

/** Birth (year, month0) for benefit purposes, applying the SSA day-1 rule
 *  (POMS GN 00302.400) via `birthYearForBenefitPurposes` and
 *  `birthMonthForBenefitPurposes` — consistent with the annual engine. */
const birthYearMonth = (
  member: SsContextMember,
): { year: number; month0: number } | null => {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    const year = birthYearForBenefitPurposes(bd);
    const month0 = birthMonthForBenefitPurposes(bd);
    return { year, month0 };
  } catch {
    return null;
  }
};

/** Resolved (year, month0) the member's SS claim starts. Birthday + claim age. */
export const claimMonthFor = (
  member: SsContextMember,
): { year: number; month0: number } | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  const totalMonths = b.month0 + member.claimAge.ageYears * 12 + member.claimAge.ageMonths;
  return {
    year: b.year + Math.floor(totalMonths / 12),
    month0: ((totalMonths % 12) + 12) % 12,
  };
};

/** Absolute month index the member reaches their SURVIVOR claim age
 *  (independent of the own claim age). `null` when no survivor claim age is
 *  on file (withheld) or the birthdate is missing/invalid. */
export const survivorClaimMonthIdxFor = (member: SsContextMember): number | null => {
  if (!member.survivorClaimAge) return null;
  const b = birthYearMonth(member);
  if (!b) return null;
  return (
    monthIdx(b.year, b.month0) +
    member.survivorClaimAge.ageYears * 12 +
    member.survivorClaimAge.ageMonths
  );
};

/** Resolved (year, month0) of the member's projected death — exclusive
 *  boundary (alive up to but not including this month).
 *
 *  Death is modelled as Dec 31 of `deathYear`
 *  (`deathYear = birthYear + lifeExpectancyAge`); the member is alive
 *  through all of `deathYear`, so the exclusive boundary is Jan 1 of
 *  `deathYear + 1`. Survivor benefits begin from this month. */
export const deathMonthFor = (
  member: SsContextMember,
): { year: number; month0: number } | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  const deathYear = b.year + member.lifeExpectancyAge;
  return { year: deathYear + 1, month0: 0 };
};

export const monthIdx = (year: number, month0: number): number => year * 12 + month0;

export const deathYearFor = (member: SsContextMember): number | null => {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    const birthYear = birthYearForBenefitPurposes(bd);
    return birthYear + member.lifeExpectancyAge;
  } catch {
    return null;
  }
};

/**
 * Annual SS benefit a member receives at their claim year (in nominal
 * dollars at the COLA-anchor level). Returns 0 when pia is null.
 */
export function ownClaimBenefitAnnual(member: SsContextMember, reductionFactor: number): number {
  if (member.pia === null || member.pia <= 0) return 0;
  const monthly = monthlyBenefitAtAge(
    member.pia,
    fraMonthsFor(member),
    claimAgeMonths(member.claimAge),
  );
  return monthly * 12 * reductionFactor;
}

/**
 * ARF-adjusted own-benefit annual base (POMS RS 00615.482): at FRA the SSA
 * recomputes a reduced benefit, removing every pre-FRA month whose check was
 * withheld under the earnings test from the early-claim reduction — as if
 * the member had claimed `withheldMonths` later. Only reduced (pre-FRA)
 * claims are adjusted; the recomputed claim age caps at FRA.
 */
export function arfAdjustedOwnBaseAnnual(
  member: SsContextMember,
  reductionFactor: number,
  withheldMonths: number,
): number {
  if (member.pia === null || member.pia <= 0) return 0;
  const fra = fraMonthsFor(member);
  const claim = claimAgeMonths(member.claimAge);
  if (claim >= fra || withheldMonths <= 0) {
    return ownClaimBenefitAnnual(member, reductionFactor);
  }
  const adjustedClaim = Math.min(fra, claim + withheldMonths);
  return monthlyBenefitAtAge(member.pia, fra, adjustedClaim) * 12 * reductionFactor;
}

/**
 * Dual-entitlement spousal EXCESS base (annual, POMS RS 00615.020): the
 * dually entitled recipient receives their OWN benefit (reduced by their own
 * claim-age factor) PLUS the spousal excess — `max(0, 50% × worker PIA −
 * recipient PIA)` — where the excess is reduced SEPARATELY by the
 * recipient's spousal reduction factor (POMS RS 00615.201). The worker
 * benefit and the spouse excess are never combined before reduction: each
 * carries its own factor. DRCs do not transfer — the spousal factor caps at
 * 1.0. Returns 0 when there is no spouse / spouse PIA, or when the
 * recipient's own PIA already meets or exceeds half the worker's.
 *
 * Per POMS RS 00615.301, spousal entitlement — and therefore the reduction
 * clock — begins no earlier than the date the WORKER claims; the caller
 * supplies the effective entitlement age via `effectiveRecipientAgeMonths`
 * (see `effectiveSpousalAgeMonths`).
 */
export function spousalExcessAnnual(
  self: SsContextMember,
  spouse: SsContextMember | undefined,
  reductionFactor: number,
  effectiveRecipientAgeMonths?: number,
  opts?: {
    /** Scenario COLA percent — used to bring the recipient's PIA onto the
     *  WORKER's statement-anchor basis before subtracting. The two
     *  statements may carry different as-of years; subtracting mixed-basis
     *  PIAs and then growing the whole excess from the worker's anchor
     *  mis-scales the recipient component. 0/absent → no normalization. */
    colaPct?: number;
    /** ARF credit months for the SPOUSAL reduction factor (POMS
     *  RS 00615.482): months the excess was withheld under the earnings
     *  test before the recipient's FRA are removed from the spousal
     *  reduction at FRA — as if the spousal entitlement began that many
     *  months later (the factor caps itself at 1.0 at/after FRA). */
    arfCreditMonths?: number;
  },
): number {
  if (!spouse || spouse.pia === null || spouse.pia <= 0) return 0;
  const ownPiaRaw = self.pia !== null && self.pia > 0 ? self.pia : 0;
  // Normalize the recipient's PIA to the worker's COLA-anchor year so
  // the subtraction happens on ONE basis; downstream growth then compounds
  // from the worker's anchor for the whole excess, keeping each component
  // effectively growing from its own statement date.
  const selfAnchor = colaAnchorYearFor(self);
  const workerAnchor = colaAnchorYearFor(spouse);
  const colaPct = opts?.colaPct ?? 0;
  const ownPia =
    ownPiaRaw > 0 && selfAnchor !== null && workerAnchor !== null && colaPct !== 0
      ? ownPiaRaw * Math.pow(1 + colaPct / 100, workerAnchor - selfAnchor)
      : ownPiaRaw;
  const excessMonthly = Math.max(0, spouse.pia * SPOUSAL_PIA_FRACTION - ownPia);
  if (excessMonthly <= 0) return 0;
  const ageMonths =
    (effectiveRecipientAgeMonths ?? claimAgeMonths(self.claimAge)) +
    Math.max(0, opts?.arfCreditMonths ?? 0);
  const factor = spousalAdjustmentFactor(fraMonthsFor(self), ageMonths);
  return excessMonthly * 12 * factor * reductionFactor;
}

/**
 * The recipient's effective spousal-entitlement age in months,
 * which is the later of their own claim age and their age when the worker
 * first claims. Both members' birthdays are derived for benefit purposes
 * (SSA day-1 rule). Returns the recipient's own claim age when either
 * birthdate is missing or the worker does not claim later.
 *
 * @param recipient - the spousal-excess recipient
 * @param worker - the higher earner whose PIA the excess draws on
 */
export function effectiveSpousalAgeMonths(
  recipient: SsContextMember,
  worker: SsContextMember | undefined,
): number {
  const ownAgeMonths = claimAgeMonths(recipient.claimAge);
  if (!worker) return ownAgeMonths;
  const recipientBirth = birthYearMonth(recipient);
  const workerClaim = claimMonthFor(worker);
  if (!recipientBirth || !workerClaim) return ownAgeMonths;
  const recipientBirthIdx = monthIdx(recipientBirth.year, recipientBirth.month0);
  const workerClaimIdx = monthIdx(workerClaim.year, workerClaim.month0);
  const recipientAgeWhenWorkerClaims = workerClaimIdx - recipientBirthIdx;
  return Math.max(ownAgeMonths, recipientAgeWhenWorkerClaims);
}

/**
 * Pre-builds the four survivor structs consumed by both projection engines.
 *
 * The survivor side carries the member's SEPARATE survivor claim age
 * (`survivorClaimAge` — `null` when absent → withheld); the deceased
 * side carries the pre-reduced PIA, the death cap, and the statement-anchored
 * COLA anchor.
 *
 * @param primary - primary context member
 * @param secondary - secondary context member, or undefined
 * @param primaryDeathYear - calendar year primary dies (or null)
 * @param secondaryDeathYear - calendar year secondary dies (or null)
 * @param reductionFactor - `1 - benefitReductionPct / 100`
 */
export function buildSurvivorStructs(
  primary: SsContextMember,
  secondary: SsContextMember | undefined,
  primaryDeathYear: number | null,
  secondaryDeathYear: number | null,
  reductionFactor: number,
): SurvivorStructs {
  const survivorFor = (member: SsContextMember): SurvivorMember => {
    const svAge = member.survivorClaimAge ?? null;
    return {
      // The WIDOW(ER) FRA cohort table, not the retirement FRA.
      survivorFraMonths: survivorFraMonthsFor(member),
      survivorClaimAgeMonths: svAge ? svAge.ageYears * 12 + svAge.ageMonths : null,
      // Month-precise absolute claim index (benefit-purpose birth
      // month + survivor claim age) — the annual engine derives the start
      // year AND the midyear-entitlement proration from it.
      survivorClaimMonthIdx: survivorClaimMonthIdxFor(member),
    };
  };
  const deceasedFor = (member: SsContextMember, deathYear: number | null): DeceasedMember => {
    const b = birthYearMonth(member);
    return {
      // Pre-reduce pia so survivorBenefitAnnual does not double-reduce.
      pia: (member.pia ?? 0) * reductionFactor,
      fraMonths: fraMonthsFor(member),
      scenarioClaimAgeMonths: claimAgeMonths(member.claimAge),
      // Death is Dec 31 of `deathYear` (the engine-wide convention —
      // `deathMonthFor`'s exclusive Jan boundary), so the death age is the
      // age at Jan 1 of `deathYear + 1`, NOT the birthday of the
      // life-expectancy year — a claim (or DRC month) between the birthday
      // and Dec 31 of the death year is not posthumous.
      deathAgeMonths:
        b && deathYear !== null
          ? (deathYear + 1 - b.year) * 12 - b.month0
          : member.lifeExpectancyAge * 12,
      deathYear: deathYear ?? 0,
      // Deceased-component COLA anchor — statement anchor, age-62 fallback.
      colaAnchorYear: colaAnchorYearFor(member) ?? (deathYear ?? 0),
    };
  };
  return {
    primarySurvivor: survivorFor(primary),
    secondarySurvivor: secondary ? survivorFor(secondary) : null,
    primaryDeceased: secondary ? deceasedFor(primary, primaryDeathYear) : null,
    secondaryDeceased: secondary ? deceasedFor(secondary, secondaryDeathYear) : null,
  };
}

/** One entitlement start: the year+month a benefit first became payable to
 *  the member. Another grace year requires the prior entitlement to
 *  end plus a ≥1-month break before the next benefit — the model never
 *  breaks an entitlement, so callers supply only the member's FIRST-ever
 *  start (own retirement claim or an earlier survivor start). */
export interface EntitlementStart {
  year: number;
  month0: number;
}

/** Per-member earnings-test timing state: the first-ever entitlement
 *  start plus the resolved SSA grace year — the FIRST entitled taxable year
 *  that contains an entitled, pre-FRA, NON-SERVICE month (20 CFR 404.435 /
 *  POMS RS 02501.030), which is NOT necessarily the entitlement year (an
 *  entitlement year made up entirely of service months defers the grace
 *  year, and its monthly test, to the first later non-service-month year).
 *  `graceYear === null` = no qualifying year through the FRA year. */
export interface MemberEtTiming {
  start: EntitlementStart;
  graceYear: number | null;
}

/**
 * Resolve the member's SSA grace year (POMS RS 02501.030): scan from
 * the first entitlement year through the FRA year for the first year with
 * an entitled, pre-FRA, non-service month (monthly earnings at/below 1/12
 * of that year's applicable exempt amount). A year with NO monthly-earnings
 * series consumes the grace year (a zero-earnings year genuinely contains
 * non-service months; with annual-only data the engine cannot prove every
 * month was a service month, and the monthly test cannot run without the
 * series anyway).
 */
export function resolveGraceYear(
  member: SsContextMember,
  start: EntitlementStart,
  etInflationPct: number,
): number | null {
  const fraYear = fraYearFor(member);
  const fraMonth0 = fraMonth0For(member);
  // No FRA frame (missing/invalid birthdate) → the earnings test never runs
  // for this member; keep the entitlement year as the nominal grace year.
  if (fraYear === null || fraMonth0 === null) return start.year;
  for (let y = start.year; y <= fraYear; y += 1) {
    const from = y === start.year ? start.month0 : 0;
    const to = y === fraYear ? fraMonth0 - 1 : 11;
    if (to < from) continue; // no entitled pre-FRA month this year
    const monthly = member.earnedIncomeMonthlyByYear?.[y];
    if (!monthly) return y;
    const t = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, y, etInflationPct);
    const limit = (y === fraYear ? t.higherThreshold : t.lowerThreshold) / 12;
    for (let m = from; m <= to; m += 1) {
      if ((monthly[m] ?? 0) <= limit) return y; // non-service month found
    }
  }
  return null;
}

/** Outcome of `applyEarningsTestToMember` for one member-year. The engine
 *  consumes only the per-month charge schedule, the withheld-check count,
 *  and the estimate flag (there is no single annual factor; the month
 *  schedules carry the charge). */
export interface MemberEarningsTestOutcome {
  estimated: boolean;
  /** Whole RECORD-level checks charged. The engine derives the
   *  per-component ARF credits (own-RIB vs spousal-excess vs discarded
   *  survivor-only months) from the schedule + each component's
   *  entitled months, not from this raw count. */
  withheldMonths: number;
  /** Per-calendar-month pay-factor schedule (12 entries) — the fraction of
   *  the RECORD-level pool paid each month (§404.439 apportions a partial
   *  month proportionally, so the same factor applies to every component
   *  on the record); `null` when no test ran (untested → full pay). */
  payFactorByMonth: readonly number[] | null;
}

const UNTESTED = (): MemberEarningsTestOutcome => ({
  estimated: false,
  withheldMonths: 0,
  payFactorByMonth: null,
});

/**
 * Apply the SSA earnings-test reduction to a member's chargeable benefit
 * pool for one year.
 *
 * The earnings test reduces benefits when the earner has part-time earned
 * income above the annual exempt amount before FRA. Per 20 CFR
 * 404.415/404.434, `benefitAnnual` / `monthlyBenefitDollars` carry the
 * RECORD-level combined pool chargeable by THIS member's excess earnings —
 * their own (+survivor) checks, any spousal excess payable on their record,
 * and their own spousal excess (dual entitlement) — so the deduction amount
 * and the per-month charge schedule are computed against the correct
 * family total, never a personal-benefit ratio reapplied elsewhere.
 *
 * Month-precise inputs: when the member carries an actual monthly-earnings
 * series for the year it drives the FRA-year pre-FRA-month sum, and in the
 * member's GRACE YEAR the monthly non-service test runs too (20 CFR
 * 404.430 / 404.435). The grace year is carried on
 * `timing` — the FIRST entitled taxable year containing a non-service
 * month (POMS RS 02501.030), resolved from the member's first-ever
 * entitlement start (own retirement claim or an earlier survivor start); a
 * later benefit start with entitlement continuing unbroken into it
 * establishes no additional grace year (20 CFR 404.435(b)(2)).
 *
 * Returns the whole-check `withheldMonths` count (record-level charged
 * months), the month-indexed charge schedule the engines consume,
 * and the estimated-thresholds flag.
 *
 * @param timing - the member's entitlement start + resolved grace year).
 *   Absent → derived from the own retirement claim via
 *   `claimMonthFor` + `resolveGraceYear` (direct-caller fallback).
 * @param monthlyBenefitDollars - the ACTUAL chargeable pool per calendar
 *   month (12 entries). When the checks vary within the year
 *   (midyear spousal-excess/survivor activation, FRA-year mixed rates) the
 *   deductions charge each specific month's real total instead of a
 *   uniform annual÷12 scalar.
 */
export function applyEarningsTestToMember(
  member: SsContextMember,
  year: number,
  benefitAnnual: number,
  inflationRatePct: number,
  timing?: MemberEtTiming | null,
  monthlyBenefitDollars?: ReadonlyArray<number>,
): MemberEarningsTestOutcome {
  if (benefitAnnual <= 0) return UNTESTED();
  const earned = member.earnedIncomeByYear?.[year] ?? 0;
  const monthly = member.earnedIncomeMonthlyByYear?.[year];
  const monthlySum = monthly ? monthly.reduce((s, m) => s + Math.max(0, m), 0) : 0;
  const earnedTotal = earned > 0 ? earned : monthlySum;
  if (earnedTotal <= 0) return UNTESTED();
  const bd = member.payload.birthdate;
  if (!bd) return UNTESTED();
  // Timing fallback for direct callers: the own retirement claim is the
  // entitlement start; the grace year resolves from there.
  const resolvedTiming =
    timing ??
    ((): MemberEtTiming | null => {
      const claim = claimMonthFor(member);
      if (!claim) return null;
      const start = { year: claim.year, month0: claim.month0 };
      return { start, graceYear: resolveGraceYear(member, start, inflationRatePct) };
    })();
  const result = computeEarningsTest(
    {
      year,
      isoBirthdate: bd,
      earnedIncomeDollars: earnedTotal,
      grossBenefitDollars: benefitAnnual,
      inflationRatePct,
      ...(monthly ? { monthlyEarningsDollars: monthly } : {}),
      ...(resolvedTiming !== null && resolvedTiming.start.year === year
        ? { entitlementStartMonth0: resolvedTiming.start.month0 }
        : {}),
      ...(resolvedTiming !== null && resolvedTiming.graceYear === year
        ? { graceYearMonthly: true }
        : {}),
      ...(monthlyBenefitDollars ? { monthlyBenefitDollars } : {}),
    },
    SSA_EARNINGS_TEST,
  );
  return {
    estimated: result.rateApplied !== 'none' && result.estimated,
    withheldMonths: result.withheldMonths,
    payFactorByMonth: result.payFactorByMonth,
  };
}

/** Inputs for `computeAnnualMemberBenefits` for a single year. */
export interface AnnualIterationInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  primaryClaiming: boolean;
  secondaryClaiming: boolean;
  /** Year being evaluated. */
  year: number;
  primaryClaim: number | null;
  secondaryClaim: number | null;
  /** Absolute claim-month indices (`year × 12 + month0`) — drive the
   *  spousal-excess activation month (`max(recipient, worker)` claim month)
   *  so a midyear worker claim prorates the excess in the annual table.
   *  `null` when the birthdate is missing. */
  primaryClaimMonthIdx: number | null;
  secondaryClaimMonthIdx: number | null;
  /** COLA anchor year (statement anchor when present, else the age-62
   *  eligibility year). COLAs compound only for years after it. */
  primaryColaAnchorYear: number | null;
  secondaryColaAnchorYear: number | null;
  /** Own-benefit annual bases — ARF-adjusted per year by the caller from the
   *  member's FRA year onward (restored earnings-test months). */
  primaryOwnBase: number;
  secondaryOwnBase: number;
  /** Dual-entitlement spousal EXCESS bases (see `spousalExcessAnnual`) —
   *  independently reduced; added on top of the own benefit, never composed
   *  via `max`. */
  primarySpousalExcessBase: number;
  secondarySpousalExcessBase: number;
  colaFactor: number;
  /** When true, prorate the claim-year benefit by the share of the
   *  year on/after the claim month. Annual-table mode only. */
  prorateClaimYear?: boolean;
  /** Fraction of the claim year on/after the claim month, `(12 −
   *  claimMonth0) / 12`. Applied only in the claim year when
   *  `prorateClaimYear` is set. One per member. */
  primaryClaimYearFraction?: number;
  secondaryClaimYearFraction?: number;
}

/** One member's annual benefit split into its components — the earnings-test
 *  application needs the spousal EXCESS separately (a worker's excess
 *  earnings also charge the spousal excess payable on their record). */
export interface AnnualMemberComponents {
  /** own + spousal excess (post-proration), nominal $/yr. */
  total: number;
  /** The spousal-excess portion of `total` (post-proration). */
  excess: number;
}

/** Annual components plus the ACTUAL per-calendar-month dollars: the
 *  annual engine composes the year from these 12 checks — the survivor fold,
 *  the earnings-test charging, and the FRA-year mixed-rate
 *  splice all operate month-wise. `total === Σ totalByMonth`. */
export interface AnnualMemberMonthlyComponents extends AnnualMemberComponents {
  totalByMonth: number[];
  excessByMonth: number[];
}

/** First month0 of `year` the spousal excess is payable — activation
 *  is the LATER of the two claim months (`max(recipient, worker)`), so the
 *  worker's midyear claim starts the excess mid-year in its activation
 *  year. `12` = no payable month this year. */
function excessStartMonth0(
  year: number,
  recipientClaimIdx: number | null,
  workerClaimIdx: number | null,
  prorate: boolean,
  fallbackStartMonth0: number,
): number {
  if (!prorate) return 0;
  if (recipientClaimIdx === null || workerClaimIdx === null) {
    // Missing birthdate → no month info; fall back to the recipient's own
    // claim-year start month.
    return fallbackStartMonth0;
  }
  const startIdx = Math.max(recipientClaimIdx, workerClaimIdx);
  const startYear = Math.floor(startIdx / 12);
  if (year < startYear) return 12;
  if (year > startYear) return 0;
  return startIdx % 12;
}

/** One recipient's annual components (own + excess) as actual per-month
 *  checks — the shared body both member directions of
 *  `computeAnnualMemberBenefits` call. */
function annualComponentsFor(args: {
  year: number;
  colaFactor: number;
  claim: number;
  claimMonthIdx: number | null;
  anchor: number | null;
  ownBase: number;
  excessBase: number;
  workerAlive: boolean;
  workerClaiming: boolean;
  workerClaim: number | null;
  workerClaimMonthIdx: number | null;
  workerAnchor: number | null;
  prorate: boolean;
  claimYearFraction: number;
}): AnnualMemberMonthlyComponents {
  // COLA exponent measured from the anchor year (statement anchor / age-62
  // fallback), not the claim year. The claim-age adjustment is already
  // baked into `ownBase`.
  const cola = Math.pow(args.colaFactor, args.year - (args.anchor ?? args.claim));
  // The claim-year fraction is `(12 − claimMonth0)/12` by construction,
  // so the payable-month start recovers exactly as `12 − fraction × 12`.
  const ownStartMonth0 =
    args.prorate && args.year === args.claim
      ? Math.min(12, Math.max(0, Math.round(12 - args.claimYearFraction * 12)))
      : 0;
  const ownMonthly = (args.ownBase * cola) / 12;
  // The spousal excess derives from the WORKER's PIA, so its COLA
  // compounds from the WORKER's anchor.
  const spousalCola = Math.pow(
    args.colaFactor,
    args.year - (args.workerAnchor ?? args.workerClaim ?? args.claim),
  );
  // Deemed-filing gate: worker claimed AND recipient at/past own claim.
  const spousalEligible = deemedFilingEligible(args.workerClaiming, args.year, args.claim);
  const excessMonthly =
    args.workerAlive && spousalEligible ? (args.excessBase * spousalCola) / 12 : 0;
  const excessStart =
    excessMonthly > 0
      ? excessStartMonth0(
          args.year,
          args.claimMonthIdx,
          args.workerClaimMonthIdx,
          args.prorate,
          ownStartMonth0,
        )
      : 12;
  // Dual entitlement: own + independently reduced excess (POMS
  // RS 00615.020), each carrying its own reduction factor, month by month.
  const totalByMonth = new Array<number>(12).fill(0);
  const excessByMonth = new Array<number>(12).fill(0);
  let total = 0;
  let excess = 0;
  for (let m = 0; m < 12; m += 1) {
    const own = m >= ownStartMonth0 ? ownMonthly : 0;
    const ex = m >= excessStart ? excessMonthly : 0;
    totalByMonth[m] = own + ex;
    excessByMonth[m] = ex;
    total += own + ex;
    excess += ex;
  }
  return { total, excess, totalByMonth, excessByMonth };
}

/**
 * Computes per-member annual benefit amounts for `projectSsByYear` for
 * one calendar year, applying own-benefit COLA and the deemed-filing
 * dual-entitlement spousal excess. Does NOT apply survivor overrides
 * (see `applyAnnualSurvivorBranches`).
 *
 * Dual entitlement (POMS RS 00615.020): `own (own reduction) + excess
 * (spousal reduction)` — the two components are reduced separately and
 * ADDED (not the larger of the two). The excess COLAs
 * from the WORKER's anchor and activates at the worker's actual claim
 * month (prorated in the activation year).
 *
 * Returns `{ primary, secondary }` component pairs (nominal $/yr);
 * `secondary` is `undefined` when there is no secondary member.
 *
 * @param inp - per-year loop state
 */
const emptyMonthlyComponents = (): AnnualMemberMonthlyComponents => ({
  total: 0,
  excess: 0,
  totalByMonth: new Array<number>(12).fill(0),
  excessByMonth: new Array<number>(12).fill(0),
});

export function computeAnnualMemberBenefits(inp: AnnualIterationInputs): {
  primary: AnnualMemberMonthlyComponents;
  secondary: AnnualMemberMonthlyComponents | undefined;
} {
  let primary: AnnualMemberMonthlyComponents = emptyMonthlyComponents();
  let secondary: AnnualMemberMonthlyComponents | undefined = inp.hasSecondary
    ? emptyMonthlyComponents()
    : undefined;

  if (inp.primaryAlive && inp.primaryClaiming && inp.primaryClaim !== null) {
    primary = annualComponentsFor({
      year: inp.year,
      colaFactor: inp.colaFactor,
      claim: inp.primaryClaim,
      claimMonthIdx: inp.primaryClaimMonthIdx,
      anchor: inp.primaryColaAnchorYear,
      ownBase: inp.primaryOwnBase,
      excessBase: inp.primarySpousalExcessBase,
      workerAlive: inp.secondaryAlive,
      workerClaiming: inp.secondaryClaiming,
      workerClaim: inp.secondaryClaim,
      workerClaimMonthIdx: inp.secondaryClaimMonthIdx,
      workerAnchor: inp.secondaryColaAnchorYear,
      prorate: inp.prorateClaimYear ?? false,
      claimYearFraction: inp.primaryClaimYearFraction ?? 1,
    });
  }

  if (inp.hasSecondary && inp.secondaryAlive && inp.secondaryClaiming && inp.secondaryClaim !== null) {
    secondary = annualComponentsFor({
      year: inp.year,
      colaFactor: inp.colaFactor,
      claim: inp.secondaryClaim,
      claimMonthIdx: inp.secondaryClaimMonthIdx,
      anchor: inp.secondaryColaAnchorYear,
      ownBase: inp.secondaryOwnBase,
      excessBase: inp.secondarySpousalExcessBase,
      workerAlive: inp.primaryAlive,
      workerClaiming: inp.primaryClaiming,
      workerClaim: inp.primaryClaim,
      workerClaimMonthIdx: inp.primaryClaimMonthIdx,
      workerAnchor: inp.primaryColaAnchorYear,
      prorate: inp.prorateClaimYear ?? false,
      claimYearFraction: inp.secondaryClaimYearFraction ?? 1,
    });
  }

  return { primary, secondary };
}

/**
 * DRC portion of the adjustment factor that is actually PAYABLE in
 * the month at `idx`. Delayed-retirement credits earned during calendar
 * year N are first payable in January of N+1 (SSA POMS RS 00615.690),
 * except credits earned in the year the beneficiary turns 70 (and any
 * months at/after age 70), which are payable immediately.
 *
 * Returns the full static `adjustmentFactor` for claims at or below FRA
 * (reductions and the 1.0 factor have no deferral) and for months at or
 * after age 70. For a delayed claim before age 70, the payable factor
 * ramps up only at each January boundary: it pays for the credits earned
 * through the END of the prior calendar year.
 *
 * @param idx - absolute month index `year × 12 + month0` being evaluated
 * @param claimIdx - absolute month index the member claims
 * @param fraMonths - member's FRA in total months
 * @param claimAgeMonths - member's claim age in total months
 * @param age70Idx - absolute month index the member reaches age 70
 */
export function payableDrcFactorForMonth(
  idx: number,
  claimIdx: number,
  fraMonths: number,
  claimAgeMonths: number,
  age70Idx: number,
): number {
  // No DRCs below/at FRA — early-claim reduction already in base; payable factor = 1.0.
  if (claimAgeMonths <= fraMonths) {
    // Pre-FRA/at-FRA: no DRCs. The early-claim reduction is already baked
    // into `ownBaseNoDrcAnnual` (via min(claim, fra)). Payable factor = 1.0.
    return 1.0;
  }
  // At/after age 70 all earned credits are payable immediately.
  if (idx >= age70Idx) return adjustmentFactor(fraMonths, claimAgeMonths);
  // The delay spans calendar-month indices [fraIdx, claimIdx − 1]. A
  // delay-month in calendar year Y is first payable in January Y+1, i.e.
  // payable once `idx ≥ (Y+1)×12`. At the evaluation month `idx`
  // (calendar year `currentYear`), the payable delay-months are those
  // whose calendar year < currentYear, i.e. month index < currentYear×12.
  const currentYear = Math.floor(idx / 12);
  const totalDrcMonths = claimAgeMonths - fraMonths;
  const fraIdx = claimIdx - totalDrcMonths;
  const payableCutoffIdx = currentYear * 12; // Jan 1 of current year
  const payableDrcMonths = Math.max(
    0,
    Math.min(claimIdx, payableCutoffIdx) - fraIdx,
  );
  const cappedPayable = Math.min(payableDrcMonths, totalDrcMonths);
  return adjustmentFactor(fraMonths, fraMonths + cappedPayable);
}

/** Inputs shared by `computeMonthlyMemberBenefits` for a single month. */
export interface MonthlyIterationInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  primaryClaiming: boolean;
  secondaryClaiming: boolean;
  /** Absolute month index `year * 12 + month0`. */
  idx: number;
  primaryClaimIdx: number | null;
  secondaryClaimIdx: number | null;
  /** COLA exponent for primary — `year − primaryColaAnchorYear`. */
  primaryColaPow: number;
  /** COLA exponent for secondary — same formula. */
  secondaryColaPow: number;
  /** Own annual base WITHOUT the DRC portion of the adjustment factor
   *  baked in (reductions/at-FRA factor still applied) — the payable
   *  DRC factor is applied per-month on top. ARF-adjusted per year by the
   *  caller from the member's FRA year onward. */
  primaryOwnBaseNoDrc: number;
  secondaryOwnBaseNoDrc: number;
  /** Payable-DRC factor for this month (1.0 when no DRCs apply). */
  primaryPayableDrc: number;
  secondaryPayableDrc: number;
  /** Dual-entitlement spousal EXCESS bases — independently reduced. */
  primarySpousalExcessBase: number;
  secondarySpousalExcessBase: number;
  colaFactor: number;
}

/**
 * Computes per-member annualized benefit amounts for `projectSsByMonth`
 * for one calendar month. Applies own-benefit COLA and the deemed-filing
 * dual-entitlement spousal excess at month-index precision.
 *
 * Returns `{ primary, secondary }` component pairs in nominal $/yr —
 * `total` (own + excess) plus the `excess` portion, so the caller can
 * apply the per-record earnings-test schedules component-wise.
 * `secondary` is `undefined` when there is no secondary member.
 *
 * @param inp - per-month loop state
 */
export function computeMonthlyMemberBenefits(inp: MonthlyIterationInputs): {
  primary: AnnualMemberComponents;
  secondary: AnnualMemberComponents | undefined;
} {
  let primary: AnnualMemberComponents = { total: 0, excess: 0 };
  let secondary: AnnualMemberComponents | undefined = inp.hasSecondary
    ? { total: 0, excess: 0 }
    : undefined;

  if (inp.primaryAlive && inp.primaryClaiming) {
    const cola = Math.pow(inp.colaFactor, inp.primaryColaPow);
    // Own benefit = (PIA × non-DRC factor) × payable-DRC factor × COLA.
    const ownNow = inp.primaryOwnBaseNoDrc * inp.primaryPayableDrc * cola;
    // Spousal excess: worker=secondary claimed, recipient=primary. Worker's
    // COLA anchor.
    const spousalCola = Math.pow(inp.colaFactor, inp.secondaryColaPow);
    const spousalEligible = deemedFilingEligible(
      inp.secondaryClaiming,
      inp.idx,
      inp.primaryClaimIdx ?? Infinity,
    );
    const excessNow =
      inp.secondaryAlive && spousalEligible
        ? inp.primarySpousalExcessBase * spousalCola
        : 0;
    // Dual entitlement: own + independently reduced excess, not max.
    primary = { total: ownNow + excessNow, excess: excessNow };
  }

  if (inp.hasSecondary && inp.secondaryAlive && inp.secondaryClaiming) {
    const cola = Math.pow(inp.colaFactor, inp.secondaryColaPow);
    const ownNow = inp.secondaryOwnBaseNoDrc * inp.secondaryPayableDrc * cola;
    const spousalCola = Math.pow(inp.colaFactor, inp.primaryColaPow);
    const spousalEligible = deemedFilingEligible(
      inp.primaryClaiming,
      inp.idx,
      inp.secondaryClaimIdx ?? Infinity,
    );
    const excessNow =
      inp.primaryAlive && spousalEligible
        ? inp.secondarySpousalExcessBase * spousalCola
        : 0;
    secondary = { total: ownNow + excessNow, excess: excessNow };
  }

  return { primary, secondary };
}

/**
 * Own annual benefit base WITHOUT the DRC portion of the adjustment
 * factor. For claims at or below FRA this equals
 * `ownClaimBenefitAnnual` (the adjustment factor is the reduction/1.0,
 * which is not deferred). For delayed claims it strips the DRC multiplier
 * so the monthly engine can layer `payableDrcFactorForMonth` on top.
 *
 * Returns `pia × (claim ≤ FRA ? adjustmentFactor : 1.0) × 12 × reductionFactor`.
 */
export function ownBaseNoDrcAnnual(
  member: SsContextMember,
  reductionFactor: number,
): number {
  if (member.pia === null || member.pia <= 0) return 0;
  const fra = fraMonthsFor(member);
  const claim = claimAgeMonths(member.claimAge);
  // Below/at FRA: keep the (reduction) factor. Above FRA: strip DRCs
  // (base at FRA = 1.0 factor) — the payable DRC factor is layered later.
  const ageForBase = Math.min(claim, fra);
  const monthly = monthlyBenefitAtAge(member.pia, fra, ageForBase);
  return monthly * 12 * reductionFactor;
}
