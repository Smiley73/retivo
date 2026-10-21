/**
 * Per-method deterministic drawdown executor for the BPP-equivalent
 * runner. Owns the shared engine path consumed by both
 * `runBalanceProjection` (one method per call) and the page's
 * `runBalanceProjectionForPage` (both methods, one agnostic phase): the
 * per-account ledger build, bucket-allocation override, CBP-deposit
 * subtraction, the strategy/allocation mutual-exclusion gate, the RMD
 * context builder, and the MAGI-cap-off-year resolution. Extracted from
 * `balance-projection-runner.ts` so the public-API file stays under the
 * 400-ln shape cap; the runner file keeps the entry points + result
 * assembly (`computeFullResult`).
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
 * Per-method deterministic drawdown. The `series` (agnostic) is built
 * once by the caller and threaded in so the page's twice-per-scenario
 * call does not rebuild it. Returns the RAW drawdown output + the
 * at-horizon value + the per-method `accountYears`, or `null` when the
 * method produces no drawdown (zero portfolio / no ledger).
 *
 * Throws `MissingCustomDrawdownOrderError` (child scenario inheriting
 * `customOrder` without the layout) — `runBalanceProjection` re-throws
 * (fail-fast); the page entry catches per-method. A MAGI-cap WINDOW with an
 * unresolvable anchor (gating member's birthdate missing) does not throw: it
 * is flagged inactive and surfaced as a per-window broken-anchor notice while
 * the rest of the ladder + the run still execute.
 */
export function runDrawdownForMethod(
  _args: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  series: CashflowSeries,
  method: ProjectionMethod,
): PageDrawdownMethodResult | null {
  // `methodCtx` (the `{ ...ctx, method }` spread) is threaded only to the
  // method-sensitive helpers below (computePortfolioAtRetirement /
  // buildPerAccountDrawdownLedger / buildAccountYearsMap, which read
  // `outputs[method]`); executeDrawdown intentionally consumes the agnostic
  // `ctx` (its inputs — cashflow series, allocation, strategy — don't vary
  // by projection method).
  const methodCtx: PipelineContext = ctx.method === method ? ctx : { ...ctx, method };
  const portfolioAtRetirement = computePortfolioAtRetirement(methodCtx);
  const ledger = buildPerAccountDrawdownLedger({
    ctx: methodCtx,
    method,
    expensesByMonth: series.expensesByMonth,
    // Route post-primary spouse contributions per-account (carrying their
    // pre/post split) instead of the household pool.
    postPrimaryEvents: series.postPrimaryContributionEvents,
    // Route post-retirement plain-pension lump-sums per-account.
    plainPensionEvents: series.plainPensionPlacementEvents,
  });
  const perAccountLedger = ledger.accounts;
  const accountYears = buildAccountYearsMap(methodCtx);
  // Allocation routes through the per-account ledger (each non-CBP account
  // carries a blended-glide `returnPctByMonth`; a household pool is synthesized
  // when no account does), so an allocation scenario always has a ledger.
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
    // Additive: the net figure was already
    // computed above to seed the drawdown and gate the null-return below;
    // surface it rather than discard it.
    netPortfolioAtRetirement: portfolioAtRetirement,
  };
}

interface DrawdownExecOpts {
  readonly ctx: PipelineContext;
  readonly series: CashflowSeries;
  readonly portfolioAtRetirement: number;
  readonly perAccountLedger: ReadonlyArray<DrawdownAccountInput>;
  /** The scenario's `retirementAllocation` override. When set, the
   *  ledger already carries the blended-glide `returnPctByMonth`; the runner
   *  uses this only for the growth/income Gains tooltip post-pass (the
   *  engine stays allocation-agnostic). */
  readonly allocation: RetirementAllocationOverride | undefined;
  readonly cbpLumpSumDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>;
  /** Plain-pension lump-sum dollars placed per-account — subtracted from
   *  the household-aggregate deposits (only those the ledger actually placed). */
  readonly plainPensionDeposits: ReadonlyArray<{ year: number; month0: number; amount: number }>;
  /** Per-calendar-year rolled-CBP RMD income (dollars) injected into both
   *  the spendable income series + the ordinary-income tax inlets. */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
}

