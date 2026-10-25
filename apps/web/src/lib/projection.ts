/**
 * Per-account balance projection to the retirement date, driven by the shared monthly kernel (`projection-engine/kernel.ts`); output is year-indexed and nominal (event-month dollars).
 * Pre-tax and post-tax buckets are tracked separately; the Balance Projection page deflates at the display boundary, and consumers needing per-month deflators read `realDeflatorAt` from `projection-context.ts`.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';
import { runStepKernel, type StepInputs } from './projection-engine/kernel';
import { monthlyEquivalent } from './projection-engine/monthly-conversion';
import { assertNever } from './assert-never';
import { contributionGrowthFactor } from './contribution-growth';

export interface ProjectionInput {
  account: Aggregate<AccountPayload>;
  balances: Aggregate<AccountBalancePayload>[];
  /**
   * Annual planning return, percent; each monthly step compounds by `monthlyEquivalent(ratePct)`.
   */
  ratePct: number;
  /**
   * ISO `YYYY-MM-DD`; the household drawdown begins at the primary member's retirement date, so
   * callers pass it for every account (joint and individual). Use `accumulationEndDate` for
   * owner-specific contribution stops.
   */
  retirementDate: string;
  stopContributionsToday: boolean;
  todayYear: number;
  /**
   * Today's month index (0 = Jan); with `todayYear` anchors contribution growth so the configured
   * contribution shows flat in the Today's-dollars view. Defaults to 0.
   */
  todayMonthIndex?: number;
  /**
   * Resolved annual-increase rate (percent) for the planned contribution, grown month-precise from
   * the today anchor via `contributionGrowthFactor`. Omitted or `0` is flat-nominal. Only the
   * recurring planned + company contribution is grown, not one-off `preRetirementDeposits`.
   */
  contributionGrowthPct?: number;
  /**
   * Contribution stop date (ISO); when earlier than `retirementDate` the kernel zeroes
   * contributions from that month but keeps compounding to the retirement boundary. Callers pass
   * the account owner's retirement date, falling back to the primary's, so a secondary's individual
   * 401(k) stops at the secondary's date; a later date is clamped to `retirementDate`.
   */
  accumulationEndDate?: string;
  /**
   * Event-month-anchored deposits added to the buckets during accumulation: targeted one-offs and
   * pension lump-sums that precede primary retirement route here instead of the drawdown engine.
   * Events outside the kernel's step window silently drop.
   */
  preRetirementDeposits?: ReadonlyArray<{
    year: number;
    month0: number;
    preTax: number;
    postTax: number;
  }>;
  /**
   * Event-month-anchored pre-tax withdrawals from the pre-tax bucket during accumulation (the
   * source leg of a working-years Roth conversion). Each is clamped to the pre-tax balance at the
   * event month, including that month's contribution and deposits, so the bucket never goes
   * negative; same-month entries apply in array order. The subtraction happens before the month's
   * growth, so the removed dollars forgo their remaining compounding. Events outside the step
   * window drop, as with deposits.
   */
  preRetirementWithdrawals?: ReadonlyArray<{
    year: number;
    month0: number;
    preTax: number;
  }>;
}

interface ProjectionYear {
  year: number;
  // Year-end pre-tax value (nominal). The retirement year assumes contributions stop on the
  // retirement date and the balance compounds growth-only through Dec 31; the partial-year balance
  // lives on `ProjectionOutput`.
  preTax: number;
  postTax: number;
  growth: number;
  contributions: number;
  // Set on the retirement-year row only: the partial-year balance at the retirement date and its
  // fractional X position, for the chart's reference line.
  retirementSnapshot?: {
    preTax: number;
    postTax: number;
    /** `retirementYear + (retirementMonth + (day-1)/daysInMonth) / 12`. */
    fractionalYear: number;
  };
}

// Per-step kernel series (nominal), length `(lastProjectionYear − firstProjectionYear + 1) × 12`,
// step 0 = January of `firstProjectionYear`, for consumers needing intra-year resolution.
interface ProjectionPerStep {
  readonly firstYear: number;
  readonly preEnd: Float64Array;
  readonly postEnd: Float64Array;
  readonly growth: Float64Array;
  readonly contributions: Float64Array;
  readonly withdrawal: Float64Array;
  readonly deposit: Float64Array;
  readonly expense: Float64Array;
  readonly income: Float64Array;
}

