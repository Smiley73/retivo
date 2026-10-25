/**
 * Strategy-aware year-by-year drawdown loop used by `simulatePerAccountMonthly`: RMD floor, QCD, tax-cashflow
 * solve, MAGI cap and Fill conversion.
 * See `docs/math-withdrawals.md` ("How a year runs").
 */
import { monthlyEquivalent } from './projection-engine/monthly-conversion';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type {
  DrawdownAccountInput,
  DrawdownAccountYear,
  DrawdownYear,
  DrawdownInput,
  QcdContextInput,
  RmdContextInput,
} from './drawdown-engine-types';
import {
  buildStrategyTiers,
  distributeWithdrawalByStrategy,
  hsaStateIndices,
  isPostTaxNonRoth,
  isRmdOverflowCashAccountId,
  selectActiveMagiCapWindow,
  RMD_OVERFLOW_CASH_ACCOUNT_ID,
  type AccountRunState,
  type MagiCapRuntimeConfig,
  type MagiCapWindowRuntime,
  type RmdFloorPrePassResult,
  type RmdSurplusDispositionResult,
  type StrategyAwareKind,
} from './drawdown-engine-per-account-strategy-helpers';
import {
  applyQcdPrePass,
  applyRmdFloorPrePass,
  buildPerOwnerRmdFloor,
  consumeOverflowCashFirst,
  disposeRmdSurplus,
  drawFloorReserve,
  drawHsaEmergency,
  drawHsaMedical,
  type QcdPrePassResult,
} from './drawdown-engine-per-account-qcd-hsa';
import type {
  TaxCashflowHook,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import {
  classifyTrialYearDraw,
  distributeWithdrawalByCustomTiersWithCap,
  sumYearWindow,
  applyMonthlyDeposits,
  applyMonthlyGrowth,
  type TrialWithinYearInputs,
} from './drawdown-engine-per-account-strategy-cap';
import { applyRothConversionFill } from './drawdown-engine-roth-conversion';
import {
  fundedRatio,
  applyGuardrailStep,
  initGuardrailState,
  type GuardrailConfig,
  type GuardrailPathState,
} from './guardrails';

/**
 * Per-path downturn-guardrail runtime context, present only on a Monte Carlo named-strategy path with an
 * enabled config.
 * At each year start the engine steps the settled spend factor from the funded ratio and scales that year's
 * 12 `expense` months in place; the caller runs it on tax pass 1 only, so pass 2 reuses the scaled array.
 * Real series are today's dollars, indexed from the first drawdown year.
 */
export interface GuardrailRuntimeContext {
  readonly config: GuardrailConfig;
  /** Real total spending on the 100% baseline path, per drawdown year. */
  readonly baselineTotalRealByYear: readonly number[];
  /** Real net spending need (total less guaranteed income) on the baseline path, per drawdown year. */
  readonly baselineNetNeedRealByYear: readonly number[];
  /** Real essential-only spending on the baseline path, per drawdown year: the per-year cut floor. */
  readonly essentialRealByYear: readonly number[];
  /**
   * Cumulative CPI factor at the start of each drawdown year (this path's sampled CPI); deflates the nominal
   * year-start pool to today's dollars.
   */
  readonly cumCpiAtYearStart: readonly number[];
  /** Effective-tax gross-up fraction for the funded-ratio liability. */
  readonly effectiveTaxRate: number;
  /**
   * Mutable per-year output: the settled spend factor applied to each year, filled on the pass that evaluates
   * it.
   */
  readonly appliedFactorByYear: number[];
}

function stampTaxCashflowRow(row: DrawdownYear, outcome: TaxCashflowYearOutcome): void {
  row.federalTaxCashNeedCents = outcome.federalTaxCashNeedCents;
  row.irmaaWithheldFromSsCents = outcome.irmaaWithheldFromSsCents;
  row.irmaaCashNeedCents = outcome.irmaaCashNeedCents;
  row.acaPtcCashflowOffsetCents = outcome.acaPtcCashflowOffsetCents;
  row.acaCreditAppliedToPremiumsCents = outcome.acaCreditAppliedToPremiumsCents;
  row.totalTaxCashflowNeedCents = outcome.totalTaxCashflowNeedCents;
  row.taxCashflowIterations = outcome.taxCashflowIterations;
  row.taxCashflowConverged = outcome.taxCashflowConverged;
  row.taxCashflowShortfallCents = outcome.taxCashflowShortfallCents;
}

export type {  MagiCapRuntimeConfig,   } from './drawdown-engine-per-account-strategy-helpers';

function readSeriesIntoBuffer(series: MonthlyCashflowSeries, stepCount: number): Float64Array {
  // An exact-length `Float64Array` is returned as is: downstream only reads `deposits` and `depositsPost`,
  // and the MC per-path buffers are private. Anything shorter or untyped zero-pads via the copy below.
  if (series.values instanceof Float64Array && series.values.length === stepCount) {
    return series.values;
  }
  const out = new Float64Array(stepCount);
  for (let i = 0; i < stepCount; i += 1) {
    if (i < series.values.length) out[i] = series.values[i];
  }
  return out;
}

export interface RunYearByYearArgs {
  readonly input: DrawdownInput;
  readonly yearCount: number;
  readonly accountsIn: ReadonlyArray<DrawdownAccountInput>;
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly householdDeposit: Float64Array;
  /** Strategy kind; `proportional` is one balance-proportional tier, the others use tax-class priority. */
  readonly strategyKind: StrategyAwareKind;
  /** Per-account RMD context; when undefined the engine skips RMD enforcement. */
  readonly rmdContext?: RmdContextInput;
  /**
   * Per-owner QCD context; when supplied, the 70½-gated forced-outflow pass runs each year before the RMD
   * floor pre-pass.
   */
  readonly qcdContext?: QcdContextInput;
  /**
   * Pre-built custom-order tier arrays (state indices); required for `customOrder`, tier 0 drained first.
   */
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  /** Excluded account state indices for the custom-order path. */
  readonly excludedIndices?: ReadonlySet<number>;
  /**
   * MAGI-cap window schedule; the engine selects at most one active window per year
   * (`selectActiveMagiCapWindow`) and a gap year is cap-off. Applies to preset and custom-order strategies.
   */
  readonly magiCapWindows?: ReadonlyArray<MagiCapWindowRuntime>;
  /**
   * Per-year tax-cashflow hook; when supplied, each year's net withdrawal target is raised by the solver's
   * tax cashflow need.
   */
  readonly taxCashflow?: TaxCashflowHook;
  /**
   * Downturn-guardrail runtime context; when supplied and enabled, scales each year's `expense` months in
   * place at the year-start boundary. Supplied on tax pass 1, which evaluates the factor.
   */
  readonly guardrail?: GuardrailRuntimeContext;
}

interface YearStepArgs {
  readonly y: number;
  readonly state: AccountRunState[];
  readonly yearCount: number;
  readonly expense: Float64Array;
  readonly income: Float64Array;
  readonly householdDeposit: Float64Array;
  readonly strategyKind: StrategyAwareKind;
  /** Per-account RMD floor in dollars, index-aligned with `state`; zero entries skip the forced draw. */
  readonly rmdFloorByAccountDollars: number[];
  readonly perMonthWithdrawal: Float64Array;
  readonly retirementYear: number;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** The active window's runtime config for this year; `undefined` in a gap year or without a schedule. */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly taxCashflow?: TaxCashflowHook;
  /**
   * State indices of the HSA accounts, drawn by the medical and emergency passes only (`buildStrategyTiers`
   * holds them out of the ordinary tiers).
   */
  readonly hsaIndices: ReadonlyArray<number>;
  /**
   * Per-month HSA-qualified medical demand in dollars, aligned to the run step domain; empty or absent means
   * 0 and the medical pass does nothing.
   */
  readonly medicalDemand: Float64Array;
  /**
   * QCD pre-pass outcome for the year, carried only to stamp `qcdCents` and `netTaxableRmdCents` on the row.
   */
  readonly qcdResult?: QcdPrePassResult;
  /**
   * Tiers built once per `runYearByYearStrategyAware` call (never for `customOrder`); consumers build their
   * own when absent.
   */
  readonly prebuiltTiers?: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Year-by-year per-account drawdown honoring the withdrawal-order strategy and, with `rmdContext`, the
 * per-owner RMD floor. Each year: RMD floor, forced-draw pre-pass (surplus credits the first POST_TAX
 * non-Roth account), then monthly deposits, growth and strategy-ordered withdrawal, and year-end balances.
 */
export function runYearByYearStrategyAware(args: RunYearByYearArgs): {
  years: DrawdownYear[];
  depletionYear: number | null;
  perMonthWithdrawal: Float64Array;
} {
  const { input, yearCount, accountsIn, expense, income, householdDeposit, strategyKind,
    customTiers, excludedIndices, magiCapWindows, taxCashflow, qcdContext } = args;
  const stepCount = yearCount * 12;

  const state: AccountRunState[] = accountsIn.map((a) => ({
    id: a.id,
    pre: a.initialPre,
    post: a.initialPost,
    annualRatePct: a.annualRatePct,
    monthlyRate: monthlyEquivalent(a.annualRatePct),
    taxTreatment: a.taxTreatment,
    accountType: a.accountType,
    deposits: readSeriesIntoBuffer(a.depositsByMonth, stepCount),
    // The post-primary designated-Roth slice routes to `post` regardless of treatment.
    depositsPost: a.depositsPostByMonth
      ? readSeriesIntoBuffer(a.depositsPostByMonth, stepCount)
      : new Float64Array(stepCount),
    returnPctByMonth: a.returnPctByMonth,
    floorDollars: a.floorDollars,
    floorHsaMode: a.floorHsaMode,
    // The inherited marker comes from `args.rmdContext` (not `input.rmdContext`: the MC path supplies only
    // the former), which both engines carry, so no new serialized MC input field is needed.
    inheritedAccount:
      args.rmdContext?.rmdFactsByAccountId?.[a.id]?.inheritedAccount === true,
  }));

  // With no real POST_TAX non-Roth account to take RMD surplus, pre-append a zero-balance cash-like carrier
  // at run start, last, so state indices and custom tiers stay aligned and surplus stays in `totalBalance`.
  const hasRealPostTaxNonRoth = state.some(
    (st) => isPostTaxNonRoth(st) && !isRmdOverflowCashAccountId(st.id),
  );
  if (args.rmdContext && !hasRealPostTaxNonRoth) {
    state.push({
      id: RMD_OVERFLOW_CASH_ACCOUNT_ID,
      pre: 0,
      post: 0,
      annualRatePct: 0,
      monthlyRate: 0,
      taxTreatment: 'POST_TAX',
      accountType: 'SAVINGS',
      deposits: new Float64Array(stepCount),
      depositsPost: new Float64Array(stepCount),
    });
  }

  // For `customOrder` an HSA is drawn only if the user placed it in a tier, so excluded HSAs stay out of the
  // medical and emergency passes; built-in strategies pass no `excludedIndices`, so the filter is a no-op for
  // them.
  const hsaIndices =
    strategyKind === 'customOrder' && excludedIndices !== undefined
      ? hsaStateIndices(state).filter((a) => !excludedIndices.has(a))
      : hsaStateIndices(state);
  // Tier membership depends only on account type, so build once here after the carrier is pushed; never for
  // `customOrder`, since `buildStrategyTiers` throws on it.
  const prebuiltTiers =
    strategyKind === 'customOrder' ? undefined : buildStrategyTiers(state, strategyKind);
  const medicalDemand = new Float64Array(stepCount);
  const demandCents = input.medicalDemandByMonth;
  if (demandCents) {
    for (let i = 0; i < stepCount && i < demandCents.length; i += 1) {
      medicalDemand[i] = (demandCents[i] ?? 0) / 100;
    }
  }

  const perMonthWithdrawal = new Float64Array(stepCount);
  const years: DrawdownYear[] = [];
  let depletionYear: number | null = null;

  // Previous iteration's year-start sub-buckets (Dec 31 of `taxYear - 2`): the base of a first-year-deferral
  // catch-up, tracked only when RMD facts are recorded.
  const tracksRmdFacts = args.rmdContext?.rmdFactsByAccountId !== undefined;
  let twoYearsPriorDollars: { pre: number; post: number }[] | undefined;

  // Guardrail state resets at path entry and never leaks across paths.
  const guardrail = args.guardrail;
  const guardrailActive = guardrail !== undefined && guardrail.config.enabled === true;
  const guardrailState: GuardrailPathState | undefined = guardrailActive
    ? initGuardrailState()
    : undefined;

  for (let y = 0; y < yearCount; y += 1) {
    const calendarYear = input.retirementYear + y;
    // Scaling the nominal `expense` months in place flows the adjusted spending through the RMD/tax solve and
    // the monthly withdrawal, so both tax passes tax the adjusted withdrawals.
    if (guardrailActive && guardrail !== undefined && guardrailState !== undefined) {
      const factor = evaluateGuardrailForYear({
        y,
        state,
        guardrail,
        guardrailState,
      });
      guardrail.appliedFactorByYear[y] = factor;
      if (factor !== 1) {
        const base = y * 12;
        for (let m = 0; m < 12; m += 1) expense[base + m] *= factor;
      }
    }
    // The catch-up base is withheld for the first two drawdown years: the deterministic tax floor has no
    // `priorPriorYear` then, and supplying the at-retirement balance would make the forced draw exceed the
    // floor it is measured against.
    const yearStartDollars = tracksRmdFacts
      ? state.map((st) => ({ pre: st.pre, post: st.post }))
      : undefined;
    const catchUpBase = y > 1 ? twoYearsPriorDollars : undefined;
    const rmdFloorByAccountDollars = args.rmdContext
      ? buildPerOwnerRmdFloor({
          taxYear: calendarYear,
          state,
          rmdContext: args.rmdContext,
          ...(catchUpBase !== undefined ? { twoYearsPriorDollars: catchUpBase } : {}),
        })
      : new Array<number>(state.length).fill(0);
    twoYearsPriorDollars = yearStartDollars;
    // Runs before the RMD floor pre-pass so the forced taxable RMD is `gross - min(Q, gross)`; the QCD floor
    // is the 70½ age, independent of the RMD trigger age.
    const qcdResult =
      qcdContext && args.rmdContext
        ? applyQcdPrePass({
            state,
            rmdFloorByAccountDollars,
            qcdContext,
            ownerByAccountId: args.rmdContext.ownerByAccountId,
            taxYear: calendarYear,
          })
        : undefined;
    // A gap year or no schedule gives `undefined` (cap off); leaf distributors stay time-unaware.
    const magiCapConfig =
      magiCapWindows !== undefined
        ? selectActiveMagiCapWindow(magiCapWindows, calendarYear)?.config
        : undefined;
    const yr = runOneStrategyYear({
      y,
      state,
      yearCount,
      expense,
      income,
      householdDeposit,
      strategyKind,
      rmdFloorByAccountDollars,
      perMonthWithdrawal,
      retirementYear: input.retirementYear,
      customTiers,
      excludedIndices,
      magiCapConfig,
      taxCashflow,
      hsaIndices,
      medicalDemand,
      qcdResult,
      prebuiltTiers,
    });
    if (yr.depleted && depletionYear === null) depletionYear = yr.year;
    years.push(yr);
  }

  return { years, depletionYear, perMonthWithdrawal };
}

// The funded-ratio denominator uses the settled factor entering the year: net need on the settled path is
// `baselineNetNeedReal + baselineTotalReal * (settled - 1)`, since guaranteed income is unaffected by the
// spending scale.
function evaluateGuardrailForYear(args: {
  readonly y: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly guardrail: GuardrailRuntimeContext;
  readonly guardrailState: GuardrailPathState;
}): number {
  const { y, state, guardrail, guardrailState } = args;
  const priorSettled = guardrailState.settledFactor;

  let poolNominal = 0;
  for (let a = 0; a < state.length; a += 1) poolNominal += state[a].pre + state[a].post;

  const n = guardrail.baselineNetNeedRealByYear.length;
  const remaining = Math.max(0, n - y);
  const netNeedReal = new Array<number>(remaining);
  const cumOnes = new Array<number>(remaining);
  for (let k = 0; k < remaining; k += 1) {
    const idx = y + k;
    const baseNet = guardrail.baselineNetNeedRealByYear[idx] ?? 0;
    const baseTotal = guardrail.baselineTotalRealByYear[idx] ?? 0;
    netNeedReal[k] = baseNet + baseTotal * (priorSettled - 1);
    cumOnes[k] = 1; // series is already REAL (path-CPI-independent)
  }

  const cumCpi = guardrail.cumCpiAtYearStart[y] ?? 1;
  const ratio = fundedRatio({
    portfolioNominal: poolNominal,
    portfolioCumCpi: cumCpi,
    netNeedNominalByYear: netNeedReal,
    cumCpiByYear: cumOnes,
    effectiveTaxRate: guardrail.effectiveTaxRate,
  });

  // A zero-baseline year gets a 0 essential floor; it has no spending to cut.
  const baseTotalThisYear = guardrail.baselineTotalRealByYear[y] ?? 0;
  const essentialThisYear = guardrail.essentialRealByYear[y] ?? 0;
  const essentialFloorFactor =
    baseTotalThisYear > 0 ? essentialThisYear / baseTotalThisYear : 0;

  const stepped = applyGuardrailStep({
    state: guardrailState,
    ratio,
    config: guardrail.config,
    essentialFloorFactor,
  });
  return stepped.factor;
}

// Runs the tax-cashflow solve via the hook (`undefined` without one); the classifier trial-copies state, so
// the RMD-mutated run state is untouched.
function solveYearTaxCashflow(args: {
  readonly taxCashflow: TaxCashflowHook | undefined;
  readonly yearIndex: number;
  readonly ordinaryNetNeed: number;
  readonly state: ReadonlyArray<AccountRunState>;
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  readonly rmdResult: RmdFloorPrePassResult;
  /**
   * Active MAGI-cap config and post-RMD cap budget, so the trial routes tax funding to taxable/Roth before
   * capped pre-tax.
   */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly capRemainingDollars: number | null;
  /**
   * Within-year deposit, income and expense context, so the trial mirrors the committing deposit, growth,
   * withdrawal sequence.
   */
  readonly within: TrialWithinYearInputs;
}): TaxCashflowYearOutcome | undefined {
  const { taxCashflow, yearIndex, ordinaryNetNeed, state, strategyKind,
    customTiers, excludedIndices, rmdResult, magiCapConfig, capRemainingDollars, within } = args;
  if (!taxCashflow) return undefined;
  const classify = (targetDollars: number): TaxCashflowYearClassification =>
    classifyTrialYearDraw({
      state,
      strategyKind,
      customTiers,
      excludedIndices,
      rmdForcedTotal: rmdResult.totalForcedPreTaxWithdrawn,
      totalTargetDollars: targetDollars,
      magiCapConfig,
      capRemainingDollars,
      within,
    });
  return taxCashflow.solveForYear(yearIndex, ordinaryNetNeed, classify);
}

function runOneStrategyYear(args: YearStepArgs): DrawdownYear {
  const { y, state, expense, income, householdDeposit, strategyKind, rmdFloorByAccountDollars,
    perMonthWithdrawal, retirementYear, customTiers, excludedIndices, magiCapConfig, taxCashflow,
    hsaIndices, medicalDemand, qcdResult } = args;
  const calendarYear = retirementYear + y;
  const yearWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearPreWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearPostWithdrawnByAcct = new Array<number>(state.length).fill(0);
  const yearDepositByAcct = new Array<number>(state.length).fill(0);
  // HSA medical-qualified dollars per account; the emergency residual is `committed - this`, derived at row
  // assembly so both reconcile to the cent.
  const yearMedicalQualifiedByAcct = new Array<number>(state.length).fill(0);
  let yearWithdrawn = 0;
  let yearDeposit = 0;
  let yearGrowth = 0;
  let yearExpense = 0;
  let yearIncome = 0;

  let yearMagiCapBreachDollars = 0;
  let yearMagiCapTierOverrideDollars = 0;
  const capActive = magiCapConfig !== undefined && calendarYear < magiCapConfig.capOffYear;
  let capRemainingDollars = capActive ? magiCapConfig!.capDollars : null;

  // RMD forced draw only: the surplus disposition waits for the tax solve so the tax portion of the forced
  // RMD is funded from the portfolio, not reinvested.
  const yearNetNeed = sumYearWindow(expense, income, y);
  const rmdResult = applyRmdFloorPrePass({
    state,
    rmdFloorByAccountDollars,
  });
  for (let a = 0; a < state.length; a += 1) {
    yearWithdrawnByAcct[a] += rmdResult.preTaxWithdrawn[a];
    yearPreWithdrawnByAcct[a] += rmdResult.preTaxWithdrawn[a];
    yearWithdrawn += rmdResult.preTaxWithdrawn[a];
  }
  // The forced RMD may itself exceed the cap; that overage is an unavoidable breach recorded in
  // `yearMagiCapBreachDollars`.
  if (capRemainingDollars !== null) {
    const rmdPreTax = rmdResult.totalForcedPreTaxWithdrawn;
    if (rmdPreTax > capRemainingDollars) {
      yearMagiCapBreachDollars += rmdPreTax - capRemainingDollars;
    }
    capRemainingDollars = Math.max(0, capRemainingDollars - rmdPreTax);
  }

  // The tax cashflow need is spread across the months proportionally to monthly net need, evenly when there
  // is none.
  const taxOutcome = solveYearTaxCashflow({
    taxCashflow, yearIndex: y, ordinaryNetNeed: yearNetNeed,
    state, strategyKind, customTiers, excludedIndices, rmdResult,
    magiCapConfig, capRemainingDollars,
    within: { yearIndex: y, expense, income, householdDeposit, yearNetNeed, hsaIndices, medicalDemand },
  });
  const taxAddedNeed = taxOutcome?.addedNeedDollars ?? 0;

  // Surplus disposition runs after the tax solve (the retained surplus excludes the tax add-on, which the
  // forced RMD funds in an over-RMD year) and before the monthly loop, so the carrier exists for later-year
  // spend-first. The deposit is a transfer, not income.
  const surplusResult = disposeRmdSurplus({
    state,
    totalForcedPreTaxWithdrawn: rmdResult.totalForcedPreTaxWithdrawn,
    netNeedDollars: yearNetNeed,
    taxAddedNeed,
  });
  for (let a = 0; a < state.length; a += 1) {
    yearDepositByAcct[a] += surplusResult.postTaxNonRothDeposit[a];
    yearDeposit += surplusResult.postTaxNonRothDeposit[a];
  }

  for (let m = 0; m < 12; m += 1) {
    const i = y * 12 + m;
    yearExpense += expense[i];
    yearIncome += income[i];
    const ordinaryMonthlyNeed = Math.max(0, expense[i] - income[i]);
    const taxMonthShare =
      yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 1 / 12;
    const monthlyNetNeed = ordinaryMonthlyNeed + taxAddedNeed * taxMonthShare;
    const depositSum = applyMonthlyDeposits({
      state,
      stepIdx: i,
      householdDepositAmount: householdDeposit[i] ?? 0,
      yearDepositByAcct,
    });
    yearDeposit += depositSum;
    // The step index lets an MC path grow on its per-month sampled returns.
    yearGrowth += applyMonthlyGrowth(state, i);
    // The RMD credit is spread by the ordinary monthly need: RMD funds ordinary spending, not the tax add-on.
    const monthShareOfYearNeed = yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 0;
    const monthRmdCredit = rmdResult.totalForcedPreTaxWithdrawn * monthShareOfYearNeed;
    const monthTargetGross = Math.max(0, monthlyNetNeed - monthRmdCredit);

    const cashSpent = consumeOverflowCashFirst({
      state,
      target: monthTargetGross,
      yearWithdrawnByAcct,
      yearPostWithdrawnByAcct,
    });
    const afterCashTarget = monthTargetGross - cashSpent;

    // HSA pass A: fund modeled medical demand tax-free, up to min(remaining need, medical demand, HSA
    // balance), only when a positive portfolio need exists.
    const medicalHsaSpent = drawHsaMedical({
      state,
      hsaIndices,
      target: afterCashTarget,
      demand: medicalDemand[i] ?? 0,
      yearWithdrawnByAcct,
      yearPostWithdrawnByAcct,
      medicalQualifiedByAcct: yearMedicalQualifiedByAcct,
    });
    const monthTarget = afterCashTarget - medicalHsaSpent;

    let monthWithdrawn: number;
    if (strategyKind === 'customOrder' && customTiers !== undefined) {
      monthWithdrawn = distributeWithdrawalByCustomTiersWithCap({
        state,
        tiers: customTiers,
        excludedIndices: excludedIndices ?? new Set(),
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        capRemainingDollars,
        magiCapConfig,
        onCapBreachDollars: (d) => { yearMagiCapBreachDollars += d; },
        onTierOverrideDollars: (d) => { yearMagiCapTierOverrideDollars += d; },
        onPreTaxDrawn: (d) => {
          if (capRemainingDollars !== null) capRemainingDollars = Math.max(0, capRemainingDollars - d);
        },
        sequentialWithinTier: true,
      });
    } else if (capRemainingDollars !== null && magiCapConfig !== undefined) {
      const presetTiers = args.prebuiltTiers ?? buildStrategyTiers(state, strategyKind);
      monthWithdrawn = distributeWithdrawalByCustomTiersWithCap({
        state,
        tiers: presetTiers,
        excludedIndices: new Set(),
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        capRemainingDollars,
        magiCapConfig,
        onCapBreachDollars: (d) => { yearMagiCapBreachDollars += d; },
        onTierOverrideDollars: (d) => { yearMagiCapTierOverrideDollars += d; },
        onPreTaxDrawn: (d) => {
          if (capRemainingDollars !== null) capRemainingDollars = Math.max(0, capRemainingDollars - d);
        },
      });
    } else {
      monthWithdrawn = distributeWithdrawalByStrategy({
        state,
        strategyKind,
        target: monthTarget,
        yearWithdrawnByAcct,
        yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct,
        tiers: args.prebuiltTiers,
      });
    }
    // HSA pass B: the ordinary router holds HSA out, so a residual means every non-HSA account is exhausted.
    // These dollars are not medical-qualified, so they form the emergency residual the percentage and the 20%
    // additional tax govern.
    const emergencyResidual = monthTarget - monthWithdrawn;
    const emergencyHsaSpent = emergencyResidual > 1e-9
      ? drawHsaEmergency({
          state,
          hsaIndices,
          target: emergencyResidual,
          yearWithdrawnByAcct,
          yearPostWithdrawnByAcct,
        })
      : 0;
    // Last-resort floor-reserve draw, only when need remains after every other path; HSA reserve draws skip
    // the medical accumulator, so the residual rule taxes them as emergency.
    const reserveResidual = emergencyResidual - emergencyHsaSpent;
    const reserveSpent = reserveResidual > 1e-9
      ? drawFloorReserve({
          state,
          tiers: strategyKind === 'customOrder'
            ? (customTiers ?? [])
            : (args.prebuiltTiers ?? buildStrategyTiers(state, strategyKind)),
          hsaIndices,
          excludedIndices: excludedIndices ?? new Set(),
          target: reserveResidual,
          yearWithdrawnByAcct,
          yearPreWithdrawnByAcct,
          yearPostWithdrawnByAcct,
          sequentialWithinTier: strategyKind === 'customOrder',
        })
      : 0;
    // Depletion is measured after this pass via `yearWithdrawn`, so a reserve-funded year keeps
    // `depleted = false`.
    perMonthWithdrawal[i] =
      cashSpent + medicalHsaSpent + monthWithdrawn + emergencyHsaSpent + reserveSpent + monthRmdCredit;
    yearWithdrawn += cashSpent + medicalHsaSpent + monthWithdrawn + emergencyHsaSpent + reserveSpent;
  }

  // Fill-mode conversion runs after the monthly loop, when the residual cap room is known. Its principal move
  // leaves the withdrawal accumulators untouched, so it is outside the §72(t) penalty.
  const conversionResult = applyRothConversionFill({
    state,
    magiCapConfig,
    capActive,
    capRemainingDollars,
    taxCashflow,
    yearIndex: y,
    yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    yearWithdrawnByAcct,
    excludedIndices,
  });
  // Fold the funded portion of the conversion tax into the year's withdrawal so the balance drops by it; the
  // full need drives depletion, so an unfundable conversion tax is a depletion.
  const conversionFundedTax = conversionResult.fundedTaxCents / 100;
  const conversionTaxNeed = conversionResult.taxNeedCents / 100;
  yearWithdrawn += conversionFundedTax;

  const yearNetNeedRow = Math.max(0, yearExpense - yearIncome);
  // Depletion measures the full funded target (spending, tax add-on and conversion tax need): a year that
  // covers spending but not the grossed-up tax bill is still a depletion.
  const depleted = yearWithdrawn + 1e-6 < yearNetNeedRow + taxAddedNeed + conversionTaxNeed;

  const row = assembleStrategyYearRow({
    state,
    calendarYear,
    yearWithdrawn,
    yearNetNeedRow,
    yearGrowth,
    yearDeposit,
    depleted,
    yearWithdrawnByAcct,
    yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct,
    yearDepositByAcct,
    yearMedicalQualifiedByAcct,
    surplusResult,
    yearMagiCapBreachDollars,
    yearMagiCapTierOverrideDollars,
    rothConvertedCents: conversionResult.convertedCents,
    rothConversionDegradedNoTarget: conversionResult.degradedNoTargetRoth,
    taxFundingCentsByAccount: conversionResult.taxFundingCentsByAccount,
  });
  // The strategy path keeps the solver's own shortfall, so it uses the plain row stamper, not the
  // honest-shortfall variant of the single-pool paths.
  if (taxOutcome) stampTaxCashflowRow(row, taxOutcome);
  // Stamp QCD fields only in a year a QCD applied; `netTaxableRmdCents` is the IRA-pool RMD still taxable
  // after the offset.
  if (qcdResult && qcdResult.totalQcdCents > 0) {
    row.qcdCents = qcdResult.totalQcdCents;
    row.netTaxableRmdCents = Math.max(
      0,
      qcdResult.grossIraPoolRmdCents - qcdResult.rmdOffsetCents,
    );
    // The per-owner offset lets the tax post-pass credit the QCD toward the owner's IRA pool (§408(d)(8)), so
    // no phantom shortfall surfaces.
    row.qcdRmdOffsetCentsByOwner = qcdResult.rmdOffsetCentsByOwner;
    // Display only: the factor used to inflate the real gift to nominal, so today's-dollars surfaces divide
    // it out exactly.
    row.qcdInflationFactor = qcdResult.inflationFactor;
  }
  return row;
}

// Builds the per-account balance map and `DrawdownYear` row at year end.
function assembleStrategyYearRow(args: {
  readonly state: AccountRunState[];
  readonly calendarYear: number;
  readonly yearWithdrawn: number;
  readonly yearNetNeedRow: number;
  readonly yearGrowth: number;
  readonly yearDeposit: number;
  readonly depleted: boolean;
  readonly yearWithdrawnByAcct: number[];
  readonly yearPreWithdrawnByAcct: number[];
  readonly yearPostWithdrawnByAcct: number[];
  readonly yearDepositByAcct: number[];
  readonly yearMedicalQualifiedByAcct: number[];
  readonly surplusResult: RmdSurplusDispositionResult;
  readonly yearMagiCapBreachDollars: number;
  readonly yearMagiCapTierOverrideDollars: number;
  readonly rothConvertedCents: number;
  readonly rothConversionDegradedNoTarget: boolean;
  /** Draws that paid the conversion's tax, when the hook records them. */
  readonly taxFundingCentsByAccount?: ReadonlyMap<string, number>;
}): DrawdownYear {
  const { state, calendarYear, yearWithdrawn, yearNetNeedRow, yearGrowth,
    yearDeposit, depleted, yearWithdrawnByAcct, yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct, yearDepositByAcct, yearMedicalQualifiedByAcct, surplusResult,
    yearMagiCapBreachDollars, yearMagiCapTierOverrideDollars, rothConvertedCents,
    rothConversionDegradedNoTarget, taxFundingCentsByAccount } = args;
  const accountBalances = new Map<string, DrawdownAccountYear>();
  let totalBalance = 0;
  for (let a = 0; a < state.length; a += 1) {
    const preEnd = state[a].pre;
    const postEnd = state[a].post;
    // Medical-qualified HSA cents are capped at the committed withdrawal cents so the emergency residual is
    // never negative; the two sum to the committed cents exactly.
    const withdrawnCents = Math.round(yearWithdrawnByAcct[a] * 100);
    const medicalCents = state[a].taxTreatment === 'HSA' && yearMedicalQualifiedByAcct[a] > 0
      ? Math.min(withdrawnCents, Math.round(yearMedicalQualifiedByAcct[a] * 100))
      : 0;
    accountBalances.set(state[a].id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn: yearWithdrawnByAcct[a],
      deposit: yearDepositByAcct[a],
      preWithdrawnCents: Math.round(yearPreWithdrawnByAcct[a] * 100),
      postWithdrawnCents: Math.round(yearPostWithdrawnByAcct[a] * 100),
      ...(medicalCents > 0 ? { medicalQualifiedWithdrawnCents: medicalCents } : {}),
    });
    totalBalance += preEnd + postEnd;
  }
  return {
    year: calendarYear,
    balance: totalBalance,
    withdrawn: yearWithdrawn,
    netNeed: yearNetNeedRow,
    growth: yearGrowth,
    deposit: yearDeposit,
    depleted,
    accountBalances,
    rmdReinvestedCents:
      surplusResult.reinvestedDollars > 0
        ? Math.round(surplusResult.reinvestedDollars * 100)
        : undefined,
    rmdOverflowToCashCents:
      surplusResult.overflowToCashDollars > 0
        ? Math.round(surplusResult.overflowToCashDollars * 100)
        : undefined,
    magiCapBreachDollars: yearMagiCapBreachDollars > 0 ? yearMagiCapBreachDollars : undefined,
    magiCapTierOverrideDollars:
      yearMagiCapTierOverrideDollars > 0 ? yearMagiCapTierOverrideDollars : undefined,
    rothConvertedCents: rothConvertedCents > 0 ? rothConvertedCents : undefined,
    rothConversionDegradedNoTarget: rothConversionDegradedNoTarget ? true : undefined,
    ...(rothConvertedCents > 0 && taxFundingCentsByAccount !== undefined
      ? { rothConversionTaxFundingCentsByAccount: taxFundingCentsByAccount }
      : {}),
  };
}
