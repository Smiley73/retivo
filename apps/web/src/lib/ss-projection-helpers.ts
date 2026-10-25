/** Internal helpers shared by the annual (`projectSsByYear`) and monthly (`projectSsByMonth`) SS projection engines; external consumers import from `ss-projection.ts`. */
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
    // Routing through fraMonthsForBirthdate applies the SSA day-1 rule (POMS GN 00302.400): Jan 1 1960 is the 1959 cohort.
    return fraMonthsForBirthdate(bd);
  } catch {
    return 67 * 12;
  }
};

// Widow(er) FRA from the survivor cohort table (POMS RS 00615.003); same 67×12 fallback as `fraMonthsFor`.
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
    const birthYear = birthYearForBenefitPurposes(bd);
    return birthYear + member.claimAge.ageYears;
  } catch {
    return null;
  }
};

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
 * Statement-anchored COLA anchor year: the statement's as-of year when `piaAsOfDate` exists (its quoted FRA benefit
 * already includes COLAs through that date, so earlier COLAs would double-count), else the age-62 eligibility year;
 * `null` when neither is derivable.
 */
export const colaAnchorYearFor = (member: SsContextMember): number | null =>
  member.statementAnchorYear ?? age62YearFor(member);

/** Calendar year the member attains FRA; `null` when the birthdate is absent or invalid. */
export const fraYearFor = (member: SsContextMember): number | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  return Math.floor((b.year * 12 + b.month0 + fraMonthsFor(member)) / 12);
};

/** 0-indexed month the member attains FRA within `fraYearFor`'s year; ARF restoration takes effect with the FRA month (20 CFR 404.412(b)), so the FRA year mixes rates at this boundary. */
export const fraMonth0For = (member: SsContextMember): number | null => {
  const b = birthYearMonth(member);
  if (!b) return null;
  return (b.month0 + fraMonthsFor(member)) % 12;
};

// Benefit-purpose birth (year, month0) under the SSA day-1 rule (POMS GN 00302.400).
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

/** Absolute month index the member reaches their survivor claim age (independent of the own claim age); `null` when withheld or the birthdate is missing. */
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

/** Projected death as an exclusive boundary: death is Dec 31 of `birthYear + lifeExpectancyAge`, so the boundary is Jan 1 of the next year, when survivor benefits begin. */
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

/** Annual benefit at the claim year in nominal dollars at the COLA-anchor level; 0 when pia is null. */
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
 * ARF-adjusted own-benefit annual base (POMS RS 00615.482): months withheld under the earnings test come out of the
 * early-claim reduction at FRA, as if the claim were that many months later (capped at FRA); only reduced claims are adjusted.
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
 * Dual-entitlement spousal excess base, annual (POMS RS 00615.020): `max(0, 50% × worker PIA − recipient PIA)`, reduced by
 * the recipient's spousal factor (POMS RS 00615.201) separately from their own benefit and capped at 1.0 (DRCs do not
 * transfer). 0 with no spouse PIA or when the recipient's PIA already covers half. Spousal entitlement begins no earlier
 * than the worker's claim (POMS RS 00615.301); the caller passes the effective age via `effectiveRecipientAgeMonths`.
 */
