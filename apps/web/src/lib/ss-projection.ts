/**
 * Per-year, per-household Social Security benefit projection. Drives
 * the income-offset side of the drawdown engine.
 *
 * **Output unit: nominal.** Every `total` / `byMember` figure is in
 * nominal dollars at the calendar year — the PIA seed compounds at
 * the scenario's COLA rate from the member's COLA anchor onward, with
 * no additional inflation factor applied. Downstream consumers that
 * want a today's-dollar view apply the projection-context deflator
 * at display. The PIA itself is interpreted as
 * today's-dollar terms.
 *
 * Statutory rules modeled (see `docs/math-social-security-and-health.md` for
 * the rules in plain words):
 *  1. **Statement COLA anchor:** COLAs compound only for years AFTER
 *     the SSA statement's `piaAsOfDate` year — the statement's quoted FRA
 *     benefit already includes every COLA through that date. No statement
 *     date on file → the age-62 eligibility year is the documented fallback.
 *  2. **Dual entitlement (POMS RS 00615.020):** a dually entitled recipient
 *     receives their OWN benefit (own reduction factor) PLUS the spousal
 *     EXCESS `max(0, 50% × worker PIA − own PIA)` reduced SEPARATELY by the
 *     recipient's spousal factor — never a larger-of composition. Gated by
 *     deemed filing (POMS RS 00615.015) and the entitlement clock (reduction
 *     months count from the later of the two claims); the excess activates at
 *     the worker's actual claim MONTH.
 *  3. **Survivor benefit:** keyed to the member's SEPARATE survivor claim
 *     age against the WIDOW(ER) FRA cohort table (POMS RS 00615.003);
 *     widow(er) base = deceased's PIA (+ actual DRCs, no posthumous
 *     credits) reduced by the SURVIVOR's early factor (dime-rounded
 *     reduction amount, POMS RS 00615.301), capped by RIB-LIM (with the
 *     deceased's own ARF credits) when the deceased claimed early (POMS
 *     RS 00615.320). A missing survivor claim age WITHHOLDS the component
 *     and flags `survivorWithheld` on the output rows.
 *  4. **Earnings test:** each member's excess earnings are computed and
 *     charged RECORD-level (20 CFR 404.415/404.434): the chargeable
 *     pool combines the member's own(+survivor) checks, the spousal excess
 *     payable on their record, and their own spousal excess (dual
 *     entitlement), charged sequentially month by month at each month's
 *     ACTUAL combined check, capped by the chargeable pre-FRA pool
 *     checks (20 CFR 404.430/404.435); a partial month is apportioned
 *     proportionally across the components (§404.439 — the pool's
 *     per-month pay factor applies to each). The spousal excess carries
 *     the combined min(own, worker) per-month schedule (charged once when
 *     either record charges the month). The grace-year
 *     monthly test runs in the member's SSA grace year — the FIRST
 *     entitled taxable year containing a non-service month (POMS RS
 *     02501.030 — an all-service entitlement year defers it), seeded
 *     from the FIRST-ever entitlement start (own claim or an earlier
 *     survivor start; entitlement never breaks in the model, so a later
 *     benefit start re-grants nothing, 20 CFR 404.435(b)(2)).
 *     Withheld months are RESTORED at FRA via per-component ARF
 *     recomputation (POMS RS 00615.482) — own RIB and spousal-excess
 *     factors restore independently, and an own-RIB credit requires an
 *     ENTITLED own-RIB check actually charged (months where only a
 *     survivor check was payable restore nothing); the restoration
 *     (including the FRA year's own pre-FRA-month deductions, 20 CFR
 *     404.412) is effective only with the FRA MONTH, so the FRA year
 *     mixes pre-restoration checks before it with restored checks from it
 *     (20 CFR 404.412(b)). The earnings-test/ARF state warms up
 *     from the member's EARLIEST actual entitlement year — own claim or
 *     survivor start — even when the projection range starts later.
 *
 * Known modeled simplification (disclosed): ARF restoration of the
 * SURVIVOR reduction factor (withholding while on a pre-FRA widow[er]
 * benefit) is not recomputed at survivor FRA — the own-RIB and spousal
 * factors are; survivor-only withheld months are therefore counted toward
 * NO component's restoration (discarded, never leaked into the
 * own-RIB credit).
 *
 * `pia === null` (member entered no value) means: no own-benefit; the
 * member can still receive the spousal excess and a survivor benefit.
 *
 * Out of scope: WEP / GPO (repealed by the Social
 * Security Fairness Act, effective Jan 2025 — no individual calculation
 * required), SSI, divorced-spouse benefits, cross-border provisions.
 */
import {
  claimYearFor,
  claimMonthFor,
  claimAgeMonths,
  colaAnchorYearFor,
  fraMonthsFor,
  fraYearFor,
  fraMonth0For,
  deathMonthFor,
  monthIdx,
  deathYearFor,
  ownClaimBenefitAnnual,
  ownBaseNoDrcAnnual,
  arfAdjustedOwnBaseAnnual,
  payableDrcFactorForMonth,
  spousalExcessAnnual,
  effectiveSpousalAgeMonths,
  survivorClaimMonthIdxFor,
  buildSurvivorStructs,
  computeAnnualMemberBenefits,
  computeMonthlyMemberBenefits,
  applyEarningsTestToMember,
  resolveGraceYear,
  type AnnualMemberMonthlyComponents,
  type MemberEtTiming,
  type MemberEarningsTestOutcome,
  type SurvivorStructs,
} from './ss-projection-helpers';
import { birthYearForBenefitPurposes, birthMonthForBenefitPurposes } from './ssa-formulas';
import {
  applyAnnualSurvivorBranches,
  applyMonthlySurvivorBranches,
} from './ss-spousal-survivor';

// Re-export: backward-compat for callers that import from './ss-projection'.
export type {  SsContext, SsYearOutput, SsMonthOutput } from './ss-projection-types';
export { buildSsContext, resolveSsColaPct } from './ss-context-builder';

import type {
  SsContext,
  SsYearOutput,
  SsMonthOutput,
  MemberYearEtState,
} from './ss-projection-types';
import type { SsContextMember } from './ss-projection-types';

/**
 * Fraction of the claim year the member actually collects, derived
 * from the benefit-purpose claim month: `(12 − claimMonth0) / 12`. A
 * claim landing in January (month0 = 0) collects the whole year (1.0); a
 * December claim collects 1/12. Returns 1 when the birthdate is missing.
 *
 * The claim month0 is the member's benefit-purpose birth month (the
 * whole-year claim age lands on the birthday month). This is the
 * annual-table approximation of the monthly engine's exact month sum.
 */
