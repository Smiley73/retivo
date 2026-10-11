/**
 * Spousal deemed-filing eligibility and survivor (widow[er]) benefit
 * formulas, extracted from `ss-projection.ts` so that file stays under
 * the ≤400-line shape limit.
 *
 * Deemed filing (POMS RS 00615.014 / RS 00615.015): the spousal excess
 * applies only when (a) the worker has already claimed AND (b) the
 * recipient is at or past their own claim age. Helper is
 * position-generic — callers supply year-mode positions (projectSsByYear)
 * or month-index-mode positions (projectSsByMonth).
 *
 * Survivor benefit (42 USC 402(e)/(f); POMS RS 00615.301 / RS 00615.320):
 * the widow(er)'s ORIGINAL benefit derives from the deceased's PIA (plus
 * any delayed-retirement credits the deceased actually earned — never the
 * deceased's early-claim reduction), reduced by the SURVIVOR's own
 * early-claim reduction at their SURVIVOR claim age — a claim age SEPARATE
 * from the survivor's own retirement claim age. The reduction schedule
 * runs against the WIDOW(ER) FRA cohort table (POMS RS 00615.003 — the
 * retirement schedule shifted two birth cohorts later, at most 4 months
 * earlier in age for 1943–1961 cohorts), and
 * the statutory reduction AMOUNT is rounded UP to the next dime before
 * subtraction (POMS RS 00615.301). When the deceased was receiving a
 * REDUCED retirement benefit, RIB-LIM caps the widow(er) benefit at the
 * larger of that reduced benefit — reconstructed with the deceased's own
 * ARF credits for earnings-test-withheld months (POMS RS 00615.482) —
 * and 82.5% of the PIA. A missing survivor claim age WITHHOLDS the
 * deceased component (no silent early-claim or FRA default); callers
 * surface the missing input.
 *
 * See `docs/math-social-security-and-health.md` (spousal and survivor
 * benefits) for the rules in plain words.
 */
import { monthlyBenefitAtAge, survivorEarlyFactor } from './ssa-formulas';

/**
 * Returns true when the spousal excess is active at `recipientCurrentPosition`.
 *
 * Position-generic: pass year values for projectSsByYear, month-index
 * values (year × 12 + month0) for projectSsByMonth. The caller computes
 * `recipientClaimPosition` in the same coordinate space.
 *
 * @param workerHasClaimedAtPosition - true when the worker's claim
 *   position ≤ the current position (i.e. worker has already claimed).
 * @param recipientCurrentPosition - the position being evaluated.
 * @param recipientClaimPosition - the position at which the recipient
 *   begins their own claim (spousal activates at or after this).
 */
export function deemedFilingEligible(
  workerHasClaimedAtPosition: boolean,
  recipientCurrentPosition: number,
  recipientClaimPosition: number,
): boolean {
  return workerHasClaimedAtPosition && recipientCurrentPosition >= recipientClaimPosition;
}

/**
 * RIB-LIM floor fraction (POMS RS 00615.320): when the deceased claimed a
 * reduced retirement benefit before FRA, the widow(er) benefit is capped at
 * the LARGER of the deceased's actual reduced benefit and 82.5% of the PIA.
 */
export const RIB_LIM_PIA_FRACTION = 0.825;

/**
 * Statutory spousal fraction (42 USC 402(b)/(c)): the spousal benefit is
 * anchored at 50% of the worker's PIA; the dual-entitlement EXCESS is
 * `max(0, SPOUSAL_PIA_FRACTION × workerPIA − recipientPIA)`.
 */
export const SPOUSAL_PIA_FRACTION = 0.5;

export interface SurvivorMember {
  /** Survivor's WIDOW(ER) FRA in total months — the survivor cohort table
   *  (POMS RS 00615.003), NOT the retirement FRA. Drives the widow(er)
   *  early-claim reduction sliding scale (71.5% at 60 → 100% at
   *  survivor FRA). */
  survivorFraMonths: number;
  /**
   * The survivor's SURVIVOR-BENEFIT claim age in total months — a separate
   * decision from their own retirement claim age (42 USC 402(e)/(f)).
   * `null` = no survivor claim age on file → the deceased component is
   * WITHHELD and `survivorBenefitAnnual` returns `null`.
   */
  survivorClaimAgeMonths: number | null;
  /**
   * Absolute month index (`year × 12 + month0`) the survivor reaches the
   * survivor claim age, from the benefit-purpose birth month — month-precise
   * so a midyear entitlement start prorates the annual rollup and the forced
   * later start (death after the chosen age) shrinks the reduction exactly.
   * `null` when withheld or the birthdate is missing/invalid.
   */
  survivorClaimMonthIdx: number | null;
}

