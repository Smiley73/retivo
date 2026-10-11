/**
 * Shared type definitions for the Social Security projection engine.
 * Extracted to a standalone module so `ss-projection-helpers.ts` and
 * `ss-context-builder.ts` can import them without a circular dependency
 * with `ss-projection.ts`.
 */
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
   * Statement COLA anchor: the calendar year of the member's SSA statement
   * `piaAsOfDate`. The statement's quoted FRA benefit already includes every
   * COLA through that date, so nominal projections layer COLAs only for years
   * AFTER this anchor (prevents double-counting COLAs already baked into
   * the statement, and back-fills none for members past age 62). Absent →
   * the engines fall back to the age-62 eligibility-year anchor (the
   * fallback for benefits with no statement date on file).
   */
  statementAnchorYear?: number;
  /**
   * Survivor-benefit claim age — SEPARATE from the member's own claim age
   * (42 USC 402(e)/(f): a widow(er) chooses when to start the survivor
   * benefit independently of their own retirement benefit; payable from age
   * 60). Absent → survivor-dependent results for this member are WITHHELD
   * (no silent early-claim or FRA default) and the year outputs carry
   * `survivorWithheld: true` so consumers can list the missing input.
   */
  survivorClaimAge?: RetirementAgePerMember;
  /**
   * Earned income (part-time wages) for this member, keyed by calendar year,
   * in dollars. Drives the SSA earnings-test reduction on this member's own
   * benefit before FRA. Absent / empty → no earnings test applied. Only
   * `IncomeStream.kind === 'partTime'` streams owned by this
   * member contribute.
   */
  earnedIncomeByYear?: Readonly<Record<number, number>>;
  /**
   * Actual per-calendar-month earned income for this member, keyed by year
   * (12 entries per year, dollars, Jan..Dec). When present, the earnings test
   * runs month-precise: the first-entitlement grace-year non-service-month
   * test and the FRA-year pre-FRA-month earnings sum both read actual monthly
   * dollars (20 CFR 404.430 / 404.435) instead of annualized approximations.
   */
  earnedIncomeMonthlyByYear?: Readonly<Record<number, ReadonlyArray<number>>>;
}

export interface SsContext {
  primary: SsContextMember;
  secondary?: SsContextMember;
  /** Annual COLA, percent. Compounded year-over-year on every member's
   *  benefit. Same value applied to spousal + survivor. */
  colaPct: number;
  /** Across-the-board haircut (0 / 10 / 25 / 50). Scenario knob; models
   *  the trust-fund-shortfall what-if. */
  benefitReductionPct: number;
  /**
   * Scenario inflation rate (percent) used to extrapolate the SSA earnings-test
   * exempt amounts for years beyond the published calibration range. Only read
   * when a member carries `earnedIncomeByYear`. Defaults to 0 when absent
   * (no future-year threshold growth).
   */
  earningsTestInflationRatePct?: number;
}

export interface SsYearOutput {
  year: number;
  /** Annual SS income (USD, nominal) the household receives this year. */
  total: number;
  /** Per-member breakdown — useful for debugging / spec test stubs. */
  byMember: { primary: number; secondary?: number };
  /**
   * True when the earnings-test reduction applied this year used an
   * extrapolated (estimated) exempt amount — i.e. the year is beyond the
   * published SSA range. Surfaced so the estimate note can flag it. Absent /
   * false when no earnings-test estimate was involved.
   */
  earningsTestEstimated?: boolean;
  /**
   * True when a survivor-benefit step-up WOULD apply this year (one member
   * dead, the other alive) but the surviving member has no survivor claim
   * age on file — the deceased-spouse component is withheld and the
   * missing input ("survivor claim age") must be surfaced to the user.
   * Absent / false otherwise.
   */
  survivorWithheld?: boolean;
}