function claimYearProrationFraction(member: SsContextMember): number {
  const bd = member.payload.birthdate;
  if (!bd) return 1;
  try {
    const month0 = birthMonthForBenefitPurposes(bd);
    return (12 - month0) / 12;
  } catch {
    return 1;
  }
}

/** Absolute month index the member reaches age 70 (benefit-purpose
 *  birthday). Returns `null` when the birthdate is missing/invalid. */
function age70MonthIdx(member: SsContextMember): number | null {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    const year = birthYearForBenefitPurposes(bd);
    const month0 = birthMonthForBenefitPurposes(bd);
    return monthIdx(year + 70, month0);
  } catch {
    return null;
  }
}

/** First benefit-eligible month index (age-62 full-month rule). */
function firstEligibleMonthIdxOf(member: SsContextMember): number | null {
  const bd = member.payload.birthdate;
  if (!bd) return null;
  try {
    const year = birthYearForBenefitPurposes(bd);
    const month0 = birthMonthForBenefitPurposes(bd);
    const birthdayIdx = monthIdx(year + 62, month0);
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(bd);
    const day = match ? Number(match[3]) : 2;
    return day === 1 ? birthdayIdx : birthdayIdx + 1;
  } catch {
    return null;
  }
}

/** Annual rows plus the per-member earnings-test / ARF schedule the monthly
 *  engine consumes so both engines agree on adjusted bases + reductions. */
interface AnnualComputation {
  rows: SsYearOutput[];
  primarySchedule: Map<number, MemberYearEtState>;
  secondarySchedule: Map<number, MemberYearEtState>;
}

/** Per-member precomputed inputs for the annual loop. */
interface AnnualMemberStatics {
  member: SsContextMember;
  claimYear: number | null;
  claimMonthIdx: number | null;
  claimYearFraction: number;
  deathYear: number | null;
  anchor: number | null;
  fraYear: number | null;
  /** 0-indexed calendar month FRA lands within `fraYear` — the ARF
   *  restoration boundary inside the FRA year (20 CFR 404.412(b)). */
  fraMonth0: number | null;
  ownBaseStatic: number;
  effSpousalAgeMonths: number;
  /** The member's FIRST-ever entitlement start (own
   *  retirement claim or the survivor benefit's actual start, whichever is
   *  earlier — one continuous entitlement, 20 CFR 404.435(b)(2)) plus the
   *  resolved SSA grace year — the first entitled taxable year containing a
   *  non-service month (POMS RS 02501.030), which may be LATER than the
   *  entitlement year. `null` when the member never becomes entitled. */
  etTiming: MemberEtTiming | null;
}

function buildAnnualMemberStatics(
  member: SsContextMember,
  other: SsContextMember | undefined,
  reductionFactor: number,
  etInflation: number,
): AnnualMemberStatics {
  // (20 CFR 404.435(b)(2), POMS RS 02501.030): a beneficiary gets ONE
  // grace year per continuous entitlement period — another grace year
  // requires the prior entitlement to END followed by a break of at least
  // one month before the next benefit begins. The model never terminates an
  // entitlement once it starts (the own benefit pays for life; the survivor
  // benefit continues on/above it), so only the member's FIRST-ever
  // entitlement start can seed the grace-year search: a later survivor
  // start with own entitlement continuing unbroken into it (or a later own
  // claim after an earlier survivor start) re-grants nothing. The
  // grace year itself is the first entitled year that actually CONTAINS a
  // non-service month — an all-service entitlement year defers it.
  const claimM = claimMonthFor(member);
  const otherDeath = other ? deathYearFor(other) : null;
  const svIdx = survivorClaimMonthIdxFor(member);
  const startIdxs: number[] = [];
  if (claimM) startIdxs.push(monthIdx(claimM.year, claimM.month0));
  if (svIdx !== null && otherDeath !== null) {
    // The survivor benefit's ACTUAL start: claim month pushed to the death
    // boundary (January of deathYear + 1).
    startIdxs.push(Math.max(svIdx, (otherDeath + 1) * 12));
  }
  let etTiming: MemberEtTiming | null = null;
  if (startIdxs.length > 0) {
    const firstIdx = Math.min(...startIdxs);
    const start = { year: Math.floor(firstIdx / 12), month0: firstIdx % 12 };
    etTiming = { start, graceYear: resolveGraceYear(member, start, etInflation) };
  }
  return {
    member,
    claimYear: claimYearFor(member),
    claimMonthIdx: claimM ? monthIdx(claimM.year, claimM.month0) : null,
    claimYearFraction: claimYearProrationFraction(member),
    deathYear: deathYearFor(member),
    anchor: colaAnchorYearFor(member),
    fraYear: fraYearFor(member),
    fraMonth0: fraMonth0For(member),
    ownBaseStatic: ownClaimBenefitAnnual(member, reductionFactor),
    effSpousalAgeMonths: effectiveSpousalAgeMonths(member, other),
    etTiming,
  };
}

/** Loop-carried per-member ARF state: months withheld from the member's own
 *  checks (restores the own RIB reduction) and months the spousal EXCESS was
 *  withheld (restores the spousal reduction factor independently). */
interface MemberEtCredits {
  own: number;
  excess: number;
}

interface YearPassArgs {
  ctx: SsContext;
  y: number;
  p: AnnualMemberStatics;
  s: AnnualMemberStatics | null;
  survivor: SurvivorStructs;
  reductionFactor: number;
  colaFactor: number;
  etInflation: number;
}

/** Pre-restoration bases + the FRA-month boundary for a member's
 *  mixed-rate FRA year (null = a single base applies to the whole year). */
interface PreFraSplice {
  ownBase: number;
  excessBase: number;
  month0: number;
}

interface YearPassMemberOut {
  /** Post-survivor gross (pre-earnings-test), nominal $/yr. */
  gross: number;
  /** Spousal-excess portion of `gross`. */
  excess: number;
  /** Post-earnings-test payment. */
  final: number;
  ownBase: number;
  excessBase: number;
  /** Mixed FRA-year splice info (threads into the monthly engine). */
  preFra: PreFraSplice | null;
  et: MemberEarningsTestOutcome;
  /** Month-wise min(own schedule, worker schedule) for the excess. */
  excessPayFactorByMonth: ReadonlyArray<number> | null;
  /** Months an ENTITLED own-RIB check was charged this year — the
   *  own-RIB ARF credit. Months where only a survivor (or only an excess)
   *  check was payable never count toward the own-RIB restoration. */
  ownWithheldMonths: number;
  /** Months an ENTITLED excess check was withheld (feeds the spousal ARF). */
  excessWithheldMonths: number;
}

