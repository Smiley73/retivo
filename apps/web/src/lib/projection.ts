/**
 * Per-account balance projection to retirement date.
 *
 * Internally drives the shared monthly-stepping kernel
 * (`apps/web/src/lib/projection-engine/kernel.ts`) — accumulation runs
 * month-by-month, contributions land /12 across each year, the annual
 * planning rate is converted to its monthly equivalent
 * `(1 + ratePct/100)^(1/12) - 1`. Public output stays year-indexed; the
 * monthly stepping is invisible at the API boundary.
 *
 * Pre-tax / post-tax buckets are tracked separately through accumulation
 * so the page can surface tax-aware totals. MIXED accounts split via the
 * stored `*PreTax` / `*PostTax` payload fields throughout; non-MIXED
 * accounts route the entire balance + every contribution through the
 * bucket matching their `taxTreatment` (the account legality rules
 * ensure the cross-bucket fields are zero for
 * non-MIXED accounts).
 *
 * Output values are emitted in **nominal (event-month) dollars** — the
 * Balance Projection page applies a view-model deflator at the display
 * boundary when the user selects "Today's dollars".
 * Engines no longer accept
 * an `inflationPct`; consumers that need per-month deflators read
 * `realDeflatorAt` from `projection-context.ts`.
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
  /** Annual planning return, percent (e.g. 7 for 7 %/yr). Threaded
   *  through `monthlyEquivalent()` at the kernel adapter — each
   *  monthly step compounds by `(1 + ratePct/100)^(1/12)`. */
  ratePct: number;
  /** ISO `YYYY-MM-DD` — output of `retirementDate(birthdate, age)`.
   *  The household drawdown begins at the PRIMARY
   *  member's retirement
   *  date. Callers should pass primary's date here for every account
   *  (joint AND individual) so each account's at-retirement balance
   *  snapshots at the household boundary. Use `accumulationEndDate`
   *  to express owner-specific contribution stop months. */
  retirementDate: string;
  stopContributionsToday: boolean;
  todayYear: number;
  /** Today's calendar month index (0 = Jan). Together with `todayYear`
   *  forms the `asOfMonth` anchor for contribution growth so the
   *  configured contribution shows flat in the Today's-dollars view (the
   *  display deflator uses the same anchor). Defaults to 0 (January) when
   *  omitted — matches the expense engine's `todayMonthIndex ?? 0`. */
  todayMonthIndex?: number;
  /** Resolved per-account annual-increase rate for the planned
   *  contribution (percent). When supplied, each accumulation-step
   *  contribution is grown month-precise, today-anchored via
   *  `contributionGrowthFactor` so the configured figure holds its real
   *  value (tracks-inflation default) or grows nominally (explicit rate).
   *  Omitted / `0` → flat-nominal (legacy behavior). Only the recurring
   *  planned + company contribution fill is grown; one-off
   *  `preRetirementDeposits` are NOT growth-indexed. */
  contributionGrowthPct?: number;
  /** Optional contribution stop date (ISO). When supplied and earlier
   *  than `retirementDate`, the kernel zeroes contributions from this
   *  month onward but keeps compounding the balance through to the
   *  retirement boundary. Defaults to `retirementDate` (contributions
   *  accrue right up to the boundary). Callers pass the account OWNER's
   *  retirement date, falling back to the primary's date when the owner
   *  has none, so e.g. an individual 401(k) owned by the secondary stops
   *  contributing at the secondary's retirement date while the household's
   *  drawdown clock is the primary's. A date later than `retirementDate`
   *  is clamped to it: the kernel only runs through the retirement
   *  boundary. A joint account gets no special date; it follows whichever
   *  owner its payload names. */
  accumulationEndDate?: string;
  /** Optional event-month-anchored deposits added to the account's
   *  buckets during accumulation (before `accumulationEndDate`).
   *  Targeted one-off windfalls + pension
   *  lump-sums whose event month
   *  precedes primary-retirement route into the target account here
   *  instead of into the drawdown engine's `depositsByMonth`. Each
   *  deposit lands at (year, month0) in the matching tax bucket —
   *  pre-tax/post-tax both honored. Events outside the kernel's step
   *  window (before `firstProjectionYear` or at-or-after
   *  `accumulationEndDate`) silently drop; callers route post-
   *  accumulation deposits to the drawdown engine instead. */
  preRetirementDeposits?: ReadonlyArray<{
    year: number;
    month0: number;
    preTax: number;
    postTax: number;
  }>;
  /** Optional event-month-anchored PRE-TAX withdrawals subtracted from the
   *  account's pre-tax bucket during accumulation — the SOURCE leg of a
   *  working-years Roth conversion. A dedicated sibling of
   *  `preRetirementDeposits` so the deposit path stays positive-only.
   *
   *  Each entry is CLAMPED to the source pre-tax balance at the event month
   *  (the balance just before the event, INCLUDING that month's recurring
   *  contribution + any `preRetirementDeposits` folded at the same step), so a
   *  withdrawal can never drive the bucket negative. Multiple entries at
   *  the same (year, month0) apply in stored array order (deterministic).
   *  Events outside the kernel's step window (before `firstProjectionYear` or
   *  at-or-after `accumulationEndDate`) silently drop, matching
   *  `preRetirementDeposits`. The clamp + subtraction happen at the same pinned
   *  event month as the target deposit, BEFORE the kernel applies that month's
   *  growth factor, so the removed dollars forgo their remaining-months of
   *  compounding (the mirror of the deposit's earned growth). */
  preRetirementWithdrawals?: ReadonlyArray<{
    year: number;
    month0: number;
    preTax: number;
  }>;
}