/**
 * Per-month SS sample used by the cashflow / income-breakdown chart
 * bands. Values are annualized run-rates in $/yr at that month —
 * `mean(rate_m for m in 0..11) = annual sum`. Rate is 0 in pre-claim
 * months and steps up to the at-claim annual in the claim month.
 * COLA compounds at January each year past claim. Survivor / spousal
 * switches happen at the deceased member's death month within the
 * year so the step lands on the actual anniversary, not Jan 1.
 *
 * NOTE — the annual fn prorates the claim-year row and
 * composes the survivor-start year from its 12 monthly checks,
 * so those boundaries agree with this monthly engine.
 * The remaining intentional divergence is DRC timing: for a
 * claim between FRA and 70 the monthly engine defers each year's
 * delayed-retirement credits to the following January (paid in full
 * immediately at/after 70), while the annual fn applies the full
 * static adjustment factor from the claim year — so those ramp-up
 * years' annual rollups differ slightly. Monthly is the more
 * accurate read.
 */
export interface SsMonthOutput {
  fractionalYear: number;
  year: number;
  month0: number;
  total: number;
  byMember: { primary: number; secondary?: number };
  /** Mirror of `SsYearOutput.survivorWithheld` at month granularity. */
  survivorWithheld?: boolean;
}

/**
 * Per-member, per-year earnings-test + FRA-restoration state shared between
 * the annual and monthly engines. The annual engine computes it sequentially
 * (withheld months accumulate year over year); the monthly engine consumes
 * the same schedule so both engines agree on the ARF-adjusted own-benefit
 * base and the year-level earnings-test reduction ratio.
 */
export interface MemberYearEtState {
  /**
   * Own-benefit annual base for this year (nominal at the COLA anchor,
   * pre-COLA, across-the-board reduction applied). From the member's FRA
   * year onward this reflects the ARF restoration (POMS RS 00615.482):
   * months withheld under the earnings test before FRA are removed from the
   * early-claim reduction, so the base steps UP at FRA. The FRA
   * year's restored base already includes that same year's pre-FRA-month
   * deductions. Per 20 CFR 404.412(b), SSA effects the increase WITH the
   * FRA month, so in the FRA year this base applies only from `fraMonth0`
   * onward — months before it pay at `preFraOwnBaseAnnual`.
   */
  adjustedOwnBaseAnnual: number;
  /**
   * Spousal-EXCESS annual base for this year — like the own base,
   * ARF-restored from the member's FRA year onward: months the excess was
   * withheld under the earnings test are removed from the SPOUSAL reduction
   * factor independently of the own-benefit restoration.
   */
  adjustedExcessBaseAnnual: number;
  /**
   * Per-calendar-month pay-factor schedule (12 entries, [0, 1])
   * for the charge driven by the MEMBER's own excess earnings — computed
   * over the record-level pool (own + auxiliaries, 20 CFR 404.415/404.434)
   * and applied to the member's own(+survivor) portion (§404.439
   * proportional apportionment). `null` when no test ran this year (all
   * months pay in full).
   */
  ownPayFactorByMonth: ReadonlyArray<number> | null;
  /**
   * Per-month pay-factor schedule for the member's SPOUSAL-EXCESS
   * component — the month-wise minimum of the member's own schedule and
   * the worker's schedule (the worker's excess earnings also charge the
   * auxiliaries payable on their record, 20 CFR 404.415(b); a month
   * withheld under either charge is withheld once). `null` = full pay.
   */
  excessPayFactorByMonth: ReadonlyArray<number> | null;
  /** True when the year's exempt amounts were extrapolated. */
  etEstimated: boolean;
  /**
   * Cumulative earnings-test months withheld from this member's checks
   * through the END of this year (frozen after death — no benefit → no
   * withholding). Feeds the deceased-side ARF-adjusted RIB used by the
   * survivor RIB-LIM cap.
   */
  cumulativeWithheldMonths: number;
  /**
   * Set only for the member's FRA year (20 CFR 404.412(b)) when ARF
   * credits exist and FRA lands midyear — the year is then a MIXED-rate
   * year. Months before `fraMonth0` pay at these PRE-restoration bases;
   * months at/after `fraMonth0` pay at the adjusted (restored) bases above.
   * Absent → a single base applies to the whole year.
   */
  preFraOwnBaseAnnual?: number;
  /** Pre-restoration spousal-excess base for the same mixed FRA year. */
  preFraExcessBaseAnnual?: number;
  /** 0-indexed calendar month the member attains FRA within this year. */
  fraMonth0?: number;
}