/** Run the engine for one method + apply the tax-integration annotation
 *  post-pass. The engine itself FUNDS the tax cashflow via the
 *  `taxCashflow` hook (built in `buildDrawdownEngineInput`) for every named
 *  strategy. The post-pass here only annotates the 15 display fields; it never
 *  alters balances, so it does not double-apply the cost the engine already
 *  funded.
 *
 *  The post-pass classifies the COMMITTED per-account split by its real tax
 *  treatment from the engine's `accountBalances` map. The bucket-allocation
 *  single-pool path (no `accountBalances` map) falls back to all-pre-tax inside
 *  `splitWithdrawalsByTaxTreatment`. */
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
    // The rollover-year RMD carved from a linked-CBP lump-sum is taxable
    // ordinary income for the year — taxed once via this canonical inlet.
    opts.rolledRmdIncomeByYear,
    // Whether the plan models ANY medical spending, so the post-pass
    // can raise the missing-base-Medicare-premium readiness flag on an IRMAA
    // year. The FULL `isMedical` inventory — Medicare/Medigap/drug-plan
    // premiums are not HSA-qualified, so the HSA-filtered demand series would
    // wrongly report "no medical spending at all" for a household that has it.
    series.anyMedicalSpendingModeled,
  );
  // Derive the growth/income Gains tooltip split as an ALLOCATION-weighted
  // estimated return attribution (the engine itself stays allocation-agnostic —
  // it only sees blended `returnPctByMonth`). Runs only under an allocation
  // override; absent otherwise so non-allocation rows carry no bucket fields.
  if (allocation) {
    deriveAllocationGainTooltip(drawdown.years, perAccountLedger, allocation, ctx.primaryRetirementYear);
  }
  return drawdown;
}

/**
 * Growth/income Gains tooltip derivation (runner post-pass). For each year:
 *   - `growthBucket.gain = nonCbpGain × growthShare(y)` — the glide-eligible
 *     gain attributed to growth by the year's target growth share;
 *   - `incomeBucket.gain = year.growth − growthBucket.gain` (single residual,
 *     never a second independent multiply) so the parts sum EXACTLY to the
 *     year's total gain; CBP gain (glide-excluded) folds into income by the
 *     residual;
 *   - `growthPct = targetGrowthShareForStep` (the share itself, as a percent).
 *
 * This is an ESTIMATED return attribution, NOT a realized per-bucket placement
 * (there is no two-bucket simulation). `nonCbpGain` is the total gain minus the
 * CBP accounts' gain; with the drawdown engine emitting only an aggregate
 * `year.growth`, the non-CBP gain is approximated as the share of total gain
 * proportional to the non-CBP balance fraction at year start. With the common
 * all-non-CBP ledger that fraction is 1, so `nonCbpGain == year.growth`.
 */
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
    // Non-CBP gain: total gain less the CBP accounts' gain. The per-account
    // `accountBalances` map carries no per-account gain, so estimate the CBP
    // gain by the CBP balance fraction at year end (a glide-excluded fold-to-
    // income convention; exact when there is no CBP account — the common case).
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

/** Assemble the `simulateDrawdown` input: subtract per-account CBP
 *  lump-sums from the household-aggregate deposits, build the RMD context,
 *  and resolve the MAGI-cap WINDOW SCHEDULE
 *  (per-window `[startYear, endYear)` + runtime config,
 *  broken anchors flagged inactive, never throws).
 *
 *  Asset allocation routes through the per-account path (each non-CBP ledger
 *  account carries the blended-glide `returnPctByMonth`), so every withdrawal
 *  strategy is compatible with an allocation override. */