interface ProjectionYear {
  year: number;
  /** Pre-tax bucket value at the end of the year, **nominal** dollars.
   *  The retirement year reports the year-end value assuming
   *  contributions stop on the retirement date and the balance compounds
   *  growth-only through Dec 31 — keeps the chart line slope consistent
   *  across years. The retirement-date partial-year balance is reported
   *  on `ProjectionOutput.preTax` / `postTax` / `total`, not here. */
  preTax: number;
  postTax: number;
  /** Investment gains for the year, **nominal** dollars. The year-by-year
   *  table reads this so pre-retirement rows can render a Gains column
   *  instead of a dash. */
  growth: number;
  /** Contributions added to the account this year, **nominal** dollars
   *  (planned + company, pre-tax + post-tax). 0 when
   *  `stopContributionsToday` is set or the account is past its
   *  contribution window. The retirement year reports only the
   *  partial-year contributions accrued up to the retirement date. */
  contributions: number;
  /** Set on the retirement-year row only. Captures the partial-year
   *  balance at the retirement date plus its fractional X position so
   *  the chart can drop a vertical reference line at the real
   *  retirement moment. */
  retirementSnapshot?: {
    preTax: number;
    postTax: number;
    /** `retirementYear + (retirementMonth + (day-1)/daysInMonth) / 12`. */
    fractionalYear: number;
  };
}

/**
 * Per-step kernel series passed through on `ProjectionOutput`. Length
 * = `(lastProjectionYear − firstProjectionYear + 1) × 12`. Step 0 =
 * January of `firstProjectionYear`. Consumers that want intra-year
 * resolution (cashflow / portfolio-flows charts) can read the kernel's
 * raw monthly series instead of re-aggregating from `yearlyTotals`.
 *
 * All values are **nominal** (pre-deflation) — the deflator is applied
 * only at the year-emit boundary that produces `ProjectionYear`. If a
 * downstream chart needs real-dollar values it can apply
 * `(1 + inflationPct/100)^(stepYear − todayYear)` to each entry.
 */
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
  /** Per-step kernel output, only present when the projection actually
   *  ran the kernel (i.e. not on the `latestBalanceYear > retirementYear`
   *  defensive branch). */
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
  // POST_TAX, HSA, and ROTH all seed the whole balance into the post (tax-free)
  // projection bucket. (HSA contributions are entered pre-tax — see
  // `contribAdds` — but the balance grows tax-free; the bucket split does not
  // drive HSA withdrawal tax, which is keyed off `taxTreatment === 'HSA'`.
  // Roth is post-tax funded and tax-free at withdrawal; same seeding.)
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
    // HSA contributions are entered pre-tax (payroll deduction) so they live in
    // `plannedContributionPreTax`, but the account is tax-free at withdrawal, so
    // the amount grows in the tax-free (post) projection bucket. The pre/post
    // bucket split is immaterial to HSA withdrawal tax (keyed off
    // `taxTreatment === 'HSA'`); routing to post keeps the balance attributed
    // tax-free in the yearly breakdown.
    return {
      pre: 0,
      post: account.plannedContributionPreTax + latest.companyContributions,
    };
  }
  if (tt === 'POST_TAX' || tt === 'ROTH') {
    // Roth is post-tax funded — contributions live on
    // `plannedContributionPostTax`, identical to POST_TAX.
    return {
      pre: 0,
      post: account.plannedContributionPostTax + latest.companyContributions,
    };
  }
  return assertNever(tt);
}

