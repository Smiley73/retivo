/**
 * Result-shaping helpers for `balance-projection-runner.ts`. Pure shape
 * transforms from the internal `PipelineContext` + drawdown-engine
 * output into the public `RunBalanceProjectionFullResult` surfaces
 * (`accountYears`, `drawdownYears`, `withdrawalEvents`, marker arrays,
 * empty-result builders). Extracted from `balance-projection-runner.ts`
 * so the runner file holds only the public entry points + orchestration
 * (file shape cap).
 * No circular dep back to the entry points — these are leaf transforms.
 */
import type { DrawdownYear } from './drawdown-engine';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../db/types';
import { projectedDeathFractionalYear } from './expense-preview-projection';
import { realDeflatorAt } from './projection-context';
import type {
  AccountYearRow,
  DrawdownYearRow,
  LifeExpectancyMarker,
  MonthlyCashflowSeriesPublic,
  PipelineContext,
  RetirementMarkerOutput,
  RunBalanceProjectionArgs,
  RunBalanceProjectionFullResult,
  WithdrawalEvent,
} from './balance-projection-runner-types';

/**
 * Pure helper that mirrors BPP's "At horizon — Planned" stat-card
 * arithmetic: read the last drawdown year's nominal balance, multiply
 * by the year-end deflator factor.
 *
 * Two callable shapes:
 *  - `{ drawdownPlannedYears, factor }` — BPP supplies its
 *    `viewDeflator(horizonYear, 11)` result directly (the page's
 *    Today/Future display toggle is honoured outside this helper).
 *  - `{ drawdownPlannedYears, horizonYear, projCtx }` — the runner
 *    supplies a `ProjectionContext` and the helper computes the
 *    Today's-dollar factor via `realDeflatorAt(ctx, horizonYear, 11)`
 *    (always Today's dollars — the optimizer's metric anchor).
 *
 * Both the page and the runner reduce to the same arithmetic, so the
 * BPP-equivalence parity test pins one source of truth for the
 * stat-card oracle. Pure; empty drawdown ⇒ 0 (BPP renders `—`).
 */
export function computePlannedAtHorizonToday(
  args:
    | {
        readonly drawdownPlannedYears: ReadonlyArray<{ readonly balance: number }>;
        readonly factor: number;
      }
    | {
        readonly drawdownPlannedYears: ReadonlyArray<{ readonly balance: number }>;
        readonly horizonYear: number;
        readonly projCtx: Parameters<typeof realDeflatorAt>[0];
      },
): number {
  const last =
    args.drawdownPlannedYears.length > 0
      ? args.drawdownPlannedYears[args.drawdownPlannedYears.length - 1].balance
      : 0;
  const factor =
    'factor' in args
      ? args.factor
      : realDeflatorAt(args.projCtx, args.horizonYear, 11);
  return last * factor;
}

function emptyCashflowSeries(): MonthlyCashflowSeriesPublic {
  const empty = {
    startYear: 0,
    startMonthIndex: 0,
    values: new Float64Array(0),
  };
  return {
    incomeByMonth: empty,
    expensesByMonth: empty,
    depositsByMonth: empty,
  };
}

/**
 * Per-account, per-year nominal balance (December anchor) plus the
 * per-year contribution / growth split lifted from `project()`'s
 * `yearlyTotals`. `withdrawalsThisYear` stays `0` for the accumulation
 * phase — `project()` models accumulation only; post-retirement
 * per-account withdrawal attribution lives on the drawdown engine's
 * per-account ledger (`DrawdownYear.accountBalances`), surfaced
 * separately for the consumer that needs it. Nominal — the renderer
 * applies `realDeflatorAt(ctx, year, 11)` at display time.
 */
