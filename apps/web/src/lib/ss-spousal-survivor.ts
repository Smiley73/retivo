/**
 * Spousal deemed filing (POMS RS 00615.014 / RS 00615.015) and survivor (widow[er]) benefit formulas (42 USC 402(e)/(f);
 * POMS RS 00615.301 / RS 00615.320). See docs/math-social-security-and-health.md, "Survivor benefits".
 */
import { monthlyBenefitAtAge, survivorEarlyFactor } from './ssa-formulas';

/**
 * True when the spousal excess is active: the worker has claimed and the recipient is at or past their own claim
 * position. Position-generic: years for `projectSsByYear`, month indices (year × 12 + month0) for `projectSsByMonth`.
 */
export function deemedFilingEligible(
  workerHasClaimedAtPosition: boolean,
  recipientCurrentPosition: number,
  recipientClaimPosition: number,
): boolean {
  return workerHasClaimedAtPosition && recipientCurrentPosition >= recipientClaimPosition;
}

/** RIB-LIM floor fraction (POMS RS 00615.320): a widow(er) benefit is capped at the larger of the deceased's actual reduced benefit and this share of the PIA. */
export const RIB_LIM_PIA_FRACTION = 0.825;

/** Statutory spousal fraction (42 USC 402(b)/(c)): 50% of the worker's PIA; the dual-entitlement excess is `max(0, fraction × workerPIA − recipientPIA)`. */
export const SPOUSAL_PIA_FRACTION = 0.5;

export interface SurvivorMember {
  /** Widow(er) FRA in months from the survivor cohort table (POMS RS 00615.003), not the retirement FRA. */
  survivorFraMonths: number;
  /** Survivor-benefit claim age in months, separate from the own retirement claim age; `null` withholds the deceased component and `survivorBenefitAnnual` returns `null`. */
  survivorClaimAgeMonths: number | null;
  /** Absolute month index (`year × 12 + month0`) the survivor reaches the claim age, from the benefit-purpose birth month, so a midyear start prorates the annual rollup; `null` when withheld or the birthdate is missing or invalid. */
  survivorClaimMonthIdx: number | null;
}

export interface DeceasedMember {
  /** Monthly PIA in today's dollars, already reduced by the across-the-board `reductionFactor`. */
  pia: number;
  fraMonths: number;
  scenarioClaimAgeMonths: number;
  /** Age in months at the exclusive death boundary (Jan 1 of `deathYear + 1`; death is Dec 31), the boundary `deathMonthFor` uses. */
  deathAgeMonths: number;
  deathYear: number;
  /** COLA anchor: the statement anchor year when a `piaAsOfDate` exists, else the age-62 eligibility year. */
  colaAnchorYear: number;
}

// Rounds UP to the next $0.10 (POMS RS 00615.301: the widow(er) reduction amount rounds up to the next higher dime); the epsilon keeps exact-dime Float64 values from ratcheting a cent.
const roundUpToDime = (dollars: number): number =>
  Math.ceil(dollars * 10 - 1e-9) / 10;

// Absolute month index the survivor benefit starts: the later of the chosen claim month and the exclusive death boundary (Jan of `deathYear + 1`); `null` when withheld.
function survivorStartMonthIdx(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
): number | null {
  if (survivor.survivorClaimMonthIdx === null) return null;
  return Math.max(survivor.survivorClaimMonthIdx, (deceased.deathYear + 1) * 12);
}

/** First month0 of `year` the survivor benefit is payable: 0 after the start year, the start month0 in it, 12 (none) before it, and 0 when withheld. */
export function survivorStartMonth0(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
  year: number,
): number {
  const startIdx = survivorStartMonthIdx(survivor, deceased);
  if (startIdx === null) return 0;
  const startYear = Math.floor(startIdx / 12);
  if (year < startYear) return 12;
  if (year > startYear) return 0;
  return startIdx % 12;
}

