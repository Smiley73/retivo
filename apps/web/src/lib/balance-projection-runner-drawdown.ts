/**
 * Per-method deterministic drawdown executor: ledger build, CBP-deposit subtraction, RMD and QCD contexts,
 * and MAGI-cap window resolution.
 * See `docs/math-withdrawals.md` ("Where the code lives").
 */
import { simulateDrawdown, type DrawdownOutput } from './drawdown-engine';
import {
  buildPerAccountDrawdownLedger,
  buildRmdEngineFactsFragment,
} from './balance-projection-runner-context';
import { resolveLinkedCbpIncomeStreams } from './cbp-resolution';
import { isMagiCapDisabled } from '../db/types';
import type { MagiCapOverride, MagiCapWindow } from '../db/types';
import { buildMagiCapConfig } from './drawdown-engine-per-account-magi-cap';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';
import {
  applyTaxIntegrationToDrawdownYears,
  buildTaxCashflowHook,
} from './balance-projection-runner-tax';
import { resolveHouseholdDeathYears } from './balance-projection-runner-tax-helpers';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import type { TaxCalibrationBundle } from './tax-integration';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  DrawdownYear,
  QcdContextInput,
  RmdContextInput,
} from './drawdown-engine-types';
import { qcdFirstEligibleTaxYear } from './qcd';
import { QCD_LIMITS } from './qcd-limits';
import { dollarsToCents } from './tax-integration';
import { inflationFactorAt } from './projection-context';
import type { RetirementAllocationOverride } from '../db/types';
import {
  resolveGlideAnchors,
  targetGrowthShareForStep,
} from './allocation-glide';
import {
  type CashflowSeries,
  type PageDrawdownMethodResult,
  type PipelineContext,
  type ProjectionMethod,
  type RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import {
  buildAccountYearsMap,
  computePlannedAtHorizonToday,
  subtractCbpLumpSumsFromHouseholdDeposits,
} from './balance-projection-runner-result';

/**
 * Per-method deterministic drawdown over the shared agnostic `series`. Returns the raw drawdown output, the
 * at-horizon value and the per-method `accountYears`, or `null` when no drawdown is produced.
 * Throws `MissingCustomDrawdownOrderError`; a MAGI-cap window with an unresolvable anchor does not throw, it
 * is flagged inactive.
 */
export function runDrawdownForMethod(
  _args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  series: CashflowSeries,
  method: ProjectionMethod,
): PageDrawdownMethodResult | null {
  // `methodCtx` goes only to the helpers that read `outputs[method]`; `executeDrawdown` takes the agnostic
  // `ctx`.
  // @134 delete
  const methodCtx: PipelineContext = ctx.method === method ? ctx : { ...ctx, method };
  const portfolioAtRetirement = computePortfolioAtRetirement(methodCtx);
  const ledger = buildPerAccountDrawdownLedger({
    ctx: methodCtx,
    method,
    expensesByMonth: series.expensesByMonth,
    postPrimaryEvents: series.postPrimaryContributionEvents,
    plainPensionEvents: series.plainPensionPlacementEvents,
  });
  const perAccountLedger = ledger.accounts;
  const accountYears = buildAccountYearsMap(methodCtx);
  if (portfolioAtRetirement <= 0 || perAccountLedger.length === 0) {
    return null;
  }
  const drawdown = executeDrawdown({
    ctx,
    series,
    portfolioAtRetirement,
    perAccountLedger,
    allocation: ctx.resolvedScenario.retirementAllocation,
    cbpLumpSumDeposits: ledger.cbpLumpSumDeposits,
    plainPensionDeposits: ledger.plainPensionDeposits,
    rolledRmdIncomeByYear: ledger.rolledRmdIncomeByYear,
  });
  const atHorizonTodayDollars = computePlannedAtHorizonToday({
    drawdownPlannedYears:
      drawdown.years.length > 0
        ? drawdown.years
        : [{ balance: portfolioAtRetirement }],
    horizonYear: ctx.horizonYear,
    projCtx: ctx.projCtx,
  });
  return {
    years: drawdown.years,
    depletionYear: drawdown.depletionYear,
    perMonthWithdrawal: drawdown.perMonthWithdrawal,
    atHorizonTodayDollars,
    accountYears,
    netPortfolioAtRetirement: portfolioAtRetirement,
  };
}

interface DrawdownExecOpts {
  readonly ctx: PipelineContext;
  readonly series: CashflowSeries;
  readonly portfolioAtRetirement: number;
  readonly perAccountLedger: ReadonlyArray<DrawdownAccountInput>;
  /**
   * The scenario's `retirementAllocation` override; the ledger already carries the blended-glide
   * `returnPctByMonth`, so this only feeds the Gains tooltip post-pass.
   */
  readonly allocation: RetirementAllocationOverride | undefined;
  readonly cbpLumpSumDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>;
  /** Plain-pension lump-sum dollars placed per account, subtracted from the household-aggregate deposits. */
  readonly plainPensionDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>;
  /**
   * Per-calendar-year rolled-CBP RMD income (dollars), added to the spendable income series and the
   * ordinary-income tax inlets.
   */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
}

// The engine funds the tax cashflow itself through the `taxCashflow` hook; this post-pass only annotates
// display fields and never alters balances.
function executeDrawdown(opts: DrawdownExecOpts): DrawdownOutput {
  const { ctx, series, perAccountLedger, allocation } = opts;
  const drawdown = simulateDrawdown(buildDrawdownEngineInput(opts));
  applyTaxIntegrationToDrawdownYears(
    drawdown.years,
    series.ssRows,
    series.nonSsIncomeRows,
    perAccountLedger,
    ctx,
    ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE,
    opts.rolledRmdIncomeByYear,
    // The full `isMedical` inventory, not the HSA-filtered demand: Medicare, Medigap and drug-plan premiums
    // are not HSA-qualified.
    series.anyMedicalSpendingModeled,
  );
  // Allocation-weighted estimated return attribution for the Gains tooltip; absent without an allocation
  // override.
  if (allocation) {
    deriveAllocationGainTooltip(drawdown.years, perAccountLedger, allocation, ctx.primaryRetirementYear);
  }
  return drawdown;
}

// Growth share is `nonCbpGain * growthShare(y)`; income is the single residual
// `year.growth - growthBucket.gain`, so the parts sum exactly. This is an estimate, not a per-bucket
// placement: non-CBP gain is the total scaled by the non-CBP balance fraction at year start.
function deriveAllocationGainTooltip(
  years: DrawdownYear[],
  ledger: ReadonlyArray<DrawdownAccountInput>,
  allocation: RetirementAllocationOverride,
  retirementYear: number,
): void {
  const { effectiveGlideStartYear, glideEnabled } = resolveGlideAnchors(allocation, retirementYear);
  const cbpIds = new Set(
    ledger.filter((a) => a.accountType === 'RETIREMENT_CASH_BALANCE').map((a) => a.id),
  );
  const hasCbp = cbpIds.size > 0;
  for (const year of years) {
    const share = targetGrowthShareForStep(
      year.year,
      allocation,
      effectiveGlideStartYear,
      glideEnabled,
    );
    // The accountBalances map carries no per-account gain, so the CBP gain is estimated by the CBP balance
    // fraction at year end; exact with no CBP account.
    let nonCbpGain = year.growth;
    if (hasCbp && year.accountBalances) {
      let cbpBal = 0;
      let totalBal = 0;
      for (const [id, acc] of year.accountBalances) {
        totalBal += acc.balance;
        if (cbpIds.has(id)) cbpBal += acc.balance;
      }
      const cbpFraction = totalBal > 0 ? cbpBal / totalBal : 0;
      nonCbpGain = year.growth * (1 - cbpFraction);
    }
    const growthGain = nonCbpGain * share;
    year.growthBucket = { gain: growthGain };
    year.incomeBucket = { gain: year.growth - growthGain };
    year.growthPct = share * 100;
  }
}

function buildDrawdownEngineInput(opts: DrawdownExecOpts): DrawdownInput {
  const { ctx, series, portfolioAtRetirement, perAccountLedger } = opts;
  // The per-account ledger and the household aggregate hold the same CBP lump-sum and plain-pension dollars;
  // subtract them so the kernel does not apply them twice.
  const kernelDepositsByMonth = subtractCbpLumpSumsFromHouseholdDeposits(
    series.depositsByMonth,
    [...opts.cbpLumpSumDeposits, ...opts.plainPensionDeposits],
  );
  const strategy = ctx.resolvedScenario.withdrawalStrategy ?? { kind: 'taxEfficient' };
  // The rollover-year RMD cash is spendable income for its year, matching the MC `otherIncome` semantics to
  // the cent; it is taxed separately via the ordinary-income inlet.
  const incomeByMonth = addRolledRmdToIncomeSeries(
    series.incomeByMonth,
    opts.rolledRmdIncomeByYear,
  );
  const rmdContext: RmdContextInput | undefined =
    perAccountLedger.length > 0
      ? buildRmdContext(ctx, perAccountLedger, ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE)
      : undefined;
  // Per-owner QCD forced-outflow context; undefined (engine pass is a no-op) when nothing resolved or there
  // is no ledger.
  const qcdContext =
    perAccountLedger.length > 0 ? buildQcdContext(ctx) : undefined;
  const rawMagiCap = ctx.resolvedScenario.magiCap;
  // Coerce the `{ disabled: true }` sentinel to no cap so the engine never sees it.
  const magiCap = isMagiCapDisabled(rawMagiCap) ? undefined : rawMagiCap;
  const magiCapWindows = magiCap ? resolveMagiCapWindows(magiCap, ctx) : undefined;
  const taxCashflow = buildTaxCashflowHookForInput(
    ctx,
    series,
    perAccountLedger,
    opts.rolledRmdIncomeByYear,
  );
  return {
    portfolioAtRetirement,
    ratePct: 0,
    expensesByMonth: series.expensesByMonth,
    incomeByMonth,
    depositsByMonth: kernelDepositsByMonth,
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    withdrawalStrategy: strategy,
    accounts: perAccountLedger,
    rmdContext,
    qcdContext,
    customDrawdownOrder: ctx.resolvedScenario.customDrawdownOrder,
    magiCapWindows,
    taxCashflow,
    medicalDemandByMonth: series.medicalDemandByMonth,
  };
}

function buildTaxCashflowHookForInput(
  ctx: PipelineContext,
  series: CashflowSeries,
  perAccountLedger: ReadonlyArray<DrawdownAccountInput>,
  rolledRmdIncomeByYear: ReadonlyMap<number, number>,
): ReturnType<typeof buildTaxCashflowHook> {
  return buildTaxCashflowHook({
    ctx,
    ssRows: series.ssRows,
    nonSsIncomeRows: series.nonSsIncomeRows,
    ledgerAccounts: perAccountLedger,
    bundle: ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE,
    retirementYear: ctx.primaryRetirementYear,
    // Fund the incremental tax on the same rollover-year RMD income the post-pass taxes.
    rolledRmdIncomeByYear,
    medicalExpenseByMonthCents: series.medicalExpenseByMonth,
  });
}

// Spreads the rolled RMD cash evenly over the 12 months of the event year, as the MC kernel's
// `flatNominal = incomeByYear / 12` does; a single-month spike would diverge from MC in cross-engine
// cent-parity.
function addRolledRmdToIncomeSeries(
  income: import('./monthly-cashflow').MonthlyCashflowSeries,
  rolledRmdIncomeByYear: ReadonlyMap<number, number>,
): import('./monthly-cashflow').MonthlyCashflowSeries {
  if (rolledRmdIncomeByYear.size === 0) return income;
  const cloned = {
    startYear: income.startYear,
    startMonthIndex: income.startMonthIndex,
    values: new Float64Array(income.values),
  };
  const startAbs = cloned.startYear * 12 + cloned.startMonthIndex;
  rolledRmdIncomeByYear.forEach((dollars, year) => {
    if (dollars === 0) return;
    const perMonth = dollars / 12;
    for (let m = 0; m < 12; m += 1) {
      const idx = year * 12 + m - startAbs;
      if (idx < 0 || idx >= cloned.values.length) continue;
      cloned.values[idx] += perMonth;
    }
  });
  return cloned;
}

/**
 * Sums the per-account at-retirement balances minus annuity-elected CBP and pre-retirement lump-sum-elected
 * CBP, whose dollars flow as income or deposits.
 */
function computePortfolioAtRetirement(ctx: PipelineContext): number {
  const method = ctx.method;
  const cbpElections = resolveLinkedCbpIncomeStreams({
    scenarioId: ctx.scenarioId,
    scenarios: ctx.effectiveScenarios,
    accounts: ctx.accountProjections.map((p) => p.account),
    incomeStreams: ctx.incomeStreams,
  });
  let total = 0;
  for (const proj of ctx.accountProjections) {
    const out = proj.outputs[method];
    if (out === null) continue;
    total += out.total;
  }
  for (const proj of ctx.accountProjections) {
    if (proj.account.payload.type !== 'RETIREMENT_CASH_BALANCE') continue;
    const election = cbpElections.get(proj.account.id);
    if (!election) continue;
    const out = proj.outputs[method];
    if (!out) continue;
    if (election.kind === 'annuity') {
      total -= out.total;
      continue;
    }
    if (election.kind === 'lumpSum') {
      const eventAbsMonth = ctx.cbpLumpSumEventAbsMonth.get(proj.account.id);
      if (
        eventAbsMonth !== undefined &&
        eventAbsMonth < ctx.primaryRetirementAbsMonth
      ) {
        total -= out.total;
      }
    }
  }
  return Math.max(0, total);
}

// `owner` is left undefined: cap windows always carry an explicit `age.memberId`.
function buildCapResolveCtx(ctx: PipelineContext): ScheduleResolveContext {
  return {
    retirementYear: ctx.primaryRetirementYear,
    retirementMonth0: ctx.primaryRetirementMonth0,
    primary: ctx.primary.payload.birthdate
      ? { birthdate: ctx.primary.payload.birthdate }
      : undefined,
    secondary: ctx.secondary?.payload.birthdate
      ? { birthdate: ctx.secondary.payload.birthdate }
      : undefined,
  };
}

// Collapses the month-precise anchors to a half-open `[startYear, endYear)` of whole tax years
// (`calendarYear < birthYear + endAge` for an age end); `null` when either anchor is unresolvable.
function resolveWindowYears(
  window: MagiCapWindow,
  resolveCtx: ScheduleResolveContext,
): { startYear: number; endYear: number } | null {
  const startMonth = resolveStartMonth(window.start, resolveCtx);
  if (!startMonth) return null;
  const endMonth = resolveEndMonth(window.end, startMonth, resolveCtx);
  if (!endMonth) return null;
  return { startYear: startMonth.year, endYear: endMonth.year };
}

/**
 * Resolves a MAGI-cap window schedule into the engine's runtime window list sorted by
 * `(startYear, endYear, originalIndex)`. A broken anchor keeps the window flagged `brokenAnchor` with empty
 * bounds; a non-positive interval is dropped.
 * Returns `undefined` when no usable window remains.
 */
function resolveMagiCapWindows(
  magiCap: MagiCapOverride,
  ctx: PipelineContext,
): ReadonlyArray<MagiCapWindowRuntime> | undefined {
  if (magiCap.windows.length === 0) return undefined;
  const resolveCtx = buildCapResolveCtx(ctx);
  const resolved: MagiCapWindowRuntime[] = [];
  for (let i = 0; i < magiCap.windows.length; i += 1) {
    const w = magiCap.windows[i];
    const years = resolveWindowYears(w, resolveCtx);
    if (years === null) {
      // A broken window gets empty `[i, i)` bounds so it never selects.
      resolved.push({
        startYear: 0,
        endYear: 0,
        originalIndex: i,
        brokenAnchor: true,
        config: buildMagiCapConfig(w, 0),
      });
      continue;
    }
    if (years.endYear <= years.startYear) continue;
    resolved.push({
      startYear: years.startYear,
      endYear: years.endYear,
      originalIndex: i,
      config: buildMagiCapConfig(w, years.endYear),
    });
  }
  if (resolved.length === 0) return undefined;
  resolved.sort(compareMagiCapWindows);
  return resolved;
}

/**
 * Total order `(startYear, endYear, originalIndex)` for deterministic window selection; the MC engine sorts
 * with the same comparator.
 */
export function compareMagiCapWindows(
  a: MagiCapWindowRuntime,
  b: MagiCapWindowRuntime,
): number {
  if (a.startYear !== b.startYear) return a.startYear - b.startYear;
  if (a.endYear !== b.endYear) return a.endYear - b.endYear;
  return a.originalIndex - b.originalIndex;
}

/**
 * Resolves a MAGI-cap schedule to the serializable per-window bounds the MC boundary carries, index-aligned
 * to `magiCap.windows`; a broken or non-positive window keeps an empty `[0,0)` interval. `undefined` for an
 * empty schedule.
 */
export function resolveMagiCapWindowBounds(
  magiCap: MagiCapOverride,
  ctx: PipelineContext,
): ReadonlyArray<{ startYear: number; endYear: number; brokenAnchor: boolean }> | undefined {
  if (magiCap.windows.length === 0) return undefined;
  const resolveCtx = buildCapResolveCtx(ctx);
  return magiCap.windows.map((w) => {
    const years = resolveWindowYears(w, resolveCtx);
    if (years === null || years.endYear <= years.startYear) {
      return { startYear: 0, endYear: 0, brokenAnchor: years === null };
    }
    return { startYear: years.startYear, endYear: years.endYear, brokenAnchor: false };
  });
}

/**
 * Builds the `RmdContextInput` the engine uses for its per-year, per-owner, per-account RMD floor: metadata
 * and the calibration snapshot only, since the engine reads the prior-year-end balances itself. Also carries
 * per-account RMD profile facts and per-owner separation years.
 */
function buildRmdContext(
  ctx: PipelineContext,
  ledger: ReadonlyArray<DrawdownAccountInput>,
  bundle: TaxCalibrationBundle,
): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const acc of ledger) {
    const proj = ctx.accountProjections.find((p) => p.account.id === acc.id);
    if (!proj) continue;
    ownerByAccountId.set(acc.id, proj.account.payload.ownerId);
  }

  // Death is modelled as Dec 31 of `deathYear`, so the RMD floor applies through `deathYear`. An unusable
  // birthdate yields `Infinity` (alive every year), as in the MC mirror `buildStrategyRmdContext`, not a
  // `NaN` from a bare `parseInt`.
  const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  const primaryBirth = ctx.primary.payload.birthdate ?? null;
  if (primaryBirth) {
    ownerMeta.set(ctx.primary.id, {
      isoBirthdate: primaryBirth,
      deathYear: primaryDeathYear ?? Number.POSITIVE_INFINITY,
    });
  }
  if (ctx.secondary) {
    const secBirth = ctx.secondary.payload.birthdate ?? null;
    if (secBirth) {
      ownerMeta.set(ctx.secondary.id, {
        isoBirthdate: secBirth,
        deathYear: secondaryDeathYear ?? Number.POSITIVE_INFINITY,
      });
    }
  }

  return {
    ownerMeta,
    ownerByAccountId,
    rmdSnapshot: bundle.rmd,
    ...buildRmdEngineFactsFragment(ctx),
  };
}