function buildDrawdownEngineInput(opts: DrawdownExecOpts): DrawdownInput {
  const { ctx, series, portfolioAtRetirement, perAccountLedger } = opts;
  // The same CBP lump-sum dollars are in both the per-account
  // `depositsByMonth` and the household-aggregate series — clone + subtract so
  // the kernel doesn't double-apply.
  // Subtract BOTH the per-account CBP lump-sums AND the per-account
  // plain-pension placements from the household-aggregate deposits — both are
  // applied per-account in the ledger; the household pool still carries the same
  // dollars (clamp-subtract avoids negative deposits, and not-in-ledger
  // placements are absent from `plainPensionDeposits` so they stay in the
  // spread). Allocation uses the same per-account ledger, so there is
  // no single-pool merge branch.
  const kernelDepositsByMonth = subtractCbpLumpSumsFromHouseholdDeposits(
    series.depositsByMonth,
    [...opts.cbpLumpSumDeposits, ...opts.plainPensionDeposits],
  );
  const strategy = ctx.resolvedScenario.withdrawalStrategy ?? { kind: 'taxEfficient' };
  // The rollover-year RMD cash is spendable household income for the year
  // it is distributed (mirrors the MC `otherIncome` semantics so the two
  // engines agree to the cent). Add it to the spendable income series at the
  // event year (it is taxed once, separately, via the ordinary-income inlet).
  const incomeByMonth = addRolledRmdToIncomeSeries(
    series.incomeByMonth,
    opts.rolledRmdIncomeByYear,
  );
  // Build the per-account RMD floor context when the ledger has accounts.
  const rmdContext: RmdContextInput | undefined =
    perAccountLedger.length > 0
      ? buildRmdContext(ctx, perAccountLedger, ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE)
      : undefined;
  // QCD: build the per-owner forced-outflow context from the resolved
  // directives + the indexed per-person limit + the scenario inflation. Only
  // when there is at least one resolved entry AND a ledger to draw from. Empty →
  // undefined → the engine pass is a no-op.
  const qcdContext =
    perAccountLedger.length > 0 ? buildQcdContext(ctx) : undefined;
  const rawMagiCap = ctx.resolvedScenario.magiCap;
  // Coerce the explicit-disable sentinel ({ disabled: true }) to "no cap" so
  // the engine + helpers never see it (single choke point).
  const magiCap = isMagiCapDisabled(rawMagiCap) ? undefined : rawMagiCap;
  // Resolve every window to its half-open `[startYear,
  // endYear)` span + per-window runtime config, sorted by the total order with
  // broken-anchor windows flagged. Empty / no cap → undefined.
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
    // HSA-qualified medical demand (integer cents) drives the engine's
    // medical-first HSA pass. Strict subset of `expensesByMonth`.
    medicalDemandByMonth: series.medicalDemandByMonth,
  };
}

/** Build the engine's tax-cashflow hook — funds federal tax + IRMAA cash −
 *  ACA PTC into the year's withdrawal target. Named per-account strategies use
 *  per-account routing. Allocation routes through the same per-account ledger,
 *  so it funds tax exactly like the non-allocation path. */
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
    // Same rollover-year RMD ordinary income the post-pass taxes — fund
    // its incremental tax in the same year (canonical inlet).
    rolledRmdIncomeByYear,
    // Every `isMedical` row, not the HSA-qualified subset: caps the ACA credit
    // that lowers the draw because the premium is entered as a Medical expense.
    medicalExpenseByMonthCents: series.medicalExpenseByMonth,
  });
}

/** Add the per-calendar-year rolled-CBP RMD cash (dollars) to a copy of
 *  the spendable income series, SPREAD evenly across the 12 months of the event
 *  year (`dollars / 12` per month). The even spread matches the MC kernel's
 *  `flatNominal = incomeByYear / 12` treatment so the two engines consume the
 *  cash with identical intra-year timing (a single-month spike would lose the
 *  surplus on a month where income exceeds that month's expense, diverging from
 *  MC — cross-engine cent-parity). Returns the input unchanged when there
 *  is no rolled-RMD income. */
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

/** Sum the per-account at-retirement balances minus annuity-elected CBP
 *  and pre-retirement lumpSum-elected CBP (their dollars flow as income /
 *  pre-retirement deposits, not portfolio). */