export function spousalExcessAnnual(
  self: SsContextMember,
  spouse: SsContextMember | undefined,
  reductionFactor: number,
  effectiveRecipientAgeMonths?: number,
  opts?: {
    /** Scenario COLA percent, bringing the recipient's PIA onto the worker's statement-anchor basis before subtracting (the statements may carry different as-of years); 0 or absent skips it. */
    colaPct?: number;
    /** ARF credit months for the spousal reduction factor (POMS RS 00615.482): excess months withheld under the earnings test come out of the reduction, as if entitlement began that many months later. */
    arfCreditMonths?: number;
  },
): number {
  if (!spouse || spouse.pia === null || spouse.pia <= 0) return 0;
  const ownPiaRaw = self.pia !== null && self.pia > 0 ? self.pia : 0;
  // Normalize the recipient's PIA to the worker's COLA-anchor year so the subtraction is on one basis; growth then compounds from the worker's anchor.
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

/** The recipient's effective spousal-entitlement age in months: the later of their own claim age and their age when the worker first claims (benefit-purpose birthdays). Returns the own claim age when a birthdate is missing. */
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
 * Builds the four survivor structs both engines consume. The survivor side carries the separate survivor claim age
 * (`null` withholds); the deceased side the pre-reduced PIA, the death cap and the statement-anchored COLA anchor.
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
      survivorFraMonths: survivorFraMonthsFor(member),
      survivorClaimAgeMonths: svAge ? svAge.ageYears * 12 + svAge.ageMonths : null,
      survivorClaimMonthIdx: survivorClaimMonthIdxFor(member),
    };
  };
  const deceasedFor = (member: SsContextMember, deathYear: number | null): DeceasedMember => {
    const b = birthYearMonth(member);
    return {
      // Pre-reduced so survivorBenefitAnnual does not double-reduce.
      pia: (member.pia ?? 0) * reductionFactor,
      fraMonths: fraMonthsFor(member),
      scenarioClaimAgeMonths: claimAgeMonths(member.claimAge),
      // Death is Dec 31 of `deathYear`, so the age is taken at Jan 1 of `deathYear + 1`: a claim between the birthday and Dec 31 of that year is not posthumous.
      deathAgeMonths:
        b && deathYear !== null
          ? (deathYear + 1 - b.year) * 12 - b.month0
          : member.lifeExpectancyAge * 12,
      deathYear: deathYear ?? 0,
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

/** A benefit's first entitlement start. Callers supply only the member's first-ever start (own claim or an earlier survivor start), since a further grace year needs a break in entitlement the model never has. */
export interface EntitlementStart {
  year: number;
  month0: number;
}

/**
 * Per-member earnings-test timing: the first-ever entitlement start plus the SSA grace year (20 CFR 404.435 / POMS RS
 * 02501.030), the first entitled taxable year with an entitled pre-FRA non-service month, which may be later than the
 * entitlement year. `graceYear === null` means none through the FRA year.
 */
export interface MemberEtTiming {
  start: EntitlementStart;
  graceYear: number | null;
}

/**
 * Resolves the member's SSA grace year (POMS RS 02501.030): scans from the first entitlement year to the FRA year for
 * the first with an entitled pre-FRA month at or below 1/12 of that year's exempt amount. A year with no monthly-earnings
 * series consumes it, since annual-only data cannot prove every month was a service month.
 */
export function resolveGraceYear(
  member: SsContextMember,
  start: EntitlementStart,
  etInflationPct: number,
): number | null {
  const fraYear = fraYearFor(member);
  const fraMonth0 = fraMonth0For(member);
  // No FRA frame (missing birthdate) means the test never runs; keep the entitlement year as the nominal grace year.
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

/** Outcome for one member-year: the per-month charge schedule, withheld-check count and estimate flag (no single annual factor). */
export interface MemberEarningsTestOutcome {
  estimated: boolean;
  /** Whole record-level checks charged; the engine derives per-component ARF credits from the schedule and each component's entitled months, not from this count. */
  withheldMonths: number;
  /** Per-month pay factor (12 entries): the fraction of the record-level pool paid, the same for every component on the record (§404.439 apportions a partial month proportionally); `null` when no test ran. */
  payFactorByMonth: readonly number[] | null;
}

const UNTESTED = (): MemberEarningsTestOutcome => ({
  estimated: false,
  withheldMonths: 0,
  payFactorByMonth: null,
});

/**
 * Applies the SSA earnings test to a member's chargeable pool for one year. Per 20 CFR 404.415/404.434 the pool is
 * record-level: their own (+survivor) checks, spousal excess payable on their record, and their own spousal excess. A
 * monthly earnings series makes the FRA-year sum month-precise and, in the grace year on `timing`, runs the monthly
 * non-service test too (20 CFR 404.430 / 404.435); a later benefit start with unbroken entitlement adds no grace year
 * (20 CFR 404.435(b)(2)).
 *
 * @param timing - entitlement start and grace year; absent derives them from the own retirement claim.
 * @param monthlyBenefitDollars - the actual chargeable pool per calendar month (12 entries) when checks vary within the year, else annual ÷ 12.
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
  // Direct callers: the own retirement claim is the entitlement start.
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
  year: number;
  primaryClaim: number | null;
  secondaryClaim: number | null;
  /** Absolute claim-month indices (`year × 12 + month0`) driving the spousal-excess activation month, so a midyear worker claim prorates the excess; `null` when the birthdate is missing. */
  primaryClaimMonthIdx: number | null;
  secondaryClaimMonthIdx: number | null;
  /** COLA anchor year (statement anchor, else age-62 eligibility year); COLAs compound only after it. */
  primaryColaAnchorYear: number | null;
  secondaryColaAnchorYear: number | null;
  /** Own-benefit annual bases, ARF-adjusted per year by the caller from the FRA year on. */
  primaryOwnBase: number;
  secondaryOwnBase: number;
  /** Spousal-excess bases (see `spousalExcessAnnual`), reduced independently and added to the own benefit, never composed via `max`. */
  primarySpousalExcessBase: number;
  secondarySpousalExcessBase: number;
  colaFactor: number;
  /** Prorates the claim-year benefit by the share of the year from the claim month; annual-table mode only. */
  prorateClaimYear?: boolean;
  /** `(12 − claimMonth0) / 12`, applied only in the claim year when `prorateClaimYear` is set. */
  primaryClaimYearFraction?: number;
  secondaryClaimYearFraction?: number;
}

/** One member's annual benefit split into components, since a worker's excess earnings also charge the spousal excess payable on their record. */
export interface AnnualMemberComponents {
  total: number;
  excess: number;
}

/** Annual components plus the actual per-month dollars; the year is composed from these 12 checks (`total === Σ totalByMonth`). */
export interface AnnualMemberMonthlyComponents extends AnnualMemberComponents {
  totalByMonth: number[];
  excessByMonth: number[];
}

// First month0 of `year` the spousal excess is payable: the later of the two claim months, so a midyear worker claim starts it midyear; 12 means no payable month this year.
function excessStartMonth0(
  year: number,
  recipientClaimIdx: number | null,
  workerClaimIdx: number | null,
  prorate: boolean,
  fallbackStartMonth0: number,
): number {
  if (!prorate) return 0;
  if (recipientClaimIdx === null || workerClaimIdx === null) {
    return fallbackStartMonth0;
  }
  const startIdx = Math.max(recipientClaimIdx, workerClaimIdx);
  const startYear = Math.floor(startIdx / 12);
  if (year < startYear) return 12;
  if (year > startYear) return 0;
  return startIdx % 12;
}

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
  // COLA compounds from the anchor year (statement or age-62 fallback), not the claim year; the claim-age adjustment is already in `ownBase`.
  const cola = Math.pow(args.colaFactor, args.year - (args.anchor ?? args.claim));
  // The claim-year fraction is (12 − claimMonth0)/12, so the payable-month start is 12 − fraction × 12.
  const ownStartMonth0 =
    args.prorate && args.year === args.claim
      ? Math.min(12, Math.max(0, Math.round(12 - args.claimYearFraction * 12)))
      : 0;
  const ownMonthly = (args.ownBase * cola) / 12;
  // The excess derives from the worker's PIA, so its COLA compounds from the worker's anchor.
  const spousalCola = Math.pow(
    args.colaFactor,
    args.year - (args.workerAnchor ?? args.workerClaim ?? args.claim),
  );
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
  // Dual entitlement (POMS RS 00615.020): own plus independently reduced excess, month by month.
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

const emptyMonthlyComponents = (): AnnualMemberMonthlyComponents => ({
  total: 0,
  excess: 0,
  totalByMonth: new Array<number>(12).fill(0),
  excessByMonth: new Array<number>(12).fill(0),
});

/**
 * Per-member annual benefits for `projectSsByYear` in one calendar year: own-benefit COLA plus the deemed-filing
 * dual-entitlement excess (POMS RS 00615.020), reduced separately and added (not the larger of the two). The excess COLAs
 * from the worker's anchor and activates at the worker's claim month, prorated in that year. Survivor overrides are
 * applied elsewhere (`applyAnnualSurvivorBranches`); `secondary` is `undefined` with no secondary member.
 */
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
 * DRC portion of the adjustment factor payable in month `idx`. Delayed-retirement credits earned in calendar year N are
 * first payable in January N+1 (POMS RS 00615.690), except those earned in the year the beneficiary turns 70 and later
 * months, which are payable immediately. Claims at or below FRA return the static `adjustmentFactor`; for a delayed
 * claim before 70 the factor ramps only at each January, paying credits earned through the end of the prior year.
 */
export function payableDrcFactorForMonth(
  idx: number,
  claimIdx: number,
  fraMonths: number,
  claimAgeMonths: number,
  age70Idx: number,
): number {
  if (claimAgeMonths <= fraMonths) {
    return 1.0;
  }
  if (idx >= age70Idx) return adjustmentFactor(fraMonths, claimAgeMonths);
  // The delay spans month indices [fraIdx, claimIdx − 1]; a delay month in year Y is payable once `idx ≥ (Y+1) × 12`.
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

export interface MonthlyIterationInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  primaryClaiming: boolean;
  secondaryClaiming: boolean;
  idx: number;
  primaryClaimIdx: number | null;
  secondaryClaimIdx: number | null;
  primaryColaPow: number;
  secondaryColaPow: number;
  /** Own annual base without the DRC portion (reductions and the at-FRA factor still applied); the payable DRC factor is layered per month. ARF-adjusted per year from the FRA year on. */
  primaryOwnBaseNoDrc: number;
  secondaryOwnBaseNoDrc: number;
  primaryPayableDrc: number;
  secondaryPayableDrc: number;
  primarySpousalExcessBase: number;
  secondarySpousalExcessBase: number;
  colaFactor: number;
}

/**
 * Per-member annualized benefits for `projectSsByMonth` in one calendar month: own-benefit COLA plus the deemed-filing
 * dual-entitlement excess at month-index precision. `total` (own + excess) comes with the `excess` portion so the
 * caller can apply the earnings-test schedules component-wise; `secondary` is `undefined` with no secondary member.
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
    const ownNow = inp.primaryOwnBaseNoDrc * inp.primaryPayableDrc * cola;
    // Worker = secondary, recipient = primary; COLA from the worker's anchor.
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

/** Own annual base without the DRC portion: equals `ownClaimBenefitAnnual` at or below FRA, and for delayed claims strips the DRC multiplier so the monthly engine can layer `payableDrcFactorForMonth` on top. */
export function ownBaseNoDrcAnnual(
  member: SsContextMember,
  reductionFactor: number,
): number {
  if (member.pia === null || member.pia <= 0) return 0;
  const fra = fraMonthsFor(member);
  const claim = claimAgeMonths(member.claimAge);
  const ageForBase = Math.min(claim, fra);
  const monthly = monthlyBenefitAtAge(member.pia, fra, ageForBase);
  return monthly * 12 * reductionFactor;
}