/**
 * Indexed per-person §408(d)(8) QCD exclusion limit (integer cents) for `taxYear`: later years are
 * inflation-extrapolated from the latest published key, earlier years clamp to the earliest.
 */
export function resolveQcdLimitCentsForYear(taxYear: number, inflationPct: number): number {
  const years = Object.keys(QCD_LIMITS.values)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const earliest = years[0];
  const latest = years[years.length - 1];
  if (taxYear <= earliest) {
    return dollarsToCents(QCD_LIMITS.values[earliest].annualLimitDollars);
  }
  if (taxYear <= latest) {
    // A published or interior gap year clamps down to the most recent published key at or before `taxYear`.
    let key = earliest;
    for (const y of years) {
      if (y <= taxYear) key = y;
    }
    return dollarsToCents(QCD_LIMITS.values[key].annualLimitDollars);
  }
  const base = QCD_LIMITS.values[latest].annualLimitDollars;
  const factor = Math.pow(1 + inflationPct / 100, taxYear - latest);
  return dollarsToCents(base * factor);
}

// Year-end (December) factor, the anchor of the display deflator and the MC year-end `cumCpi`, so the
// configured real gift round-trips on every today's-dollars surface.
function yearEndInflationFactor(ctx: PipelineContext, taxYear: number): number {
  if (ctx.projCtx.inflationPct === 0) return 1;
  return inflationFactorAt(ctx.projCtx, taxYear, 11);
}