interface YearPassOut {
  p: YearPassMemberOut;
  s: YearPassMemberOut | null;
  survivorWithheld: boolean;
}

/** Month-wise minimum of two pay-factor schedules (null = all-1s). */
function minPaySchedules(
  a: ReadonlyArray<number> | null,
  b: ReadonlyArray<number> | null,
): ReadonlyArray<number> | null {
  if (a === null && b === null) return null;
  const out = new Array<number>(12);
  for (let m = 0; m < 12; m += 1) {
    out[m] = Math.min(a?.[m] ?? 1, b?.[m] ?? 1);
  }
  return out;
}

interface YearBases {
  pOwnBase: number;
  sOwnBase: number;
  pExcessBase: number;
  sExcessBase: number;
  pPreFra: PreFraSplice | null;
  sPreFra: PreFraSplice | null;
}

/** ARF-adjusted per-year bases: own RIB and spousal excess restore
 *  INDEPENDENTLY from each member's FRA year (POMS RS 00615.482).
 *  Per 20 CFR 404.412(b), SSA effects the increase WITH the FRA month —
 *  in the member's FRA year the restored bases apply only from `fraMonth0`
 *  onward; `pPreFra`/`sPreFra` carry the pre-restoration bases for the
 *  months before it when the two differ. */
function yearArfBases(
  args: YearPassArgs,
  credits: { p: MemberEtCredits; s: MemberEtCredits },
): YearBases {
  const { ctx, y, p, s, reductionFactor } = args;
  const ownBaseFor = (st: AnnualMemberStatics, cr: MemberEtCredits): number =>
    st.fraYear !== null && y >= st.fraYear && cr.own > 0
      ? arfAdjustedOwnBaseAnnual(st.member, reductionFactor, cr.own)
      : st.ownBaseStatic;
  const excessBaseFor = (
    st: AnnualMemberStatics,
    worker: SsContextMember | undefined,
    arfCreditMonths: number,
  ): number =>
    spousalExcessAnnual(st.member, worker, reductionFactor, st.effSpousalAgeMonths, {
      colaPct: ctx.colaPct,
      arfCreditMonths,
    });
  const restoredExcessMonths = (st: AnnualMemberStatics, cr: MemberEtCredits): number =>
    st.fraYear !== null && y >= st.fraYear ? cr.excess : 0;
  const preFraFor = (
    st: AnnualMemberStatics,
    cr: MemberEtCredits,
    worker: SsContextMember | undefined,
    ownBase: number,
    excessBase: number,
  ): PreFraSplice | null => {
    if (st.fraYear === null || y !== st.fraYear) return null;
    if (st.fraMonth0 === null || st.fraMonth0 === 0) return null;
    if (cr.own <= 0 && cr.excess <= 0) return null;
    const preOwn = st.ownBaseStatic;
    const preExcess = excessBaseFor(st, worker, 0);
    if (preOwn === ownBase && preExcess === excessBase) return null;
    return { ownBase: preOwn, excessBase: preExcess, month0: st.fraMonth0 };
  };
  const pOwnBase = ownBaseFor(p, credits.p);
  const sOwnBase = s ? ownBaseFor(s, credits.s) : 0;
  const pExcessBase = excessBaseFor(p, ctx.secondary, restoredExcessMonths(p, credits.p));
  const sExcessBase = s
    ? excessBaseFor(s, ctx.primary, restoredExcessMonths(s, credits.s))
    : 0;
  return {
    pOwnBase,
    sOwnBase,
    pExcessBase,
    sExcessBase,
    pPreFra: preFraFor(p, credits.p, ctx.secondary, pOwnBase, pExcessBase),
    sPreFra: s ? preFraFor(s, credits.s, ctx.primary, sOwnBase, sExcessBase) : null,
  };
}

/** Splice a mixed FRA year — months before the FRA month keep the
 *  pre-restoration checks, months at/after take the restored checks. */
function spliceMonthlyComponents(
  pre: AnnualMemberMonthlyComponents,
  post: AnnualMemberMonthlyComponents,
  fraMonth0: number,
): AnnualMemberMonthlyComponents {
  const totalByMonth = post.totalByMonth.map((v, m) =>
    m < fraMonth0 ? pre.totalByMonth[m] : v,
  );
  const excessByMonth = post.excessByMonth.map((v, m) =>
    m < fraMonth0 ? pre.excessByMonth[m] : v,
  );
  return {
    total: totalByMonth.reduce((a, v) => a + v, 0),
    excess: excessByMonth.reduce((a, v) => a + v, 0),
    totalByMonth,
    excessByMonth,
  };
}

/** Compute one calendar year's per-member benefits + earnings-test outcome
 *  under the given ARF credit state (one "pass" — the FRA year may run two). */
