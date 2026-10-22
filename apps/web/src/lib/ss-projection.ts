/**
 * Per-year and per-month household Social Security benefit projection for the drawdown engine's income side, in nominal
 * dollars at the calendar year. Rules in plain words: docs/math-social-security-and-health.md.
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

export type {  SsContext, SsYearOutput, SsMonthOutput } from './ss-projection-types';
export { buildSsContext, resolveSsColaPct } from './ss-context-builder';

import type {
  SsContext,
  SsYearOutput,
  SsMonthOutput,
  MemberYearEtState,
} from './ss-projection-types';
import type { SsContextMember } from './ss-projection-types';

// Fraction of the claim year collected, `(12 − claimMonth0) / 12` from the benefit-purpose birth month: an annual-table approximation of the monthly engine's exact sum; 1 when the birthdate is missing.
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

interface AnnualComputation {
  rows: SsYearOutput[];
  primarySchedule: Map<number, MemberYearEtState>;
  secondarySchedule: Map<number, MemberYearEtState>;
}

interface AnnualMemberStatics {
  member: SsContextMember;
  claimYear: number | null;
  claimMonthIdx: number | null;
  claimYearFraction: number;
  deathYear: number | null;
  anchor: number | null;
  fraYear: number | null;
  fraMonth0: number | null;
  ownBaseStatic: number;
  effSpousalAgeMonths: number;
  etTiming: MemberEtTiming | null;
}

function buildAnnualMemberStatics(
  member: SsContextMember,
  other: SsContextMember | undefined,
  reductionFactor: number,
  etInflation: number,
): AnnualMemberStatics {
  // 20 CFR 404.435(b)(2) / POMS RS 02501.030: one grace year per continuous entitlement, and the model never ends an
  // entitlement, so only the member's first-ever start (own claim or survivor start) seeds the search; a later start
  // re-grants nothing. The grace year is the first entitled year that contains a non-service month.
  const claimM = claimMonthFor(member);
  const otherDeath = other ? deathYearFor(other) : null;
  const svIdx = survivorClaimMonthIdxFor(member);
  const startIdxs: number[] = [];
  if (claimM) startIdxs.push(monthIdx(claimM.year, claimM.month0));
  if (svIdx !== null && otherDeath !== null) {
    // The survivor benefit's actual start: the claim month pushed to the death boundary (January of deathYear + 1).
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

interface PreFraSplice {
  ownBase: number;
  excessBase: number;
  month0: number;
}

interface YearPassMemberOut {
  gross: number;
  excess: number;
  final: number;
  ownBase: number;
  excessBase: number;
  preFra: PreFraSplice | null;
  et: MemberEarningsTestOutcome;
  excessPayFactorByMonth: ReadonlyArray<number> | null;
  ownWithheldMonths: number;
  excessWithheldMonths: number;
}

interface YearPassOut {
  p: YearPassMemberOut;
  s: YearPassMemberOut | null;
  survivorWithheld: boolean;
}

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

// ARF-adjusted per-year bases (POMS RS 00615.482): own RIB and spousal excess restore independently from each member's FRA
// year. Per 20 CFR 404.412(b) the increase takes effect with the FRA month, so in that year the restored bases apply only
// from `fraMonth0`; `pPreFra`/`sPreFra` carry the pre-restoration bases for earlier months.
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
      prorateClaimYear: true,
      primaryClaimYearFraction: p.claimYearFraction,
      secondaryClaimYearFraction: s?.claimYearFraction ?? 1,
    });

  const post = benefitsWith(bases.pOwnBase, bases.sOwnBase, bases.pExcessBase, bases.sExcessBase);
  let pc = post.primary;
  let sc = post.secondary;
  // In a mixed FRA year the months before the FRA month pay the pre-restoration bases: recompute and splice.
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
    // Pre-survivor-fold own-RIB checks gate the own-RIB ARF months, so a survivor-only month never restores the own reduction.
    pOwnRibByMonth: pc.totalByMonth.map((v, m) => v - pc.excessByMonth[m]),
    sOwnRibByMonth:
      scFinal !== undefined
        ? scFinal.totalByMonth.map((v, m) => v - scFinal.excessByMonth[m])
        : undefined,
    bases,
    survivorWithheld: survivorOut.survivorWithheld,
  });
}

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
      // The deceased's withheld months reconstruct the ARF-adjusted reduced RIB for RIB-LIM.
      primaryDeceasedWithheldMonths: credits.p.own,
      secondaryDeceasedWithheldMonths: credits.s.own,
    },
    primaryByMonth,
    secondaryByMonth,
  );
}

const CHARGE_EPS = 1e-9;

// One member's post-earnings-test output, month-wise. The charge schedule is computed over the record pool (§404.439
// apportions a partial month proportionally), so the own/survivor portion carries the member's own factor and the spousal
// excess the min(own, worker) schedule (20 CFR 404.415(b): a month withheld under either charge is withheld once), which
// drives the excess payment and the spousal-ARF months. Disclosed simplification: ARF restoration of the survivor reduction
// factor is not recomputed at survivor FRA, so survivor-only withheld months count toward no component.
function memberEtOut(x: {
  grossByMonth: ReadonlyArray<number>;
  excessByMonth: ReadonlyArray<number>;
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
    // An own-RIB ARF month needs an entitled own-RIB check actually charged; a survivor-only month never restores it.
    if (x.ownRibByMonth[m] > CHARGE_EPS && ownF < 1 - CHARGE_EPS) {
      ownWithheldMonths += 1;
    }
    // An excess-ARF month needs an entitled excess check actually charged.
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

// Applies both members' earnings tests to the year's per-month checks (deductions charge each month's actual check). Per 20
// CFR 404.415/404.434/404.439 each member's excess earnings are charged against the combined monthly pool of every benefit
// they can charge (own+survivor checks, the spouse's excess on their record, their own excess), a partial month apportioned
// proportionally. Disclosed simplification: when both spouses have excess earnings, a month charged by both charges the
// spousal excess once (the min-schedule convention).
function applyYearEarningsTests(
  args: YearPassArgs,
  x: {
    pGrossByMonth: ReadonlyArray<number>;
    sGrossByMonth: ReadonlyArray<number> | undefined;
    pExcessByMonth: ReadonlyArray<number>;
    sExcessByMonth: ReadonlyArray<number> | null;
    pOwnRibByMonth: ReadonlyArray<number>;
    sOwnRibByMonth: ReadonlyArray<number> | undefined;
    bases: YearBases;
    survivorWithheld: boolean;
  },
): YearPassOut {
  const { y, p, s, etInflation } = args;
  const sum = (a: ReadonlyArray<number>): number => a.reduce((acc, v) => acc + v, 0);
  const zeros = new Array<number>(12).fill(0);
  // Record-level pool: the member's gross already holds their own excess, so add the other member's excess (the auxiliary payable on this record).
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

// In the FRA year the ARF adjustment includes that year's own pre-FRA-month deductions (20 CFR 404.412), so a first pass that
// withheld months reruns with them credited. It fires on either the member's own checks or their spousal excess (the
// worker's schedule can charge it alone, 20 CFR 404.415(b)), each credit boosting independently. Pre-FRA months stay at the
// pre-restoration bases (404.412(b)), so only the FRA-month-onward checks change.
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
    ...(out.preFra !== null
      ? {
          preFraOwnBaseAnnual: out.preFra.ownBase,
          preFraExcessBaseAnnual: out.preFra.excessBase,
          fraMonth0: out.preFra.month0,
        }
      : {}),
  };
}

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
    // Warm up from the earliest entitlement year of either member (own claim or survivor start), so a range starting mid-history still reflects earlier withholding.
    warmFrom: Math.min(
      yearRange.from,
      ...(p.etTiming ? [p.etTiming.start.year] : []),
      ...(s?.etTiming ? [s.etTiming.start.year] : []),
    ),
  };
}

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

/** Sequential over years so withheld months accumulate before FRA and the ARF-restored bases take over from each FRA year; warms up from the earliest entitlement year. */
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

    // Accumulate ARF months per component; own-RIB credits count only months an entitled own-RIB check was charged.
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