function widowMonthlyFor(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
  effectiveSurvivorAgeMonths: number,
  deceasedWithheldMonths: number,
): number {
  // Base: PIA plus the delayed credits the deceased actually earned (capped at the death age) when claiming after FRA, else the
  // full PIA; the deceased's early-claim reduction does not flow into it, since RIB-LIM below is the statutory cap.
  const effDeceasedClaimMonths = Math.min(
    deceased.scenarioClaimAgeMonths,
    deceased.deathAgeMonths,
  );
  const widowBaseMonthly =
    effDeceasedClaimMonths > deceased.fraMonths
      ? monthlyBenefitAtAge(deceased.pia, deceased.fraMonths, effDeceasedClaimMonths)
      : deceased.pia;

  // POMS RS 00615.301: the reduction amount is computed and rounded up to the next dime before subtracting, never a raw
  // factor multiply (they differ by up to $0.10/month).
  const earlyFactor = survivorEarlyFactor(
    effectiveSurvivorAgeMonths,
    survivor.survivorFraMonths,
  );
  const reductionAmount = roundUpToDime(widowBaseMonthly * (1 - earlyFactor));
  let widowMonthly = widowBaseMonthly - reductionAmount;

  // RIB-LIM (POMS RS 00615.320): a deceased who was receiving a reduced benefit caps the widow(er) benefit at max(actual
  // reduced benefit, 82.5% of PIA), where the actual benefit carries the deceased's ARF credits for months withheld under
  // the earnings test (POMS RS 00615.482). Strict `<`: a claim exactly on the exclusive death boundary began after the
  // Dec-31 death, so RIB-LIM does not apply.
  const deceasedClaimedBeforeDeath =
    deceased.scenarioClaimAgeMonths < deceased.deathAgeMonths;
  if (deceasedClaimedBeforeDeath && deceased.scenarioClaimAgeMonths < deceased.fraMonths) {
    const arfAdjustedClaimMonths = Math.min(
      deceased.fraMonths,
      deceased.scenarioClaimAgeMonths + Math.max(0, deceasedWithheldMonths),
    );
    const deceasedActualMonthly = monthlyBenefitAtAge(
      deceased.pia,
      deceased.fraMonths,
      arfAdjustedClaimMonths,
    );
    widowMonthly = Math.min(
      widowMonthly,
      Math.max(RIB_LIM_PIA_FRACTION * deceased.pia, deceasedActualMonthly),
    );
  }
  return widowMonthly;
}

/**
 * Annual widow(er) deceased-component benefit in nominal dollars for `currentYear`; the caller folds it with the
 * survivor's own benefit. `deceased.pia` is already reduced by the across-the-board haircut. Returns `null` when the
 * survivor has no claim age on file (withheld; the caller flags it), `0` before the start year (the later of the claim
 * month and `deathYear + 1`), else the nominal annual run-rate (the start year is prorated via
 * `survivorStartYearFraction`). `deceasedWithheldMonths` reconstructs the deceased's ARF-adjusted reduced benefit for
 * RIB-LIM (POMS RS 00615.482).
 */
export function survivorBenefitAnnual(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
  currentYear: number,
  colaPct: number,
  deceasedWithheldMonths = 0,
): number | null {
  if (
    survivor.survivorClaimAgeMonths === null ||
    survivor.survivorClaimMonthIdx === null
  ) {
    return null;
  }
  const startIdx = survivorStartMonthIdx(survivor, deceased) as number;
  const startYear = Math.floor(startIdx / 12);
  if (currentYear < startYear) return 0;

  // The reduction keys off the survivor's age when the benefit starts: the claim age pushed later month-for-month when death follows it.
  const effectiveSurvivorAgeMonths =
    survivor.survivorClaimAgeMonths + (startIdx - survivor.survivorClaimMonthIdx);
  const widowMonthly = widowMonthlyFor(
    survivor,
    deceased,
    effectiveSurvivorAgeMonths,
    deceasedWithheldMonths,
  );

  // COLA compounds from the deceased's anchor year.
  const colaFactor = 1 + colaPct / 100;
  return (
    widowMonthly * 12 * Math.pow(colaFactor, currentYear - deceased.colaAnchorYear)
  );
}

