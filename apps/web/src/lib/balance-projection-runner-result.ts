/**
 * Result-shaping helpers: pure transforms from `PipelineContext` and drawdown-engine output into the public
 * `RunBalanceProjectionFullResult` surfaces.
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
 * Mirrors the Balance Projection "At horizon — Planned" stat card: the last drawdown year's nominal balance
 * times the year-end deflator factor.
 * Takes either `factor` or `horizonYear` plus `projCtx` (Today's dollars). An empty drawdown gives 0.
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
 * Per-account, per-year nominal balance (December anchor) with the contribution/growth split from
 * `project()`'s `yearlyTotals`; `withdrawalsThisYear` stays 0 because `project()` models accumulation only.
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
  // The engine return does not split `expense`/`income`/`ss`, so they surface as 0.
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
  // The engine returns per-year totals only, so emit one synthetic event per year at month 12 with no source
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
 * Life-expectancy markers from the resolved scenario; `fractionalYear` is the integer `deathYear` (Dec 31),
 * with no `+ 1` because the chart applies its own death-year-end convention.
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
 * Empty result: markers and anchors are unconditional; per-account balances still surface for the
 * TWR-insufficient case.
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

/**
 * Clones the household `depositsByMonth` and subtracts every CBP lump-sum already routed to a target account,
 * so the kernel does not apply it twice.
 * The subtraction is clamped to the series value at the event month: linked-CBP events at or after primary
 * retirement are not in `depositInflow`.
 */
export function subtractCbpLumpSumsFromHouseholdDeposits(
  household: MonthlyCashflowSeries,
  cbpLumpSumDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>,
): MonthlyCashflowSeries {
  if (cbpLumpSumDeposits.length === 0) return household;
  // Clones the Float64Array: the cashflow builder caches one series under several keys.
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
    const subtract = Math.min(cloned.values[idx], dep.amount);
    cloned.values[idx] -= subtract;
  }
  return cloned;
}