export interface DeceasedMember {
  /** Monthly PIA in today's dollars, already reduced by the caller's
   *  across-the-board `reductionFactor`. */
  pia: number;
  /** Retirement FRA in total months (the deceased's own RIB schedule). */
  fraMonths: number;
  /** Scenario claim age in total months (pre-death-cap). */
  scenarioClaimAgeMonths: number;
  /** Deceased member's age in months at the exclusive death boundary —
   *  death is Dec 31 of `deathYear`, so this is the age at Jan 1 of
   *  `deathYear + 1` (the same boundary `deathMonthFor` uses, not the
   *  birthday of the life-expectancy year). */
  deathAgeMonths: number;
  /** Calendar year the member died (last alive year — death is Dec 31). */
  deathYear: number;
  /** COLA anchor for the deceased component: the statement anchor year when
   *  a `piaAsOfDate` exists, else the age-62 eligibility year. */
  colaAnchorYear: number;
}

/** Round a dollar amount UP to the next $0.10 (POMS RS 00615.301 — the
 *  widow(er) reduction amount rounds up to the next higher dime). The tiny
 *  epsilon keeps exact-dime Float64 values from ratcheting a cent up. */
const roundUpToDime = (dollars: number): number =>
  Math.ceil(dollars * 10 - 1e-9) / 10;

/** Absolute month index the survivor benefit actually starts: the LATER of
 *  the survivor's chosen claim month and the exclusive death boundary
 *  (Jan of `deathYear + 1`). `null` when the claim age is withheld.
 *  Module-private: consumers read it via `survivorStartYearFraction`. */
function survivorStartMonthIdx(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
): number | null {
  if (survivor.survivorClaimMonthIdx === null) return null;
  return Math.max(survivor.survivorClaimMonthIdx, (deceased.deathYear + 1) * 12);
}

/** First month0 of `year` the survivor benefit is payable:
 *  `0` for full years after the start, the start month0 in the start
 *  year, `12` (no payable month) before the start, and `0` when the start
 *  is unknown (withheld — the fold then no-ops on the `null` component). */
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

/**
 * Annual widow(er) DECEASED-COMPONENT benefit for the surviving spouse in
 * `currentYear`, in nominal dollars — the amount derived from the deceased's
 * record. The caller composes it with the survivor's own current benefit
 * (via `foldSurvivor`); this function no longer re-computes the own side.
 *
 * `deceased.pia` is expected to be **already reduced** by the caller's
 * `reductionFactor` (the across-the-board haircut); no additional reduction
 * is applied here.
 *
 * @param survivor - survivor-side struct (widow[er] FRA + claim month)
 * @param deceased - deceased-side struct (pre-reduced PIA + death facts)
 * @param currentYear - calendar year being evaluated
 * @param colaPct - annual COLA percent (compounds from the deceased anchor)
 * @param deceasedWithheldMonths - whole checks withheld from the DECEASED
 *   under the earnings test while alive; reconstructs the deceased's
 *   ARF-adjusted reduced RIB for the RIB-LIM comparison (POMS RS 00615.482
 *   — ARF applies at death for survivor purposes). 0 = none/unknown.
 *
 * Returns:
 *  - `null` when the survivor has NO survivor claim age on file — the result
 *    is withheld and the caller flags the missing input;
 *  - `0` before the start year (the later of the survivor's chosen claim
 *    month and `deathYear + 1` — death is Dec 31 of `deathYear`);
 *  - the nominal annual run-rate otherwise (the caller prorates the start
 *    year in the annual table via `survivorStartYearFraction`).
 */
/**
 * Widow(er) monthly amount before COLA: the original-benefit base, minus
 * the dime-rounded early reduction, capped by RIB-LIM (with the
 * deceased's own ARF credits). Split from `survivorBenefitAnnual`
 * to keep both under the 60-line shape cap.
 */