export interface SurvivorStructs {
  primarySurvivor: SurvivorMember;
  secondarySurvivor: SurvivorMember | null;
  primaryDeceased: DeceasedMember | null;
  secondaryDeceased: DeceasedMember | null;
}

// `sv === null` is withheld: the member keeps `current` and the row is flagged; otherwise it steps up to `max(current, sv)`.
function foldSurvivor(
  sv: number | null,
  current: number,
): { value: number; withheld: boolean } {
  if (sv === null) return { value: current, withheld: true };
  return { value: Math.max(current, sv), withheld: false };
}

// The annual engine's month-wise fold: each payable month (from the entitlement-start month) steps up to max(current check,
// survivor monthly); earlier months keep own-only checks. A fraction blend would double-count an own benefit that also started midyear.
function foldSurvivorByMonth(
  sv: number | null,
  currentByMonth: ReadonlyArray<number>,
  startMonth0: number,
): { byMonth: number[]; withheld: boolean } {
  if (sv === null) return { byMonth: [...currentByMonth], withheld: true };
  const svMonthly = sv / 12;
  return {
    byMonth: currentByMonth.map((c, m) => (m >= startMonth0 ? Math.max(c, svMonthly) : c)),
    withheld: false,
  };
}

function annualSurvivorBranch(args: {
  survivor: SurvivorMember;
  deceased: DeceasedMember;
  year: number;
  colaPct: number;
  currentByMonth: ReadonlyArray<number>;
  deceasedWithheldMonths: number;
}): { byMonth: number[]; withheld: boolean } {
  const sv = survivorBenefitAnnual(
    args.survivor,
    args.deceased,
    args.year,
    args.colaPct,
    args.deceasedWithheldMonths,
  );
  return foldSurvivorByMonth(
    sv,
    args.currentByMonth,
    survivorStartMonth0(args.survivor, args.deceased, args.year),
  );
}

function monthlySurvivorBranch(args: {
  survivor: SurvivorMember;
  deceased: DeceasedMember;
  year: number;
  colaPct: number;
  current: number;
  deceasedWithheldMonths: number;
}): { value: number; withheld: boolean } {
  const sv = survivorBenefitAnnual(
    args.survivor,
    args.deceased,
    args.year,
    args.colaPct,
    args.deceasedWithheldMonths,
  );
  return foldSurvivor(sv, args.current);
}

export interface AnnualSurvivorInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  year: number;
  colaPct: number;
  primarySurvivor: SurvivorMember;
  secondarySurvivor: SurvivorMember | null;
  primaryDeceased: DeceasedMember | null;
  secondaryDeceased: DeceasedMember | null;
  /** Earnings-test months withheld from the primary while alive; feeds the deceased-side ARF-adjusted RIB. */
  primaryDeceasedWithheldMonths?: number;
  secondaryDeceasedWithheldMonths?: number;
}

/**
 * Applies the widow(er) deceased-component step-up for `projectSsByYear`, month-wise: each payable month steps up to
 * max(current-month check, survivor monthly) from the entitlement-start month. `survivorWithheld` is true when a
 * step-up would apply but the survivor has no claim age on file.
 */