export interface ProjectionOutput {
  preTax: number;
  postTax: number;
  total: number;
  yearlyTotals: ProjectionYear[];
  /**
   * Per-step kernel output; absent on the defensive branch where the latest balance year is after
   * the retirement year.
   */
  perStep?: ProjectionPerStep;
}

interface Buckets {
  pre: number;
  post: number;
}

interface ContribAdds {
  pre: number;
  post: number;
}

function daysInMonth(year: number, monthIndexZeroBased: number): number {
  return new Date(Date.UTC(year, monthIndexZeroBased + 1, 0)).getUTCDate();
}

function parseRetirementDate(iso: string): {
  year: number;
  monthIdx: number;
  m: number;
} {
  const [y, mo, d] = iso.split('-').map(Number);
  const monthIndex = mo - 1;
  const dim = daysInMonth(y, monthIndex);
  // (day - 1) so Jan 1 → m = 0 (full final year still ahead), Dec 31 → ≈ 1.
  const m = (monthIndex + (d - 1) / dim) / 12;
  return { year: y, monthIdx: monthIndex, m };
}

function latestBalance(
  balances: Aggregate<AccountBalancePayload>[],
): Aggregate<AccountBalancePayload> | null {
  if (balances.length === 0) return null;
  return balances.reduce((best, r) =>
    r.payload.year > best.payload.year ? r : best,
  );
}

function seedBuckets(
  account: AccountPayload,
  latest: AccountBalancePayload,
): Buckets {
  const tt = account.taxTreatment;
  if (tt === 'MIXED') {
    return {
      pre: latest.endingBalancePreTax ?? 0,
      post: latest.endingBalancePostTax ?? 0,
    };
  }
  if (tt === 'PRE_TAX') {
    return { pre: latest.endingBalance, post: 0 };
  }
  // POST_TAX, HSA and ROTH all seed the whole balance into the post (tax-free) bucket; HSA
  // withdrawal tax keys off `taxTreatment`, not the bucket split.
  if (tt === 'POST_TAX' || tt === 'HSA' || tt === 'ROTH') {
    return { pre: 0, post: latest.endingBalance };
  }
  return assertNever(tt);
}

function contribAdds(
  account: AccountPayload,
  latest: AccountBalancePayload,
): ContribAdds {
  const tt = account.taxTreatment;
  if (tt === 'MIXED') {
    return {
      pre:
        account.plannedContributionPreTax +
        (latest.companyContributionsPreTax ?? 0),
      post:
        account.plannedContributionPostTax +
        (latest.companyContributionsPostTax ?? 0),
    };
  }
  if (tt === 'PRE_TAX') {
    return {
      pre: account.plannedContributionPreTax + latest.companyContributions,
      post: 0,
    };
  }
  if (tt === 'HSA') {
    // HSA contributions are entered pre-tax (payroll deduction) but the account is tax-free at
    // withdrawal, so they grow in the post bucket; the split does not affect HSA withdrawal tax.
    return {
      pre: 0,
      post: account.plannedContributionPreTax + latest.companyContributions,
    };
  }
  if (tt === 'POST_TAX' || tt === 'ROTH') {
    return {
      pre: 0,
      post: account.plannedContributionPostTax + latest.companyContributions,
    };
  }
  return assertNever(tt);
}