function widowMonthlyFor(
  survivor: SurvivorMember,
  deceased: DeceasedMember,
  effectiveSurvivorAgeMonths: number,
  deceasedWithheldMonths: number,
): number {
  // Widow(er) original-benefit base (monthly):
  //  - deceased claimed (or died un-claimed) AFTER FRA → PIA plus the DRCs
  //    actually earned, capped at the death age (no posthumous
  //    credits); the widow inherits delayed-retirement credits.
  //  - otherwise → the FULL PIA. The deceased's early-claim reduction does
  //    NOT flow into the widow base — RIB-LIM below is the statutory cap
  //    for an early-claiming deceased (POMS RS 00615.320).
  const effDeceasedClaimMonths = Math.min(
    deceased.scenarioClaimAgeMonths,
    deceased.deathAgeMonths,
  );
  const widowBaseMonthly =
    effDeceasedClaimMonths > deceased.fraMonths
      ? monthlyBenefitAtAge(deceased.pia, deceased.fraMonths, effDeceasedClaimMonths)
      : deceased.pia;

  // Per POMS RS 00615.301 the statutory REDUCTION AMOUNT is computed,
  // rounded UP to the next dime, and subtracted — never a raw factor
  // multiplication (the two differ by up to $0.10/month).
  const earlyFactor = survivorEarlyFactor(
    effectiveSurvivorAgeMonths,
    survivor.survivorFraMonths,
  );
  const reductionAmount = roundUpToDime(widowBaseMonthly * (1 - earlyFactor));
  let widowMonthly = widowBaseMonthly - reductionAmount;

  // RIB-LIM (POMS RS 00615.320): the deceased was RECEIVING a reduced
  // retirement benefit (claimed early, before dying) → cap the widow(er)
  // benefit at max(deceased's actual reduced benefit, 82.5% of PIA). The
  // "actual reduced benefit" carries the deceased's own ARF credits —
  // months withheld under the earnings test are removed from the reduction
  // (POMS RS 00615.482 applies the adjustment at death for survivors).
  // STRICT `<` — `deathAgeMonths` is the age at the EXCLUSIVE Jan-1
  // death boundary, so a claim landing exactly on it would have begun the
  // month after the Dec-31 death: the deceased was never entitled to a
  // reduced RIB before dying and RIB-LIM must not apply.
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
    // Never default a survivor claim age — withhold and surface.
    return null;
  }
  // Start at the LATER of the chosen survivor claim month and the month
  // after death (deceased alive through Dec 31 of deathYear).
  const startIdx = survivorStartMonthIdx(survivor, deceased) as number;
  const startYear = Math.floor(startIdx / 12);
  if (currentYear < startYear) return 0;

  // The widow(er) reduction keys off the survivor's age when the benefit
  // actually STARTS: the chosen claim age, pushed later month-for-month
  // when death occurs after it (a later start shrinks the reduction).
  const effectiveSurvivorAgeMonths =
    survivor.survivorClaimAgeMonths + (startIdx - survivor.survivorClaimMonthIdx);
  const widowMonthly = widowMonthlyFor(
    survivor,
    deceased,
    effectiveSurvivorAgeMonths,
    deceasedWithheldMonths,
  );

  // Nominal at currentYear: COLA compounds from the deceased's anchor year
  // (statement anchor when present).
  const colaFactor = 1 + colaPct / 100;
  return (
    widowMonthly * 12 * Math.pow(colaFactor, currentYear - deceased.colaAnchorYear)
  );
}

// ---------------------------------------------------------------------------
// Survivor-branch helpers for projectSsByYear and projectSsByMonth.
// ---------------------------------------------------------------------------

export interface SurvivorStructs {
  primarySurvivor: SurvivorMember;
  secondarySurvivor: SurvivorMember | null;
  primaryDeceased: DeceasedMember | null;
  secondaryDeceased: DeceasedMember | null;
}

/**
 * The shared null-withheld/step-up fold both engines apply per
 * survivor branch. `sv === null` = withheld → the member keeps
 * `current` and the row is flagged. Otherwise the member steps up to the
 * survivor level: `max(current, sv)` (the monthly engine is month-exact;
 * the annual engine applies the same fold per month via
 * `foldSurvivorByMonth`).
 */