function computeYearPass(
  args: YearPassArgs,
  credits: { p: MemberEtCredits; s: MemberEtCredits },
): YearPassOut {
  const { y, p, s, colaFactor } = args;
  const hasSecondary = s !== null;
  const primaryAlive = !p.deathYear || y <= p.deathYear;
  const secondaryAlive = hasSecondary ? !s.deathYear || y <= s.deathYear : false;
  const primaryClaiming = p.claimYear !== null && y >= p.claimYear;
  const secondaryClaiming = s !== null && s.claimYear !== null && y >= s.claimYear;
  const bases = yearArfBases(args, credits);

  const benefitsWith = (
    pOwn: number,
    sOwn: number,
    pEx: number,
    sEx: number,
  ): ReturnType<typeof computeAnnualMemberBenefits> =>
    computeAnnualMemberBenefits({
      hasSecondary,
      primaryAlive,
      secondaryAlive,
      primaryClaiming,
      secondaryClaiming,
      year: y,
      primaryClaim: p.claimYear,
      secondaryClaim: s?.claimYear ?? null,
      primaryClaimMonthIdx: p.claimMonthIdx,
      secondaryClaimMonthIdx: s?.claimMonthIdx ?? null,
      primaryColaAnchorYear: p.anchor,
      secondaryColaAnchorYear: s?.anchor ?? null,
      primaryOwnBase: pOwn,
      secondaryOwnBase: sOwn,
      primarySpousalExcessBase: pEx,
      secondarySpousalExcessBase: sEx,
      colaFactor,
      // Prorate the claim-year row in the annual table only.
      prorateClaimYear: true,
      primaryClaimYearFraction: p.claimYearFraction,
      secondaryClaimYearFraction: s?.claimYearFraction ?? 1,
    });

  const post = benefitsWith(bases.pOwnBase, bases.sOwnBase, bases.pExcessBase, bases.sExcessBase);
  let pc = post.primary;
  let sc = post.secondary;
  // In a mixed FRA year the months BEFORE the FRA month pay at the
  // pre-restoration bases — recompute those months and splice.
  if (bases.pPreFra !== null || bases.sPreFra !== null) {
    const pre = benefitsWith(
      bases.pPreFra?.ownBase ?? bases.pOwnBase,
      bases.sPreFra?.ownBase ?? bases.sOwnBase,
      bases.pPreFra?.excessBase ?? bases.pExcessBase,
      bases.sPreFra?.excessBase ?? bases.sExcessBase,
    );
    if (bases.pPreFra !== null) {
      pc = spliceMonthlyComponents(pre.primary, pc, bases.pPreFra.month0);
    }
    if (bases.sPreFra !== null && sc !== undefined && pre.secondary !== undefined) {
      sc = spliceMonthlyComponents(pre.secondary, sc, bases.sPreFra.month0);
    }
  }

  const survivorOut = yearSurvivorFold(
    args,
    credits,
    { hasSecondary, primaryAlive, secondaryAlive },
    pc.totalByMonth,
    sc?.totalByMonth,
  );

  const scFinal = sc;
  return applyYearEarningsTests(args, {
    pGrossByMonth: survivorOut.primaryByMonth,
    sGrossByMonth: survivorOut.secondaryByMonth,
    pExcessByMonth: pc.excessByMonth,
    sExcessByMonth: scFinal?.excessByMonth ?? null,
    // The PRE-survivor-fold own-RIB checks gate the own-RIB ARF
    // months — a survivor-only month must not restore the own reduction.
    pOwnRibByMonth: pc.totalByMonth.map((v, m) => v - pc.excessByMonth[m]),
    sOwnRibByMonth:
      scFinal !== undefined
        ? scFinal.totalByMonth.map((v, m) => v - scFinal.excessByMonth[m])
        : undefined,
    bases,
    survivorWithheld: survivorOut.survivorWithheld,
  });
}

/** Year-level survivor fold: threads the survivor structs plus the
 *  deceased's ARF months into the month-wise
 *  `applyAnnualSurvivorBranches`. */
function yearSurvivorFold(
  args: YearPassArgs,
  credits: { p: MemberEtCredits; s: MemberEtCredits },
  flags: { hasSecondary: boolean; primaryAlive: boolean; secondaryAlive: boolean },
  primaryByMonth: ReadonlyArray<number>,
  secondaryByMonth: ReadonlyArray<number> | undefined,
): ReturnType<typeof applyAnnualSurvivorBranches> {
  return applyAnnualSurvivorBranches(
    {
      ...flags,
      year: args.y,
      colaPct: args.ctx.colaPct,
      primarySurvivor: args.survivor.primarySurvivor,
      secondarySurvivor: args.survivor.secondarySurvivor,
      primaryDeceased: args.survivor.primaryDeceased,
      secondaryDeceased: args.survivor.secondaryDeceased,
      // The deceased's own withheld months reconstruct the
      // ARF-adjusted reduced RIB inside the RIB-LIM comparison.
      primaryDeceasedWithheldMonths: credits.p.own,
      secondaryDeceasedWithheldMonths: credits.s.own,
    },
    primaryByMonth,
    secondaryByMonth,
  );
}

const CHARGE_EPS = 1e-9;

/** One member's post-earnings-test output, composed month-wise. Per
 *  §404.439, the member's charge schedule is computed over the RECORD
 *  pool, so its per-month factor apportions a partial month proportionally
 *  across every component — the own/survivor portion carries the member's
 *  own factor; the spousal excess carries the COMBINED per-month
 *  schedule — min(own, worker) (20 CFR 404.415(b) — a month
 *  withheld under either charge is withheld once) — which drives BOTH the
 *  excess payment and the credited spousal-ARF months, counted only over
 *  the months the excess is actually entitled to be paid. Own-RIB
 *  ARF months are counted only where an ENTITLED own-RIB check (pre-
 *  survivor-fold) was charged — survivor-only withheld months are tracked
 *  by no component (survivor-factor ARF is the disclosed unmodeled gap). */
function memberEtOut(x: {
  grossByMonth: ReadonlyArray<number>;
  excessByMonth: ReadonlyArray<number>;
  /** Pre-survivor-fold own-RIB dollars per month. */
  ownRibByMonth: ReadonlyArray<number>;
  ownBase: number;
  excessBase: number;
  preFra: PreFraSplice | null;
  et: MemberEarningsTestOutcome;
  workerEt: MemberEarningsTestOutcome | null;
}): YearPassMemberOut {
  const hasExcess = x.excessByMonth.some((e) => e > CHARGE_EPS);
  const combined = hasExcess
    ? minPaySchedules(x.et.payFactorByMonth, x.workerEt?.payFactorByMonth ?? null)
    : null;
  let gross = 0;
  let excess = 0;
  let final = 0;
  let ownWithheldMonths = 0;
  let excessWithheldMonths = 0;
  for (let m = 0; m < 12; m += 1) {
    const ex = x.excessByMonth[m];
    const own = x.grossByMonth[m] - ex;
    const ownF = x.et.payFactorByMonth?.[m] ?? 1;
    const exF = combined?.[m] ?? 1;
    gross += x.grossByMonth[m];
    excess += ex;
    final += own * ownF + ex * exF;
    // An own-RIB ARF month requires an ENTITLED own-RIB check
    // actually charged — a month where only the survivor benefit was
    // payable (own entitlement not yet begun) never restores the own RIB.
    if (x.ownRibByMonth[m] > CHARGE_EPS && ownF < 1 - CHARGE_EPS) {
      ownWithheldMonths += 1;
    }
    // An excess-ARF month requires an ENTITLED excess check actually
    // charged — a withheld month before the excess activates never counts.
    if (ex > CHARGE_EPS && exF < 1 - CHARGE_EPS) excessWithheldMonths += 1;
  }
  return {
    gross,
    excess,
    final,
    ownBase: x.ownBase,
    excessBase: x.excessBase,
    preFra: x.preFra,
    et: x.et,
    excessPayFactorByMonth: combined,
    ownWithheldMonths,
    excessWithheldMonths,
  };
}