// Fold each source-leg pre-tax withdrawal into `contribPre` as a negative delta at its event step,
// clamped against a forward simulation of the pre-tax bucket that mirrors the kernel (that step's
// contribution is added before growth). Same-step entries cascade in array order; events outside
// `[0, accumulationEndStepIdx)` drop.
function applyPreRetirementWithdrawals(args: {
  withdrawals: ReadonlyArray<{ year: number; month0: number; preTax: number }>;
  contribPre: Float64Array;
  firstProjectionYear: number;
  accumulationEndStepIdx: number;
  monthlyRetPct: number;
  initialPre: number;
}): void {
  const {
    withdrawals,
    contribPre,
    firstProjectionYear,
    accumulationEndStepIdx,
    monthlyRetPct,
    initialPre,
  } = args;
  if (withdrawals.length === 0) return;
  const byStep = new Map<number, number[]>();
  for (const w of withdrawals) {
    const stepIdx = (w.year - firstProjectionYear) * 12 + w.month0;
    if (stepIdx < 0 || stepIdx >= accumulationEndStepIdx) continue;
    if (!(w.preTax > 0)) continue; // skip non-positive / non-finite amounts
    const list = byStep.get(stepIdx);
    if (list) list.push(w.preTax);
    else byStep.set(stepIdx, [w.preTax]);
  }
  if (byStep.size === 0) return;
  const factor = 1 + monthlyRetPct / 100;
  let pre = initialPre;
  for (let i = 0; i < accumulationEndStepIdx; i += 1) {
    pre += contribPre[i];
    const amounts = byStep.get(i);
    if (amounts) {
      for (const amount of amounts) {
        const taken = Math.min(amount, Math.max(0, pre));
        pre -= taken;
        contribPre[i] -= taken; // negative delta folded at the same step
      }
    }
    pre *= factor;
  }
}