/**
 * Per-year household SS benefits in nominal dollars: the PIA is in today's dollars and compounds at the COLA rate from
 * the member's anchor (apply the display deflator downstream). `pia === null` means no own benefit, but the spousal excess
 * and survivor benefit remain possible. WEP/GPO are repealed (Social Security Fairness Act, effective Jan 2025) and SSI and
 * divorced-spouse benefits are not modeled.
 */
export function projectSsByYear(
  ctx: SsContext,
  yearRange: { from: number; to: number },
): SsYearOutput[] {
  return computeAnnualRows(ctx, yearRange).rows;
}

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

// The own/survivor portion carries the member's own record-level schedule; the spousal excess the min(own, worker) schedule.
function applyMonthEtFactors(
  total: number,
  excess: number,
  state: MemberYearEtState | undefined,
  m: number,
): number {
  if (!state) return total;
  // A `null` schedule means that charge did not run: full pay (a year-level composite would fold the worker-side excess charge into the own portion).
  const ownF = state.ownPayFactorByMonth ? state.ownPayFactorByMonth[m] : 1;
  const excessF = state.excessPayFactorByMonth ? state.excessPayFactorByMonth[m] : ownF;
  return (total - excess) * ownF + excess * excessF;
}

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

interface MonthlyPreFra {
  ownBaseNoDrc: number;
  excessBase: number;
  month0: number;
}

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
  // ARF applies only to reduced (pre-FRA) claims, where the no-DRC base equals the full base.
  const pOwnBaseNoDrc =
    st.p.claimAgeMonthsTotal < st.p.fraMonths && pState
      ? pState.adjustedOwnBaseAnnual
      : st.p.ownBaseNoDrcStatic;
  const sOwnBaseNoDrc =
    st.s && st.s.claimAgeMonthsTotal < st.s.fraMonths && sState
      ? sState.adjustedOwnBaseAnnual
      : st.s?.ownBaseNoDrcStatic ?? 0;
  // A mixed FRA year (ARF credits with FRA midyear) pays pre-FRA months at the pre-restoration bases.
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
  // In a mixed FRA year earlier months pay the pre-restoration bases (20 CFR 404.412(b)), matching the annual splice.
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

function computeMonthSample(
  ctx: SsContext,
  st: MonthlyLoopState,
  yc: MonthlyYearCtx,
  m: number,
): SsMonthOutput {
  const { p, s } = st;
  const idx = monthIdx(yc.y, m);
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
      // Deceased ARF months from the shared schedule, frozen at death.
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
 * Month-resolution variant of `projectSsByYear`: 12 annualized-run-rate ($/yr) samples per calendar year, 0 before the
 * claim month, COLA at January, survivor switch gated on the separate survivor claim month, exclusive death-month
 * boundary. Earnings-test and ARF state come from the annual engine's schedule (`computeAnnualRows`), so a grace-year
 * non-service month or post-FRA month is never reduced. Claim-year and survivor-start boundaries agree with the annual
 * rows; the remaining divergence is the DRC January deferral for FRA–70 claims (see `SsMonthOutput`).
 */
export function projectSsByMonth(
  ctx: SsContext,
  yearRange: { from: number; to: number },
): SsMonthOutput[] {
  const out: SsMonthOutput[] = [];
  const reductionFactor = 1 - ctx.benefitReductionPct / 100;
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