/** Apply both members' earnings tests to the year's per-month checks
 *  (deductions charge each month's ACTUAL check) and compose the
 *  per-record charges (month schedules + the worker-side charge on
 *  the spousal excess).
 *
 *  Per 20 CFR 404.415/404.434/404.439, each member's excess earnings
 *  are charged against the COMBINED monthly total of every benefit those
 *  earnings can charge — the member's own(+survivor) checks, the spouse's
 *  excess payable on the member's record, and the member's own excess
 *  (dual entitlement; §404.415(b) charges a beneficiary's own auxiliary
 *  too) — sequentially month by month over one pool, never a
 *  personal-benefit ratio reapplied to a different person's benefit. A
 *  partial month's payable remainder is apportioned proportionally across
 *  the components (§404.439), which is exactly what applying the pool's
 *  per-month pay factor to each component does. Disclosed simplification
 *  (dual-worker overlap): when BOTH spouses have excess earnings, a month
 *  charged by both charges the spousal excess once (the
 *  min-schedule convention) rather than re-allocating the second
 *  charge's dollars to later months. */
function applyYearEarningsTests(
  args: YearPassArgs,
  x: {
    pGrossByMonth: ReadonlyArray<number>;
    sGrossByMonth: ReadonlyArray<number> | undefined;
    pExcessByMonth: ReadonlyArray<number>;
    sExcessByMonth: ReadonlyArray<number> | null;
    /** Pre-survivor-fold own-RIB dollars per month (for ARF gating). */
    pOwnRibByMonth: ReadonlyArray<number>;
    sOwnRibByMonth: ReadonlyArray<number> | undefined;
    bases: YearBases;
    survivorWithheld: boolean;
  },
): YearPassOut {
  const { y, p, s, etInflation } = args;
  const sum = (a: ReadonlyArray<number>): number => a.reduce((acc, v) => acc + v, 0);
  const zeros = new Array<number>(12).fill(0);
  // Record-level chargeable pools. The member's own gross already
  // contains their own excess, so pool = own gross + the OTHER member's
  // excess (the auxiliary payable on this member's record).
  const sExcessByMonth = x.sExcessByMonth ?? zeros;
  const pPoolByMonth = x.pGrossByMonth.map((v, m) => v + sExcessByMonth[m]);
  const sPoolByMonth =
    x.sGrossByMonth !== undefined
      ? x.sGrossByMonth.map((v, m) => v + x.pExcessByMonth[m])
      : undefined;
  const etP = applyEarningsTestToMember(
    p.member,
    y,
    sum(pPoolByMonth),
    etInflation,
    p.etTiming,
    pPoolByMonth,
  );
  const etS =
    s !== null && sPoolByMonth !== undefined
      ? applyEarningsTestToMember(
          s.member,
          y,
          sum(sPoolByMonth),
          etInflation,
          s.etTiming,
          sPoolByMonth,
        )
      : null;
  const pOut = memberEtOut({
    grossByMonth: x.pGrossByMonth,
    excessByMonth: x.pExcessByMonth,
    ownRibByMonth: x.pOwnRibByMonth,
    ownBase: x.bases.pOwnBase,
    excessBase: x.bases.pExcessBase,
    preFra: x.bases.pPreFra,
    et: etP,
    workerEt: etS,
  });
  const sOut: YearPassMemberOut | null =
    s !== null && etS !== null && x.sGrossByMonth !== undefined
      ? memberEtOut({
          grossByMonth: x.sGrossByMonth,
          excessByMonth: sExcessByMonth,
          ownRibByMonth: x.sOwnRibByMonth ?? zeros,
          ownBase: x.bases.sOwnBase,
          excessBase: x.bases.sExcessBase,
          preFra: x.bases.sPreFra,
          et: etS,
          workerEt: etP,
        })
      : null;
  return { p: pOut, s: sOut, survivorWithheld: x.survivorWithheld };
}

/** In the member's FRA year (20 CFR 404.412) the ARF adjustment
 *  already includes that SAME year's pre-FRA-month deductions — when the
 *  first pass withheld months in the FRA year, recompute the year with
 *  those months credited so the FRA-month benefit reflects the
 *  restoration. The rerun fires on EITHER kind of withholding —
 *  the member's own checks (own earnings test) OR their spousal excess
 *  (which the WORKER's earnings-test schedule can charge alone,
 *  20 CFR 404.415(b)) — and each credit boosts independently, so a
 *  recipient with zero own earnings still has their excess-based ARF
 *  restore at their own FRA month, not the following year. Per
 *  20 CFR 404.412(b), the recompute does NOT touch the pre-FRA months —
 *  `yearArfBases` keeps them at the pre-restoration bases regardless of
 *  credits, so the second pass changes only the FRA-month-onward checks
 *  and the earnings-test outcome (charged exclusively against the
 *  unchanged pre-FRA checks) is identical by construction. */
function maybeFraYearSecondPass(
  args: YearPassArgs,
  credits: { p: MemberEtCredits; s: MemberEtCredits },
  pass: YearPassOut,
): YearPassOut {
  const pHitsFra =
    args.y === args.p.fraYear &&
    (pass.p.ownWithheldMonths > 0 || pass.p.excessWithheldMonths > 0);
  const sHitsFra =
    args.s !== null &&
    args.y === args.s.fraYear &&
    ((pass.s?.ownWithheldMonths ?? 0) > 0 ||
      (pass.s?.excessWithheldMonths ?? 0) > 0);
  if (!pHitsFra && !sHitsFra) return pass;
  const boosted = {
    p: {
      own: credits.p.own + (pHitsFra ? pass.p.ownWithheldMonths : 0),
      excess: credits.p.excess + (pHitsFra ? pass.p.excessWithheldMonths : 0),
    },
    s: {
      own: credits.s.own + (sHitsFra ? pass.s?.ownWithheldMonths ?? 0 : 0),
      excess: credits.s.excess + (sHitsFra ? pass.s?.excessWithheldMonths ?? 0 : 0),
    },
  };
  return computeYearPass(args, boosted);
}

