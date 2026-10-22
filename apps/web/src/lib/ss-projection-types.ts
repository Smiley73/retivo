/** Shared Social Security projection types, split out so ss-projection-helpers.ts and ss-context-builder.ts avoid a cycle with ss-projection.ts. */
import type {
  HouseholdMemberPayload,
  RetirementAgePerMember,
} from '../db/types';

export interface SsContextMember {
  id: string;
  payload: HouseholdMemberPayload;
  pia: number | null;
  claimAge: RetirementAgePerMember; // years + months
  lifeExpectancyAge: number; // whole years
  /**
   * Calendar year of the member's SSA statement `piaAsOfDate`: the quoted FRA benefit already includes COLAs
   * through it, so COLAs layer only after this year. Absent falls back to the age-62 eligibility year.
   */
  statementAnchorYear?: number;
  /**
   * Survivor claim age, separate from the own claim age (42 USC 402(e)/(f); payable from 60). Absent withholds
   * survivor-dependent results (no silent default) and year outputs carry `survivorWithheld: true`.
   */
  survivorClaimAge?: RetirementAgePerMember;
  /** Earned income by calendar year in dollars (part-time streams only); drives the SSA earnings test. Absent or empty means no test. */
  earnedIncomeByYear?: Readonly<Record<number, number>>;
  /** Actual monthly earned income by year (12 entries, Jan..Dec); makes the earnings test month-precise (20 CFR 404.430 / 404.435). */
  earnedIncomeMonthlyByYear?: Readonly<Record<number, ReadonlyArray<number>>>;
}

export interface SsContext {
  primary: SsContextMember;
  secondary?: SsContextMember;
  /** Annual COLA percent, compounded on every member's benefit including spousal and survivor. */
  colaPct: number;
  /** Across-the-board haircut (0 / 10 / 25 / 50): the trust-fund-shortfall what-if. */
  benefitReductionPct: number;
  /** Inflation percent for extrapolating earnings-test exempt amounts past the published range; read only with `earnedIncomeByYear`, default 0. */
  earningsTestInflationRatePct?: number;
}

export interface SsYearOutput {
  year: number;
  total: number;
  byMember: { primary: number; secondary?: number };
  /** True when the earnings-test reduction used an extrapolated exempt amount (a year beyond the published range). */
  earningsTestEstimated?: boolean;
  /**
   * True when a survivor step-up would apply (one member dead) but the survivor has no claim age on file, so
   * the deceased-spouse component is withheld and the missing input must be surfaced.
   */
  survivorWithheld?: boolean;
}

/**
 * Per-month SS sample for the cashflow chart bands: annualized run-rates in $/yr (mean over the 12 months is
 * the annual sum), 0 before claim, COLA at January, survivor and spousal switches at the death month. The
 * annual fn matches its claim-year proration and survivor start, but differs in DRC timing for claims between
 * FRA and 70: the monthly engine defers each year's credits to the next January, the annual fn applies the
 * full factor from the claim year. Monthly is the more accurate read.
 */
export interface SsMonthOutput {
  fractionalYear: number;
  year: number;
  month0: number;
  total: number;
  byMember: { primary: number; secondary?: number };
  survivorWithheld?: boolean;
}

/** Per-member, per-year earnings-test and FRA-restoration state shared by the annual and monthly engines, so both agree on the ARF-adjusted own base and reduction ratio. */
export interface MemberYearEtState {
  /**
   * Own-benefit annual base (nominal at the COLA anchor, pre-COLA, across-the-board reduction applied). From
   * the FRA year it reflects ARF restoration (POMS RS 00615.482): months withheld before FRA leave the
   * early-claim reduction. Per 20 CFR 404.412(b) the increase starts with the FRA month, so in the FRA year
   * this base applies from `fraMonth0`; earlier months pay `preFraOwnBaseAnnual`.
   */
  adjustedOwnBaseAnnual: number;
  /** Spousal-excess annual base, ARF-restored from the FRA year independently of the own benefit. */
  adjustedExcessBaseAnnual: number;
  /**
   * Pay factors ([0, 1], 12 months) for the charge from the member's own excess earnings, computed over the
   * record-level pool (20 CFR 404.415/404.434) and applied to the own+survivor portion (§404.439
   * proportional apportionment). `null` when no test ran (full pay).
   */
  ownPayFactorByMonth: ReadonlyArray<number> | null;
  /**
   * Pay factors for the spousal-excess component: the month-wise minimum of the member's own and the worker's
   * schedule (the worker's excess earnings also charge auxiliaries, 20 CFR 404.415(b)). `null` is full pay.
   */
  excessPayFactorByMonth: ReadonlyArray<number> | null;
  /** True when the year's exempt amounts were extrapolated. */
  etEstimated: boolean;
  /** Cumulative earnings-test months withheld through the end of this year (frozen after death); feeds the deceased-side ARF-adjusted RIB for the survivor RIB-LIM cap. */
  cumulativeWithheldMonths: number;
  /** Set only for the FRA year (20 CFR 404.412(b)) when ARF credits exist and FRA lands midyear: months before `fraMonth0` pay at these pre-restoration bases. */
  preFraOwnBaseAnnual?: number;
  /** Pre-restoration spousal-excess base for the same mixed FRA year. */
  preFraExcessBaseAnnual?: number;
  /** 0-indexed calendar month the member attains FRA within this year. */
  fraMonth0?: number;
}