export function computePortfolioAtRetirement(ctx: PipelineContext): number {
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

/**
 * Build a `ScheduleResolveContext` for resolving cap-window anchors from the
 * pipeline context — retirement (year, month0) + the two members' birthdates.
 * `owner` is left undefined: cap windows always carry an explicit `age.memberId`
 * (the migration seeds it; the UI writes it), so no owner-default is needed.
 */
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

/**
 * Resolve one cap window's static anchors to a half-open `[startYear, endYear)`
 * year interval. Reuses `resolveStartMonth` /
 * `resolveEndMonth` (no parallel resolver) then collapses the month-precise
 * boundaries to whole tax years: the window is active in calendar year Y iff
 * `startYear ≤ Y < endYear`. With the static anchor subset `endYear` is
 * the resolved exclusive end-month's year (e.g. `end{kind:'age',years:N}` →
 * the year the member turns N), reproducing
 * `calendarYear < birthYear + endAge`. Returns `null` when EITHER anchor is
 * unresolvable (broken birthdate) — the caller marks the window broken.
 */
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
 * Resolve a MAGI-cap window SCHEDULE into the engine's runtime window list.
 * Per window:
 *   - resolve `[startYear, endYear)` via `resolveWindowYears`;
 *   - a broken anchor (member birthdate missing) → keep the window but flag it
 *     `brokenAnchor` (inactive every year; the rest of the ladder + the run
 *     still execute). The broken window's bounds collapse to an empty
 *     interval so it never selects even if the flag were ignored;
 *   - a non-positive resolved interval (`endYear ≤ startYear`) → dropped;
 *   - build the per-window runtime config via `buildMagiCapConfig` (once).
 * The resolved list is sorted by the total order `(startYear, endYear,
 * originalIndex)` so `selectActiveMagiCapWindow` is deterministic and picks the
 * earliest-start window on any residual resolved overlap. The PII-never-
 * echoed rule holds: this resolver logs nothing and the broken flag carries
 * only the window index, never a birthdate.
 *
 * Returns `undefined` when the schedule is empty or produces no usable window
 * (≡ no cap).
 */
export function resolveMagiCapWindows(
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
      // Broken anchor — flag inactive, keep running. Empty `[i, i)` bounds
      // guarantee it never selects (config still built for shape consistency).
      resolved.push({
        startYear: 0,
        endYear: 0,
        originalIndex: i,
        brokenAnchor: true,
        config: buildMagiCapConfig(w, 0),
      });
      continue;
    }
    // Reject a non-positive resolved interval (zero-/negative-length).
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

/** Total order `(startYear, endYear, originalIndex)` for deterministic,
 *  parity-safe window selection independent of UI validation. Exported so
 *  the MC engine sorts its rebuilt window list with the SAME comparator. */
export function compareMagiCapWindows(
  a: MagiCapWindowRuntime,
  b: MagiCapWindowRuntime,
): number {
  if (a.startYear !== b.startYear) return a.startYear - b.startYear;
  if (a.endYear !== b.endYear) return a.endYear - b.endYear;
  return a.originalIndex - b.originalIndex;
}

/**
 * Resolve a MAGI-cap schedule to the SERIALIZABLE per-window bounds the MC
 * boundary carries. Index-aligned to
 * `magiCap.windows` — `[i]` is window `i`'s resolved `{startYear, endYear}` +
 * `brokenAnchor` flag (no closures, so it survives `postMessage`). The MC
 * engine rebuilds each window's runtime config from `magiCap.windows[i]` +
 * `bounds[i]` and applies the SAME sort + selection as the deterministic
 * engine. A broken / non-positive window keeps an empty `[0,0)` interval so it
 * never selects. Returns `undefined` for an empty schedule.
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
 * Build the `RmdContextInput` the engine threads into its
 * per-year per-owner per-account RMD floor calculation. Just metadata +
 * the calibration snapshot — no balances precomputed here. The engine
 * reads the current per-account pre/post sub-buckets at each year-start
 * so the floor reflects the actual prior-year-end balance, not the
 * retirement-start balance.
 *
 * Also carries the household's per-account RMD profile facts and per-owner
 * separation years, so the forced withdrawal resolves the SAME per-account rule
 * (inherited beneficiary schedule, still-working deferral, table selection) that
 * the tax floor and the report disclosures resolve. A fact-free household leaves
 * both fields absent and keeps the default Uniform-Lifetime behaviour verbatim.
 */
export function buildRmdContext(
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

  // `deathYear = birthYear + lifeExpectancyAge`. Death is modelled as
  // Dec 31 of `deathYear`: the owner is alive through all of `deathYear`,
  // so the RMD gate applies the floor in `deathYear` and stops after
  // (see drawdown-engine-per-account-strategy-helpers), and the
  // drawdown horizon (`computeHorizonYear` = `deathYear`) ends there.
  //
  // Resolved through the shared
  // `resolveHouseholdDeathYears`, the SAME derivation the Monte Carlo mirror of
  // this context (`buildStrategyRmdContext`) reads off `McTaxContext`. An
  // unusable birthdate yields no death year on both engines, which they both
  // carry as `Infinity` (alive every year) rather than a bare-`parseInt`
  // `NaN`.
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
 * Resolve the indexed per-person §408(d)(8) QCD exclusion limit (integer cents)
 * for `taxYear` from the calibration snapshot. The limit is annually
 * INDEXED — unlike the non-indexed RMD divisor table — so years beyond the
 * latest published key are INFLATION-EXTRAPOLATED forward by the scenario
 * inflation rate (NOT clamped to latest, which would understate it). Years at or
 * before the earliest published key clamp to that earliest figure.
 *
 * Exported for unit coverage of all three branches.
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
    // A published year (or an interior gap year — clamp DOWN to the most-recent
    // published key ≤ taxYear, the published value is authoritative).
    let key = earliest;
    for (const y of years) {
      if (y <= taxYear) key = y;
    }
    return dollarsToCents(QCD_LIMITS.values[key].annualLimitDollars);
  }
  // Beyond the latest published key: inflation-extrapolate forward.
  const base = QCD_LIMITS.values[latest].annualLimitDollars;
  const factor = Math.pow(1 + inflationPct / 100, taxYear - latest);
  return dollarsToCents(base * factor);
}