/**
 * Fold each source-leg pre-tax withdrawal into `contribPre` as a clamped
 * negative delta at its pinned event step. Pure (mutates the passed
 * `contribPre` array only). The clamp is computed against a forward simulation
 * of the pre-tax bucket that mirrors the single-pool accumulation kernel — seed
 * grows by the monthly factor each step, that step's `contribPre` is added
 * BEFORE growth — so the per-event clamp matches the balance the kernel sees at
 * that step (including the same month's recurring contribution + any deposit
 * folded earlier). Withdrawals are applied step-then-array order so multiple
 * same-step entries cascade against the depleting balance. Events outside
 * `[0, accumulationEndStepIdx)` silently drop, matching the deposit path.
 */
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
  // Group each in-window withdrawal by its step, preserving stored array order
  // for same-step entries (deterministic cascade).
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
  // Forward-simulate the pre-tax bucket over the same series the kernel runs.
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
  // Mirror the legacy boundary logic: firstProjectionYear normally
  // sits at max(latest+1, todayYear), but when retirement falls in
  // the same year as the latest balance we collapse the start to the
  // retirement year itself so the retirement-year row still emits
  // (covering monthIdx 0..retirementMonthIdx of that year).
  const firstProjectionYear = Math.min(
    Math.max(latest.payload.year + 1, input.todayYear),
    lastProjectionYear,
  );

  // Defensive: retirement is in the past relative to the latest
  // balance. Just return the current balance untouched (no deflation
  // either — there's no year to compare against).
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

  // Construct StepInputs across [firstProjectionYear, lastProjectionYear].
  // The retirement step is at the retirement month within the final
  // year of the horizon. Accumulation runs up to that point — there is
  // no drawdown phase in `project()` (the drawdown engine owns that).
  // The kernel still handles the boundary cleanly: at retirementStepIdx
  // the pre/post buckets fold into a single pool, the pool compounds
  // (no withdrawal because expense = 0), and we read the pool at the
  // retirement step for the partial-year snapshot.
  const horizonYears = lastProjectionYear - firstProjectionYear + 1;
  const stepCount = horizonYears * 12;
  const retirementStepIdx = (lastProjectionYear - firstProjectionYear) * 12 + ret.monthIdx;

  // Accumulation-end step. When the caller passes an earlier date
  // (split-retirement: an individual account whose owner retires
  // before the household's primary), contributions zero from this
  // step forward but the kernel still runs through retirementStepIdx.
  // Default = retirement step (legacy contract).
  let accumulationEndStepIdx = retirementStepIdx;
  if (input.accumulationEndDate) {
    const acc = parseRetirementDate(input.accumulationEndDate);
    const candidate = (acc.year - firstProjectionYear) * 12 + acc.monthIdx;
    // Clamp: the kernel only sees [0..retirementStepIdx]. Past-window
    // values (account already stopped contributing before the
    // projection started) collapse to 0 contributions throughout.
    accumulationEndStepIdx = Math.max(0, Math.min(retirementStepIdx, candidate));
  }

  const monthlyRetPct = monthlyEquivalent(input.ratePct);
  const mainReturnPct = new Float64Array(stepCount).fill(monthlyRetPct);
  const contribPre = new Float64Array(stepCount);
  const contribPost = new Float64Array(stepCount);
  if (!input.stopContributionsToday) {
    const perMonthPre = adds.pre / 12;
    const perMonthPost = adds.post / 12;
    // Grow each accumulation-step contribution month-precise, anchored at
    // TODAY (not `firstProjectionYear`) so the configured figure is the
    // current-year today's-dollars amount and shows flat in the
    // Today's-dollars view, which deflates against the same today anchor.
    // Step 0 = January of `firstProjectionYear`. The growth
    // factor is 1 when no rate is supplied (legacy flat-nominal) or for an
    // out-of-band rate (guarded in the helper).
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

  // Pre-retirement deposits land in the matching bucket at the event
  // month via the kernel's `contribPre/contribPost` series — the
  // kernel folds these into the bucket BEFORE applying the monthly
  // growth factor, so each deposit earns its remaining-months of
  // compound growth, matching the "$40k 2yr pre-primary → portfolio
  // +$40k + 2yr growth in target" pin.
  const deposits = input.preRetirementDeposits ?? [];
  for (const d of deposits) {
    const stepIdx = (d.year - firstProjectionYear) * 12 + d.month0;
    if (stepIdx < 0 || stepIdx >= accumulationEndStepIdx) continue;
    contribPre[stepIdx] += d.preTax;
    contribPost[stepIdx] += d.postTax;
  }

  // Source-leg pre-tax withdrawals — clamped to the source pre-tax
  // balance AT the event month, then folded into `contribPre` as a negative
  // delta at the same pinned step so the kernel removes the dollars BEFORE that
  // month's growth (mirror of the deposit's pre-growth fold). The clamp needs
  // each event-month balance, so simulate the pre-tax bucket forward — over the
  // SAME `contribPre` series the kernel will run (deposits already folded) —
  // and apply each withdrawal in stored array order. Out-of-window events drop.
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

  // Nominal emit — the page applies a view-model deflator at display
  // time when the user picks "Today's dollars". `inflationPct` is
  // intentionally not consulted here. The kernel's
  // growth / contributions sums are nominal by construction.
  for (let yIdx = 0; yIdx < horizonYears; yIdx += 1) {
    const calendarYear = firstProjectionYear + yIdx;
    const isFinalYear = calendarYear === lastProjectionYear;
    const yearEndStep = isFinalYear
      ? Math.min(stepCount - 1, retirementStepIdx + (12 - ret.monthIdx) - 1)
      : (yIdx + 1) * 12 - 1;

    let growthSum = 0;
    let contribSum = 0;
    const yearStartStep = yIdx * 12;
    // For the retirement year we accrue through end of December (the
    // chart line walks through Dec 31 of the retirement year) — that
    // matches the prior behaviour and the kernel computes the months
    // past retirement at zero contributions, zero growth.
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
      // Retirement-date balance = pool at the boundary between
      // accumulation and drawdown — i.e. end of the month JUST BEFORE
      // `retirementStepIdx`. retirementStepIdx === 0 (already retired
      // entering the projection) → balance equals the seed.
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