function toEtState(
  out: YearPassMemberOut,
  cumulativeWithheldMonths: number,
): MemberYearEtState {
  return {
    adjustedOwnBaseAnnual: out.ownBase,
    adjustedExcessBaseAnnual: out.excessBase,
    ownPayFactorByMonth: out.et.payFactorByMonth,
    excessPayFactorByMonth: out.excessPayFactorByMonth,
    etEstimated: out.et.estimated,
    cumulativeWithheldMonths,
    // Mixed FRA-year splice — the monthly engine pays the months
    // before `fraMonth0` at the pre-restoration bases.
    ...(out.preFra !== null
      ? {
          preFraOwnBaseAnnual: out.preFra.ownBase,
          preFraExcessBaseAnnual: out.preFra.excessBase,
          fraMonth0: out.preFra.month0,
        }
      : {}),
  };
}

/** Static per-run state for the annual loop (statics + survivor structs +
 *  zeroed ARF credits + the warm-up start year). */
function buildAnnualLoopInit(
  ctx: SsContext,
  yearRange: { from: number; to: number },
  reductionFactor: number,
): {
  p: AnnualMemberStatics;
  s: AnnualMemberStatics | null;
  survivor: SurvivorStructs;
  credits: { p: MemberEtCredits; s: MemberEtCredits };
  warmFrom: number;
} {
  const etInflation = ctx.earningsTestInflationRatePct ?? 0;
  const p = buildAnnualMemberStatics(ctx.primary, ctx.secondary, reductionFactor, etInflation);
  const s = ctx.secondary
    ? buildAnnualMemberStatics(ctx.secondary, ctx.primary, reductionFactor, etInflation)
    : null;
  // Survivor structs — carry the SEPARATE survivor claim age (null =
  // withheld) + the statement-anchored deceased COLA anchor.
  const survivor = buildSurvivorStructs(
    ctx.primary,
    ctx.secondary,
    p.deathYear,
    s?.deathYear ?? null,
    reductionFactor,
  );
  return {
    p,
    s,
    survivor,
    credits: { p: { own: 0, excess: 0 }, s: { own: 0, excess: 0 } },
    // Warm up from the EARLIEST entitlement year of either
    // member — own retirement claim OR the survivor benefit's actual start
    // (`etTiming.start` carries exactly that first start) — so a
    // range starting mid-history still reflects withholding on a survivor
    // benefit that began before the members' own claims.
    warmFrom: Math.min(
      yearRange.from,
      ...(p.etTiming ? [p.etTiming.start.year] : []),
      ...(s?.etTiming ? [s.etTiming.start.year] : []),
    ),
  };
}

/** Emit one in-range year's output row. */
function yearRowFrom(ctx: SsContext, y: number, pass: YearPassOut): SsYearOutput {
  const finalPrimary = pass.p.final;
  const finalSecondary = pass.s?.final;
  const earningsTestEstimated = pass.p.et.estimated || (pass.s?.et.estimated ?? false);
  return {
    year: y,
    total: finalPrimary + (finalSecondary ?? 0),
    byMember: {
      primary: finalPrimary,
      ...(ctx.secondary !== undefined ? { secondary: finalSecondary ?? 0 } : {}),
    },
    ...(earningsTestEstimated ? { earningsTestEstimated: true } : {}),
    ...(pass.survivorWithheld ? { survivorWithheld: true } : {}),
  };
}

/**
 * The annual engine's core: sequential over years so earnings-test withheld
 * months accumulate before FRA and the ARF-restored bases take over from
 * each member's FRA year onward. The loop warms up from the earliest
 * entitlement year, so a projection range starting mid-history still
 * reflects withholding that occurred before the range.
 */
function computeAnnualRows(
  ctx: SsContext,
  yearRange: { from: number; to: number },
): AnnualComputation {
  const rows: SsYearOutput[] = [];
  const primarySchedule = new Map<number, MemberYearEtState>();
  const secondarySchedule = new Map<number, MemberYearEtState>();
  const reductionFactor = 1 - ctx.benefitReductionPct / 100;
  const colaFactor = 1 + ctx.colaPct / 100;
  const etInflation = ctx.earningsTestInflationRatePct ?? 0;
  const { p, s, survivor, credits, warmFrom } = buildAnnualLoopInit(
    ctx,
    yearRange,
    reductionFactor,
  );

  for (let y = warmFrom; y <= yearRange.to; y += 1) {
    const passArgs: YearPassArgs = {
      ctx,
      y,
      p,
      s,
      survivor,
      reductionFactor,
      colaFactor,
      etInflation,
    };
    let pass = computeYearPass(passArgs, credits);
    pass = maybeFraYearSecondPass(passArgs, credits, pass);

    // Accumulate ARF months per component (the test only ever withholds
    // pre-FRA months). Own-RIB credits count only months an entitled
    // own-RIB check was charged — survivor-only withheld months restore
    // nothing (survivor-factor ARF is the disclosed unmodeled gap).
    credits.p.own += pass.p.ownWithheldMonths;
    credits.p.excess += pass.p.excessWithheldMonths;
    if (pass.s) {
      credits.s.own += pass.s.ownWithheldMonths;
      credits.s.excess += pass.s.excessWithheldMonths;
    }

    if (y < yearRange.from) continue; // warm-up year — state only, no row.
    primarySchedule.set(y, toEtState(pass.p, credits.p.own));
    if (pass.s) secondarySchedule.set(y, toEtState(pass.s, credits.s.own));
    rows.push(yearRowFrom(ctx, y, pass));
  }
  return { rows, primarySchedule, secondarySchedule };
}

export function projectSsByYear(
  ctx: SsContext,
  yearRange: { from: number; to: number },
): SsYearOutput[] {
  return computeAnnualRows(ctx, yearRange).rows;
}

/** Per-member statics for the monthly engine (payable-DRC timing, first
 *  eligible month, and claim indices). */
interface MonthlyMemberStatics {
  claimIdx: number | null;
  deathIdx: number | null;
  anchor: number | null;
  ownBaseNoDrcStatic: number;
  fraMonths: number;
  claimAgeMonthsTotal: number;
  age70Idx: number | null;
  survivorClaimIdx: number | null;
}