function foldSurvivor(
  sv: number | null,
  current: number,
): { value: number; withheld: boolean } {
  if (sv === null) return { value: current, withheld: true };
  return { value: Math.max(current, sv), withheld: false };
}

/**
 * The annual engine's month-wise survivor fold. Each payable month
 * (at/after the entitlement-start month) steps up to
 * `max(current-month check, survivor monthly)`; pre-start months keep the
 * member's own-only checks. Replaces the retired fraction blend
 * `current + (svAnnual − currentAnnual) × fraction`, which double-counted
 * part of an already-prorated `current` when the own benefit ALSO started
 * midyear in the same calendar year.
 */
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

/** One annual survivor branch: deceased component + month-wise fold from
 *  the entitlement-start month. Shared by both member
 *  directions. */
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

/** One monthly survivor branch: deceased component + plain max fold (the
 *  monthly engine is month-exact — no proration). */
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

/** Inputs for `applyAnnualSurvivorBranches`. */
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
  /** Earnings-test months withheld from the PRIMARY while alive (feeds
   *  the deceased-side ARF-adjusted RIB when the primary is the deceased). */
  primaryDeceasedWithheldMonths?: number;
  /** Same for the secondary. */
  secondaryDeceasedWithheldMonths?: number;
}

/**
 * Applies the widow(er) deceased-component step-up for `projectSsByYear`,
 * month-wise: each payable month steps up to `max(current-month
 * check, survivor monthly)` from the entitlement-start month.
 * Returns the updated per-month check arrays plus a `survivorWithheld`
 * flag — true when a survivor step-up WOULD apply this year but the
 * surviving member has no survivor claim age (withheld).
 *
 * @param inp - survivor structs + alive flags for the current year
 * @param primaryByMonth - own+spousal ACTUAL dollars per calendar month
 *   from `computeAnnualMemberBenefits` (12 entries)
 * @param secondaryByMonth - same (or `undefined` if no secondary)
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

  // Secondary survives primary.
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

  // Primary survives secondary.
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

/** Inputs for `applyMonthlySurvivorBranches`. */
export interface MonthlySurvivorInputs {
  hasSecondary: boolean;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  /** Calendar year (for COLA exponent in `survivorBenefitAnnual`). */
  year: number;
  colaPct: number;
  /** Absolute month index for the survivor-claim gate checks. */
  idx: number;
  /** Absolute month index the PRIMARY reaches their SURVIVOR claim age
   *  (separate from the own claim age). `null` = no survivor claim age on
   *  file → withheld. */
  primarySurvivorClaimIdx: number | null;
  /** Same for the secondary. */
  secondarySurvivorClaimIdx: number | null;
  primarySurvivor: SurvivorMember;
  secondarySurvivor: SurvivorMember | null;
  primaryDeceased: DeceasedMember | null;
  secondaryDeceased: DeceasedMember | null;
  /** Earnings-test months withheld from the PRIMARY while alive. */
  primaryDeceasedWithheldMonths?: number;
  /** Same for the secondary. */
  secondaryDeceasedWithheldMonths?: number;
}

/**
 * Applies the widow(er) deceased-component step-up for `projectSsByMonth`.
 * Gated at month-index precision on the survivor's SURVIVOR claim month —
 * NOT their own retirement claim month (the two ages are independent).
 *
 * @param inp - survivor structs + alive/claim-idx flags for the current month
 * @param primaryAnnual - own+spousal amount from `computeMonthlyMemberBenefits`
 * @param secondaryAnnual - own+spousal amount (or `undefined` if no secondary)
 */
export function applyMonthlySurvivorBranches(
  inp: MonthlySurvivorInputs,
  primaryAnnual: number,
  secondaryAnnual: number | undefined,
): { primaryAnnual: number; secondaryAnnual: number | undefined; survivorWithheld: boolean } {
  let pa = primaryAnnual;
  let sa = secondaryAnnual;
  let survivorWithheld = false;

  // Secondary survives primary — gate on the secondary's SURVIVOR claim month.
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

  // Primary survives secondary — gate on the primary's SURVIVOR claim month.
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