export function buildAccountYearsMap(
  ctx: PipelineContext,
): ReadonlyMap<string, ReadonlyArray<AccountYearRow>> {
  const out = new Map<string, ReadonlyArray<AccountYearRow>>();
  const method = ctx.method;
  for (const proj of ctx.accountProjections) {
    const projOut = proj.outputs[method];
    if (!projOut) continue;
    const rows: AccountYearRow[] = projOut.yearlyTotals.map((yt) => ({
      year: yt.year,
      nominalBalance: yt.preTax + yt.postTax,
      growthCarry: yt.growth,
      contributionsThisYear: yt.contributions,
      withdrawalsThisYear: 0,
    }));
    out.set(proj.account.id, rows);
  }
  return out;
}

export function buildDrawdownYearRows(
  years: ReadonlyArray<DrawdownYear>,
): ReadonlyArray<DrawdownYearRow> {
  // DrawdownYear surfaces aggregate per-year totals. `expense`/`income`/
  // `ss` are not split on the engine return — surface as 0 here and
  // let the renderer read them off `monthlyCashflowSeries` if needed.
  // Tax fields pass through unchanged — absent (undefined) on legacy callers.
  return years.map((y) => ({
    year: y.year,
    nominalBalance: y.balance,
    withdrawal: y.withdrawn,
    expense: 0,
    income: 0,
    ss: 0,
    deposit: y.deposit,
    federalTaxCents: y.federalTaxCents,
    taxableSsCents: y.taxableSsCents,
    ssTaxationTier: y.ssTaxationTier,
    rmdFloorCents: y.rmdFloorCents,
    rmdShortfallCents: y.rmdShortfallCents,
    rmdReinvestedCents: y.rmdReinvestedCents,
    rmdOverflowToCashCents: y.rmdOverflowToCashCents,
    irmaaSurchargeCents: y.irmaaSurchargeCents,
    irmaaTier: y.irmaaTier,
    acaPtcSubsidyCents: y.acaPtcSubsidyCents,
    acaPtcTier: y.acaPtcTier,
    acaCreditAppliedToPremiumsCents: y.acaCreditAppliedToPremiumsCents,
    magiCents: y.magiCents,
    fplPercentage: y.fplPercentage,
    effectiveTaxRate: y.effectiveTaxRate,
    netAfterTaxCents: y.netAfterTaxCents,
    taxYearExtrapolated: y.taxYearExtrapolated,
    magiCapBreachDollars: y.magiCapBreachDollars,
    magiCapTierOverrideDollars: y.magiCapTierOverrideDollars,
    rothConvertedCents: y.rothConvertedCents,
    rothConversionDegradedNoTarget: y.rothConversionDegradedNoTarget,
  }));
}

export function buildWithdrawalEvents(
  years: ReadonlyArray<DrawdownYear>,
): ReadonlyArray<WithdrawalEvent> {
  // Drawdown engine surfaces per-year totals only — month-level
  // withdrawal events aren't carried on the existing engine return.
  // Emit one synthetic event per year at month-12 with no source
  // account.
  const out: WithdrawalEvent[] = [];
  for (const y of years) {
    if (y.withdrawn === 0) continue;
    out.push({
      month: y.year * 12 + 11,
      amount: y.withdrawn,
      sourceAccountId: '',
    });
  }
  return out;
}

/**
 * Life-expectancy markers from the resolved scenario. `fractionalYear`
 * is the integer `deathYear` (`projectedDeathFractionalYear` returns
 * `birthYear + age`; death = Dec 31 of `deathYear`). No `+ 1` is
 * applied here: this builder's output reaches only a `.length > 0` test
 * (see `balance-projection-runner.test.ts`) and never the chart marker —
 * the balance chart's `+ 1` death-year-end convention lives in
 * `ProjectionChartInner`.
 */
export function buildLifeExpectancyMarkers(
  ctx: PipelineContext,
): ReadonlyArray<LifeExpectancyMarker> {
  const out: LifeExpectancyMarker[] = [];
  const life = ctx.resolvedScenario.lifeExpectancy;
  const ageFor = (slot: 'primary' | 'secondary'): number =>
    life?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const push = (
    memberId: string,
    birthIso: string | null | undefined,
    slot: 'primary' | 'secondary',
  ): void => {
    if (!birthIso) return;
    const frac = projectedDeathFractionalYear(birthIso, ageFor(slot));
    if (frac === null) return;
    out.push({ memberId, fractionalYear: frac, label: slot });
  };
  push(ctx.primary.id, ctx.primary.payload.birthdate, 'primary');
  if (ctx.secondary) {
    push(ctx.secondary.id, ctx.secondary.payload.birthdate, 'secondary');
  }
  return out;
}