function buildMonthlyMemberStatics(
  member: SsContextMember,
  reductionFactor: number,
): MonthlyMemberStatics {
  const claim = claimMonthFor(member);
  const rawClaimIdx = claim ? monthIdx(claim.year, claim.month0) : null;
  const firstEligibleIdx = firstEligibleMonthIdxOf(member);
  // A claim can never begin before the first full month at age 62.
  const claimIdx =
    rawClaimIdx !== null && firstEligibleIdx !== null
      ? Math.max(rawClaimIdx, firstEligibleIdx)
      : rawClaimIdx;
  const death = deathMonthFor(member);
  return {
    claimIdx,
    deathIdx: death ? monthIdx(death.year, death.month0) : null,
    anchor: colaAnchorYearFor(member),
    ownBaseNoDrcStatic: ownBaseNoDrcAnnual(member, reductionFactor),
    fraMonths: fraMonthsFor(member),
    claimAgeMonthsTotal: claimAgeMonths(member.claimAge),
    age70Idx: age70MonthIdx(member),
    survivorClaimIdx: survivorClaimMonthIdxFor(member),
  };
}

/** One month's post-survivor totals reduced by the per-month earnings-test
 *  schedules: the own/survivor portion carries the member's own-earnings
 *  record-level schedule (the §404.439-apportioned pool factor),
 *  the spousal excess the min(own, worker) schedule. */
function applyMonthEtFactors(
  total: number,
  excess: number,
  state: MemberYearEtState | undefined,
  m: number,
): number {
  if (!state) return total;
  // `null` schedule = that charge did not run this year → full pay (a
  // year-level composite factor is NOT a substitute here: it would fold
  // the worker-side excess charge, which must not touch the own portion).
  const ownF = state.ownPayFactorByMonth ? state.ownPayFactorByMonth[m] : 1;
  const excessF = state.excessPayFactorByMonth ? state.excessPayFactorByMonth[m] : ownF;
  return (total - excess) * ownF + excess * excessF;
}

/** Static per-run state for the monthly loop. */
interface MonthlyLoopState {
  p: MonthlyMemberStatics;
  s: MonthlyMemberStatics | null;
  pExcessBaseStatic: number;
  sExcessBaseStatic: number;
  survivor: SurvivorStructs;
  colaFactor: number;
}

function buildMonthlyLoopState(ctx: SsContext, reductionFactor: number): MonthlyLoopState {
  const p = buildMonthlyMemberStatics(ctx.primary, reductionFactor);
  const s = ctx.secondary ? buildMonthlyMemberStatics(ctx.secondary, reductionFactor) : null;
  // Static excess bases (fallback — the schedule carries the ARF-restored
  // per-year values; the PIA normalization matches via the colaPct option).
  const pExcessBaseStatic = spousalExcessAnnual(
    ctx.primary,
    ctx.secondary,
    reductionFactor,
    effectiveSpousalAgeMonths(ctx.primary, ctx.secondary),
    { colaPct: ctx.colaPct },
  );
  const sExcessBaseStatic = ctx.secondary
    ? spousalExcessAnnual(
        ctx.secondary,
        ctx.primary,
        reductionFactor,
        effectiveSpousalAgeMonths(ctx.secondary, ctx.primary),
        { colaPct: ctx.colaPct },
      )
    : 0;
  // Death year (calendar) for survivor structs (the exclusive death-month
  // boundary is carried in the monthly statics).
  const survivor = buildSurvivorStructs(
    ctx.primary,
    ctx.secondary,
    deathYearFor(ctx.primary),
    ctx.secondary ? deathYearFor(ctx.secondary) : null,
    reductionFactor,
  );
  return {
    p,
    s,
    pExcessBaseStatic,
    sExcessBaseStatic,
    survivor,
    colaFactor: 1 + ctx.colaPct / 100,
  };
}

/** Per-member mixed FRA-year bases for the monthly engine — months
 *  before `month0` pay at these pre-restoration bases. */
interface MonthlyPreFra {
  ownBaseNoDrc: number;
  excessBase: number;
  month0: number;
}

/** Per-year context: schedule states + ARF-adjusted bases for the 12
 *  samples of calendar year `y`. */
interface MonthlyYearCtx {
  y: number;
  pState: MemberYearEtState | undefined;
  sState: MemberYearEtState | undefined;
  pOwnBaseNoDrc: number;
  sOwnBaseNoDrc: number;
  pExcessBase: number;
  sExcessBase: number;
  pPreFra: MonthlyPreFra | null;
  sPreFra: MonthlyPreFra | null;
}

function monthlyYearCtxFor(
  st: MonthlyLoopState,
  y: number,
  pState: MemberYearEtState | undefined,
  sState: MemberYearEtState | undefined,
): MonthlyYearCtx {
  // ARF applies only to reduced (pre-FRA) claims, where the no-DRC base
  // equals the full base — so the adjusted annual base substitutes 1:1.
  const pOwnBaseNoDrc =
    st.p.claimAgeMonthsTotal < st.p.fraMonths && pState
      ? pState.adjustedOwnBaseAnnual
      : st.p.ownBaseNoDrcStatic;
  const sOwnBaseNoDrc =
    st.s && st.s.claimAgeMonthsTotal < st.s.fraMonths && sState
      ? sState.adjustedOwnBaseAnnual
      : st.s?.ownBaseNoDrcStatic ?? 0;
  // The annual schedule marks the member's FRA year as MIXED when ARF
  // credits exist and FRA lands midyear — pre-FRA months pay at the
  // pre-restoration bases (only ever set for pre-FRA claims, where the
  // no-DRC base equals the full base, mirroring the adjusted-base rule).
  const preFraOf = (state: MemberYearEtState | undefined): MonthlyPreFra | null =>
    state !== undefined &&
    state.preFraOwnBaseAnnual !== undefined &&
    state.fraMonth0 !== undefined
      ? {
          ownBaseNoDrc: state.preFraOwnBaseAnnual,
          excessBase: state.preFraExcessBaseAnnual ?? state.adjustedExcessBaseAnnual,
          month0: state.fraMonth0,
        }
      : null;
  return {
    y,
    pState,
    sState,
    pOwnBaseNoDrc,
    sOwnBaseNoDrc,
    pExcessBase: pState?.adjustedExcessBaseAnnual ?? st.pExcessBaseStatic,
    sExcessBase: sState?.adjustedExcessBaseAnnual ?? st.sExcessBaseStatic,
    pPreFra: preFraOf(pState),
    sPreFra: preFraOf(sState),
  };
}