export function applyAnnualSurvivorBranches(
  inp: AnnualSurvivorInputs,
  primaryByMonth: ReadonlyArray<number>,
  secondaryByMonth: ReadonlyArray<number> | undefined,
): {
  primaryByMonth: ReadonlyArray<number>;
  secondaryByMonth: ReadonlyArray<number> | undefined;
  survivorWithheld: boolean;
} {
  let pa = primaryByMonth;
  let sa = secondaryByMonth;
  let survivorWithheld = false;

  if (
    inp.hasSecondary &&
    inp.secondaryAlive &&
    !inp.primaryAlive &&
    inp.secondarySurvivor !== null &&
    inp.primaryDeceased !== null
  ) {
    const folded = annualSurvivorBranch({
      survivor: inp.secondarySurvivor,
      deceased: inp.primaryDeceased,
      year: inp.year,
      colaPct: inp.colaPct,
      currentByMonth: sa ?? new Array<number>(12).fill(0),
      deceasedWithheldMonths: inp.primaryDeceasedWithheldMonths ?? 0,
    });
    if (folded.withheld) survivorWithheld = true;
    else sa = folded.byMonth;
  }

  if (
    inp.hasSecondary &&
    inp.primaryAlive &&
    !inp.secondaryAlive &&
    inp.secondaryDeceased !== null
  ) {
    const folded = annualSurvivorBranch({
      survivor: inp.primarySurvivor,
      deceased: inp.secondaryDeceased,
      year: inp.year,
      colaPct: inp.colaPct,
      currentByMonth: pa,
      deceasedWithheldMonths: inp.secondaryDeceasedWithheldMonths ?? 0,
    });
    if (folded.withheld) survivorWithheld = true;
    else pa = folded.byMonth;
  }

  return { primaryByMonth: pa, secondaryByMonth: sa, survivorWithheld };
}

export interface MonthlySurvivorInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  year: number;
  colaPct: number;
  idx: number;
  /** Absolute month index the primary reaches their survivor claim age (separate from the own claim age); `null` withholds. */
  primarySurvivorClaimIdx: number | null;
  secondarySurvivorClaimIdx: number | null;
  primarySurvivor: SurvivorMember;
  secondarySurvivor: SurvivorMember | null;
  primaryDeceased: DeceasedMember | null;
  secondaryDeceased: DeceasedMember | null;
  /** Earnings-test months withheld from the primary while alive. */
  primaryDeceasedWithheldMonths?: number;
  secondaryDeceasedWithheldMonths?: number;
}

/**
 * Applies the widow(er) deceased-component step-up for `projectSsByMonth`, gated at month precision on the survivor's
 * survivor-claim month, not their own retirement claim month (the two ages are independent).
 */
export function applyMonthlySurvivorBranches(
  inp: MonthlySurvivorInputs,
  primaryAnnual: number,
  secondaryAnnual: number | undefined,
): { primaryAnnual: number; secondaryAnnual: number | undefined; survivorWithheld: boolean } {
  let pa = primaryAnnual;
  let sa = secondaryAnnual;
  let survivorWithheld = false;

  if (
    inp.hasSecondary &&
    inp.secondaryAlive &&
    !inp.primaryAlive &&
    inp.secondarySurvivor !== null &&
    inp.primaryDeceased !== null
  ) {
    if (inp.secondarySurvivorClaimIdx === null) {
      survivorWithheld = true;
    } else if (inp.idx >= inp.secondarySurvivorClaimIdx) {
      const folded = monthlySurvivorBranch({
        survivor: inp.secondarySurvivor,
        deceased: inp.primaryDeceased,
        year: inp.year,
        colaPct: inp.colaPct,
        current: sa ?? 0,
        deceasedWithheldMonths: inp.primaryDeceasedWithheldMonths ?? 0,
      });
      if (folded.withheld) survivorWithheld = true;
      else sa = folded.value;
    }
  }

  if (
    inp.hasSecondary &&
    inp.primaryAlive &&
    !inp.secondaryAlive &&
    inp.secondaryDeceased !== null
  ) {
    if (inp.primarySurvivorClaimIdx === null) {
      survivorWithheld = true;
    } else if (inp.idx >= inp.primarySurvivorClaimIdx) {
      const folded = monthlySurvivorBranch({
        survivor: inp.primarySurvivor,
        deceased: inp.secondaryDeceased,
        year: inp.year,
        colaPct: inp.colaPct,
        current: pa,
        deceasedWithheldMonths: inp.secondaryDeceasedWithheldMonths ?? 0,
      });
      if (folded.withheld) survivorWithheld = true;
      else pa = folded.value;
    }
  }

  return { primaryAnnual: pa, secondaryAnnual: sa, survivorWithheld };
}