/** Year-END (December) inflation factor for `taxYear` — the SAME December
 *  anchor the page's display deflator (`viewDeflator(y, 11)`) and the MC path's
 *  year-end `cumCpi` use. The QCD previously inflated on a year-MEAN factor
 *  (the expense convention), which left a constant ≈(1+i)^(−5.5/12) gap (~1.34%
 *  at 3%) between the gift and every year-end-anchored surface it meets — the
 *  RMD-offset split bar showed a $10,000 gift as ~$9,866. Year-end matches the
 *  caps the gift is compared against (the prior-year-END source balance and the
 *  whole-year-extrapolated §408(d)(8) limit) and makes the deterministic and MC
 *  engines share one anchor, so every today's-dollars QCD surface round-trips
 *  to the configured amount exactly. */
function yearEndInflationFactor(ctx: PipelineContext, taxYear: number): number {
  if (ctx.projCtx.inflationPct === 0) return 1;
  return inflationFactorAt(ctx.projCtx, taxYear, 11);
}

/**
 * Build the engine's per-owner `QcdContextInput` from the resolved QCD
 * directives, the indexed per-person limit (inflation-extrapolated forward), and
 * the scenario inflation. Returns `undefined` when no QCD resolved so the engine
 * pass is a no-op. The REAL annual amount is inflated to nominal per tax year via
 * the year-END (December) inflation factor — the same anchor as the display
 * deflator, the MC path CPI, and the caps the gift is compared against (see
 * `yearEndInflationFactor`); the 70½ first-eligible year is derived per owner
 * from the household member birthdates.
 */
function buildQcdContext(ctx: PipelineContext): QcdContextInput | undefined {
  const entries = ctx.resolvedQcd.entries;
  if (entries.length === 0) return undefined;
  const inflationPct = ctx.projCtx.inflationPct;
  // Per-owner 70½ first-eligible tax year from the member birthdate. An owner
  // with a missing / malformed birthdate is omitted → the engine skips them.
  const firstEligibleYearByOwner = new Map<string, number>();
  const addOwner = (id: string, birthdate: string | undefined): void => {
    if (!birthdate || firstEligibleYearByOwner.has(id)) return;
    try {
      firstEligibleYearByOwner.set(id, qcdFirstEligibleTaxYear(birthdate));
    } catch {
      // Malformed birthdate — leave the owner out (the entry resolver already
      // dropped any entry whose owner had an unparseable birthdate, so this is
      // defense-in-depth only).
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
    // Year-END (December) factor — one anchor shared with the display deflator
    // and the MC path CPI, so the configured REAL gift round-trips on every
    // today's-dollars surface (see `yearEndInflationFactor`).
    inflationFactorForYear: (taxYear: number) => yearEndInflationFactor(ctx, taxYear),
    qcdLimitCentsForYear: (taxYear: number) =>
      resolveQcdLimitCentsForYear(taxYear, inflationPct),
  };
}