// The real annual QCD amount is inflated per tax year by the year-end factor; the 70½ first-eligible year
// comes from each owner's birthdate.
function buildQcdContext(ctx: PipelineContext): QcdContextInput | undefined {
  const entries = ctx.resolvedQcd.entries;
  if (entries.length === 0) return undefined;
  const inflationPct = ctx.projCtx.inflationPct;
  // An owner with a missing or malformed birthdate is omitted, so the engine skips them.
  const firstEligibleYearByOwner = new Map<string, number>();
  const addOwner = (id: string, birthdate: string | undefined): void => {
    if (!birthdate || firstEligibleYearByOwner.has(id)) return;
    try {
      firstEligibleYearByOwner.set(id, qcdFirstEligibleTaxYear(birthdate));
    } catch {
    }
  };
  addOwner(ctx.primary.id, ctx.primary.payload.birthdate);
  if (ctx.secondary) addOwner(ctx.secondary.id, ctx.secondary.payload.birthdate);
  return {
    entries: entries.map((e) => ({
      memberId: e.memberId,
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: e.annualAmountDollars,
      startYear: e.startYear,
      endYear: e.endYear,
    })),
    firstEligibleYearByOwner,
    inflationFactorForYear: (taxYear: number) => yearEndInflationFactor(ctx, taxYear),
    qcdLimitCentsForYear: (taxYear: number) =>
      resolveQcdLimitCentsForYear(taxYear, inflationPct),
  };
}