/** One month's own+excess components (pre-survivor, pre-earnings-test). */
function monthBenefitComponents(
  st: MonthlyLoopState,
  yc: MonthlyYearCtx,
  idx: number,
  flags: { primaryAlive: boolean; secondaryAlive: boolean },
): ReturnType<typeof computeMonthlyMemberBenefits> {
  const { p, s } = st;
  // Payable DRC factor for this month (deferred to January N+1).
  const drcFor = (m: MonthlyMemberStatics): number =>
    m.claimIdx !== null && m.age70Idx !== null
      ? payableDrcFactorForMonth(idx, m.claimIdx, m.fraMonths, m.claimAgeMonthsTotal, m.age70Idx)
      : 1;
  // In a mixed FRA year the months before the FRA month pay at the
  // pre-restoration bases (20 CFR 404.412(b) — ARF effective with the FRA
  // month), matching the annual engine's spliced checks.
  const m0 = idx % 12;
  const preP = yc.pPreFra !== null && m0 < yc.pPreFra.month0 ? yc.pPreFra : null;
  const preS = yc.sPreFra !== null && m0 < yc.sPreFra.month0 ? yc.sPreFra : null;
  return computeMonthlyMemberBenefits({
    hasSecondary: s !== null,
    primaryAlive: flags.primaryAlive,
    secondaryAlive: flags.secondaryAlive,
    primaryClaiming: p.claimIdx !== null && idx >= p.claimIdx,
    secondaryClaiming: s !== null && s.claimIdx !== null && idx >= s.claimIdx,
    idx,
    primaryClaimIdx: p.claimIdx,
    secondaryClaimIdx: s?.claimIdx ?? null,
    // COLA exponent measured from the anchor year.
    primaryColaPow: p.anchor !== null ? yc.y - p.anchor : 0,
    secondaryColaPow: s && s.anchor !== null ? yc.y - s.anchor : 0,
    primaryOwnBaseNoDrc: preP?.ownBaseNoDrc ?? yc.pOwnBaseNoDrc,
    secondaryOwnBaseNoDrc: preS?.ownBaseNoDrc ?? yc.sOwnBaseNoDrc,
    primaryPayableDrc: drcFor(p),
    secondaryPayableDrc: s ? drcFor(s) : 1,
    primarySpousalExcessBase: preP?.excessBase ?? yc.pExcessBase,
    secondarySpousalExcessBase: preS?.excessBase ?? yc.sExcessBase,
    colaFactor: st.colaFactor,
  });
}

/** One month's full sample: components → survivor fold → month-indexed
 *  earnings-test factors → output row. */
function computeMonthSample(
  ctx: SsContext,
  st: MonthlyLoopState,
  yc: MonthlyYearCtx,
  m: number,
): SsMonthOutput {
  const { p, s } = st;
  const idx = monthIdx(yc.y, m);
  // Alive iff idx < deathMonth (deathMonth is exclusive).
  const primaryAlive = p.deathIdx === null || idx < p.deathIdx;
  const secondaryAlive = s ? s.deathIdx === null || idx < s.deathIdx : false;
  const { primary: pc, secondary: sc } = monthBenefitComponents(st, yc, idx, {
    primaryAlive,
    secondaryAlive,
  });

  const survivorOut = applyMonthlySurvivorBranches(
    {
      hasSecondary: s !== null,
      primaryAlive,
      secondaryAlive,
      year: yc.y,
      colaPct: ctx.colaPct,
      idx,
      primarySurvivorClaimIdx: p.survivorClaimIdx,
      secondarySurvivorClaimIdx: s?.survivorClaimIdx ?? null,
      primarySurvivor: st.survivor.primarySurvivor,
      secondarySurvivor: st.survivor.secondarySurvivor,
      primaryDeceased: st.survivor.primaryDeceased,
      secondaryDeceased: st.survivor.secondaryDeceased,
      // Deceased ARF months from the shared schedule (frozen at
      // the deceased's death — no benefit → no further withholding).
      primaryDeceasedWithheldMonths: yc.pState?.cumulativeWithheldMonths ?? 0,
      secondaryDeceasedWithheldMonths: yc.sState?.cumulativeWithheldMonths ?? 0,
    },
    pc.total,
    sc?.total,
  );

  const finalPrimary = applyMonthEtFactors(survivorOut.primaryAnnual, pc.excess, yc.pState, m);
  const finalSecondary =
    survivorOut.secondaryAnnual !== undefined
      ? applyMonthEtFactors(survivorOut.secondaryAnnual, sc?.excess ?? 0, yc.sState, m)
      : undefined;

  return {
    fractionalYear: yc.y + m / 12,
    year: yc.y,
    month0: m,
    total: finalPrimary + (finalSecondary ?? 0),
    byMember: {
      primary: finalPrimary,
      ...(ctx.secondary !== undefined ? { secondary: finalSecondary ?? 0 } : {}),
    },
    ...(survivorOut.survivorWithheld ? { survivorWithheld: true } : {}),
  };
}

/**
 * Month-resolution variant of `projectSsByYear`. Emits 12 samples per
 * calendar year — annualized run-rates ($/yr) at each month. Rate is
 * 0 in pre-claim months, steps up to the at-claim annual on the claim
 * month, and compounds by `(1 + cola)` at January each subsequent
 * year (COLA anchored to the statement year). Spousal excess while
 * both alive, survivor switch gated on the SEPARATE survivor claim
 * month, exclusive death-month boundary.
 *
 * Earnings-test + ARF state is taken from the annual engine's schedule
 * (`computeAnnualRows`), so both engines agree on the ARF-restored own +
 * spousal-excess bases; each month consumes the explicit
 * month-indexed withholding schedule (which checks were actually charged)
 * instead of spreading one annual factor over all twelve months — a
 * grace-year non-service month or a post-FRA month is never reduced.
 *
 * Claim-year and survivor-start boundaries agree with the annual
 * engine's prorated rows; the remaining intentional
 * annual-rollup divergence from `projectSsByYear` is the DRC
 * January deferral for FRA–70 claims — see the doc on `SsMonthOutput`.
 */
export function projectSsByMonth(
  ctx: SsContext,
  yearRange: { from: number; to: number },
): SsMonthOutput[] {
  const out: SsMonthOutput[] = [];
  const reductionFactor = 1 - ctx.benefitReductionPct / 100;
  // Shared earnings-test / ARF schedule (see doc above).
  const { primarySchedule, secondarySchedule } = computeAnnualRows(ctx, yearRange);
  const st = buildMonthlyLoopState(ctx, reductionFactor);

  for (let y = yearRange.from; y <= yearRange.to; y += 1) {
    const yc = monthlyYearCtxFor(st, y, primarySchedule.get(y), secondarySchedule.get(y));
    for (let m = 0; m < 12; m += 1) {
      out.push(computeMonthSample(ctx, st, yc, m));
    }
  }
  return out;
}