export function project(input: ProjectionInput): ProjectionOutput | null {
  const latest = latestBalance(input.balances);
  if (!latest) return null;

  const buckets = seedBuckets(input.account.payload, latest.payload);
  const adds = contribAdds(input.account.payload, latest.payload);
  const yearlyTotals: ProjectionYear[] = [];

  const ret = parseRetirementDate(input.retirementDate);
  const lastProjectionYear = ret.year;
  // firstProjectionYear is normally max(latest + 1, todayYear); when retirement falls in the latest
  // balance's year it collapses to the retirement year so that year's row still emits.
  const firstProjectionYear = Math.min(
    Math.max(latest.payload.year + 1, input.todayYear),
    lastProjectionYear,
  );

  // Retirement is before the latest balance: return the current balance untouched.
  if (latest.payload.year > lastProjectionYear) {
    yearlyTotals.push({
      year: latest.payload.year,
      preTax: buckets.pre,
      postTax: buckets.post,
      growth: 0,
      contributions: 0,
    });
    return {
      preTax: buckets.pre,
      postTax: buckets.post,
      total: buckets.pre + buckets.post,
      yearlyTotals,
    };
  }

  // StepInputs span [firstProjectionYear, lastProjectionYear]; accumulation runs to the retirement
  // step (the drawdown engine owns what follows), where the kernel folds the buckets into one pool
  // read for the partial-year snapshot.
  const horizonYears = lastProjectionYear - firstProjectionYear + 1;
  const stepCount = horizonYears * 12;
  const retirementStepIdx = (lastProjectionYear - firstProjectionYear) * 12 + ret.monthIdx;

  // An earlier accumulation-end date (an individual account whose owner retires before the primary)
  // zeroes contributions from that step while the kernel still runs to the retirement step.
  let accumulationEndStepIdx = retirementStepIdx;
  if (input.accumulationEndDate) {
    const acc = parseRetirementDate(input.accumulationEndDate);
    const candidate = (acc.year - firstProjectionYear) * 12 + acc.monthIdx;
    // Clamp to the kernel's [0..retirementStepIdx]; a past-window date collapses to no
    // contributions.
    accumulationEndStepIdx = Math.max(0, Math.min(retirementStepIdx, candidate));
  }

  const monthlyRetPct = monthlyEquivalent(input.ratePct);
  const mainReturnPct = new Float64Array(stepCount).fill(monthlyRetPct);
  const contribPre = new Float64Array(stepCount);
  const contribPost = new Float64Array(stepCount);
  if (!input.stopContributionsToday) {
    const perMonthPre = adds.pre / 12;
    const perMonthPost = adds.post / 12;
    // Grow each contribution month-precise from the today anchor (not `firstProjectionYear`), so
    // the configured figure is today's-dollars and shows flat in the Today's-dollars view; the
    // factor is 1 with no rate or an out-of-band one.
    const growthPct = input.contributionGrowthPct ?? 0;
    const asOfMonth =
      input.todayYear * 12 + (input.todayMonthIndex ?? 0);
    for (let i = 0; i < accumulationEndStepIdx; i += 1) {
      const eventMonth = firstProjectionYear * 12 + i;
      const factor = contributionGrowthFactor(growthPct, eventMonth, asOfMonth);
      contribPre[i] = perMonthPre * factor;
      contribPost[i] = perMonthPost * factor;
    }
  }

  // Deposits fold into the bucket before the month's growth, so each earns its remaining months of
  // compounding.
  const deposits = input.preRetirementDeposits ?? [];
  for (const d of deposits) {
    const stepIdx = (d.year - firstProjectionYear) * 12 + d.month0;
    if (stepIdx < 0 || stepIdx >= accumulationEndStepIdx) continue;
    contribPre[stepIdx] += d.preTax;
    contribPost[stepIdx] += d.postTax;
  }

  // Clamp each source-leg withdrawal to the pre-tax balance at its event month and fold it into
  // `contribPre` as a negative delta before that month's growth (the mirror of the deposit fold).
  applyPreRetirementWithdrawals({
    withdrawals: input.preRetirementWithdrawals ?? [],
    contribPre,
    firstProjectionYear,
    accumulationEndStepIdx,
    monthlyRetPct,
    initialPre: buckets.pre,
  });

  const stepInput: StepInputs = {
    mainReturnPct,
    cpiPct: new Float64Array(stepCount), // deterministic engine doesn't sample CPI
    contribPre,
    contribPost,
    expense: new Float64Array(stepCount),
    income: new Float64Array(stepCount),
    deposit: new Float64Array(stepCount),
    retirementStepIdx,
    initialPre: buckets.pre,
    initialPost: buckets.post,
  };
  const out = runStepKernel(stepInput);

  // Nominal emit; the kernel's growth and contribution sums are nominal by construction.
  for (let yIdx = 0; yIdx < horizonYears; yIdx += 1) {
    const calendarYear = firstProjectionYear + yIdx;
    const isFinalYear = calendarYear === lastProjectionYear;
    const yearEndStep = isFinalYear
      ? Math.min(stepCount - 1, retirementStepIdx + (12 - ret.monthIdx) - 1)
      : (yIdx + 1) * 12 - 1;

    let growthSum = 0;
    let contribSum = 0;
    const yearStartStep = yIdx * 12;
    // The retirement year accrues through Dec 31 (the chart line walks through it); months past
    // retirement carry zero contributions and growth.
    const endStepForSums = (yIdx + 1) * 12 - 1;
    for (let s = yearStartStep; s <= endStepForSums && s < stepCount; s += 1) {
      growthSum += out.growth[s];
      contribSum += out.contributions[s];
    }

    const row: ProjectionYear = {
      year: calendarYear,
      preTax: out.preEnd[yearEndStep],
      postTax: out.postEnd[yearEndStep],
      growth: growthSum,
      contributions: contribSum,
    };

    if (isFinalYear) {
      // Retirement-date balance is the pool at the end of the month before `retirementStepIdx` (the
      // seed when already retired).
      const retPreNom =
        retirementStepIdx === 0
          ? buckets.pre
          : out.preEnd[retirementStepIdx - 1];
      const retPostNom =
        retirementStepIdx === 0
          ? buckets.post
          : out.postEnd[retirementStepIdx - 1];
      row.retirementSnapshot = {
        preTax: retPreNom,
        postTax: retPostNom,
        fractionalYear: lastProjectionYear + ret.m,
      };
    }

    yearlyTotals.push(row);
  }

  const lastRow = yearlyTotals[yearlyTotals.length - 1];
  const retPre = lastRow.retirementSnapshot?.preTax ?? lastRow.preTax;
  const retPost = lastRow.retirementSnapshot?.postTax ?? lastRow.postTax;

  return {
    preTax: retPre,
    postTax: retPost,
    total: retPre + retPost,
    yearlyTotals,
    perStep: {
      firstYear: firstProjectionYear,
      preEnd: out.preEnd,
      postEnd: out.postEnd,
      growth: out.growth,
      contributions: out.contributions,
      withdrawal: out.withdrawal,
      deposit: out.deposit,
      expense: out.expense,
      income: out.income,
    },
  };
}