export function buildRetirementMarkersFromCtx(
  ctx: PipelineContext,
): ReadonlyArray<RetirementMarkerOutput> {
  const out: RetirementMarkerOutput[] = [];
  ctx.retirementByMember.forEach((iso, memberId) => {
    if (!iso) return;
    const year = Number(iso.slice(0, 4));
    const month0 = Number(iso.slice(5, 7)) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(month0)) return;
    const isPrimary = memberId === ctx.primary.id;
    out.push({
      memberId,
      year,
      month0,
      label: isPrimary ? 'primary' : 'secondary',
    });
  });
  return out;
}

/**
 * `cbpResolution`, marker arrays, anchor numbers are unconditional.
 * Per-account/per-year balances still surface for the TWR-insufficient
 * case so the year-by-year table renders "Insufficient history"
 * annotations on the unavailable rows without crashing.
 */
export function buildEmptyFullResult(
  args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): RunBalanceProjectionFullResult {
  const accountYears = buildAccountYearsMap(ctx);
  return {
    atHorizonTodayDollars: 0,
    ssStartYear: ctx.ssStartYear,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    ctx: ctx.projCtx,
    methodAvailable: ctx.methodAvailable,
    accountYears,
    drawdownYears: [],
    withdrawalEvents: [],
    monthlyCashflowSeries: emptyCashflowSeries(),
    lifeExpectancyMarkers: buildLifeExpectancyMarkers(ctx),
    retirementMarkers: buildRetirementMarkersFromCtx(ctx),
    cbpResolution: ctx.cbpValidation,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex,
  };
}

/** Clone the household-aggregate `depositsByMonth` and subtract
 *  every CBP lump-sum dollar that's been routed to a target account's
 *  per-account `depositsByMonth`. Avoids the double-count where the
 *  kernel applies the same CBP dollars both per-account (via
 *  `acc.deposit[i]`) AND proportionally via the household-aggregate
 *  `s.deposit[i]`. Mirrors the MC bundle factory's `skipsPortfolio: true`
 *  contract for `lumpSum`-elected CBP.
 *
 *  Clamps the subtraction to the existing series value at the event
 *  month — production `incomeProjection` drops at/post-primary linked-
 *  CBP events (lookup returns null), so the household-aggregate may
 *  not contain the dollars; subtracting unconditionally would create
 *  negative deposits the kernel would apply as withdrawals. */
export function subtractCbpLumpSumsFromHouseholdDeposits(
  household: MonthlyCashflowSeries,
  cbpLumpSumDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>,
): MonthlyCashflowSeries {
  if (cbpLumpSumDeposits.length === 0) return household;
  // Clone the underlying Float64Array — never mutate the input series
  // (the cashflow builder caches the same series under multiple keys).
  const cloned: MonthlyCashflowSeries = {
    startYear: household.startYear,
    startMonthIndex: household.startMonthIndex,
    values: new Float64Array(household.values),
  };
  const startAbs = cloned.startYear * 12 + cloned.startMonthIndex;
  for (const dep of cbpLumpSumDeposits) {
    const targetAbs = dep.year * 12 + dep.month0;
    const idx = targetAbs - startAbs;
    if (idx < 0 || idx >= cloned.values.length) continue;
    // Clamp to existing value — production drops at/post-primary
    // linked-CBP events from `depositInflow`, so the household-
    // aggregate doesn't always carry the dollars to subtract.
    const subtract = Math.min(cloned.values[idx], dep.amount);
    cloned.values[idx] -= subtract;
  }
  return cloned;
}
