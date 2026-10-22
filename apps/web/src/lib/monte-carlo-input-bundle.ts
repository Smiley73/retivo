/** Run-once Monte Carlo input assembly for the `BalanceProjectionMcBundle` (accounts, SS/income arrays, windowed expense/medical bases, guardrail block); called once per projection.
 * Guardrails: docs/math-projections.md ("Spending guardrails"). */

import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import {
  buildIncomeContext,
  projectIncomeByYear,
} from './income-projection';
import {
  buildExpenseProjectionContext,
  projectExpensesByMonth,
  projectExpensesByCategoryMonth,
  type ExpenseCategoryMonthlyPoint,
} from './expense-projection';
import {
  buildMemberRetirementMap,
  groupBalancesByAccount,
} from './balance-projection-runner-projection';
import {
  buildAccountBundleItem,
  type AccountBundleItem,
  type AccountBundleItemCtx,
} from './balance-projection-runner-mc-glide';
import {
  resolveAccountAssetMixForScenario,
  resolveDownturnGuardrailsForScenario,
  resolveInflationForScenario,
} from './scenario-resolution';
import { GUARDRAIL_EFFECTIVE_TAX_PROXY, type GuardrailConfig } from './guardrails';
import {
  buildBalanceProjectionMcBundle,
  type BalanceProjectionMcBundle,
  type ClassifiedDepositEvent,
  type GuardrailBundleBlock,
} from './balance-projection-bundle';
import {
  isHsaQualifiedMedical,
  isMedicalExpense,
  medicalCategoryIdSet,
} from './expense-category-resolvers';
import { resolveExpensesForScenario } from './expense-resolution';
import { resolveIncomeForScenario } from './income-resolution';
import { resolveLinkedCbpIncomeStreams } from './cbp-resolution';
import type {
  PipelineContext,
  RunBalanceProjectionArgs,
  CashflowSeries,
} from './balance-projection-runner-types';
import { buildSsContext, projectSsByYear, resolveSsColaPct } from './ss-projection';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';

export function assembleMcBundle(args: {
  readonly runArgs: RunBalanceProjectionArgs;
  readonly ctx: PipelineContext;
  readonly cashflowSeries: CashflowSeries;
  /** Live-advisory override: bypasses the chain resolve and the `enabled` gate; omitted by projection-time callers. */
  readonly guardrailOverrideConfig?: GuardrailConfig;
}): BalanceProjectionMcBundle {
  const { runArgs, ctx, cashflowSeries, guardrailOverrideConfig } = args;
  const todayYear = runArgs.todayYear;
  const cbpValidationOk = ctx.cbpValidation === null || ctx.cbpValidation.ok;
  const cbpElections = cbpValidationOk
    ? resolveLinkedCbpIncomeStreams({
        scenarioId: runArgs.scenarioId,
        scenarios: ctx.effectiveScenarios,
        accounts: ctx.accountProjections.map((p) => p.account),
        incomeStreams: runArgs.incomeStreams,
      })
    : null;
  const accountBundles = buildAccountBundles(runArgs, ctx);
  const nominalArrays = computeNominalYearArrays(runArgs, ctx);
  const targetedOneOffEvents = reanchorEvents(
    cashflowSeries.targetedOneOffEvents,
    todayYear,
  );
  const postPrimaryContributionEvents = reanchorEvents(
    cashflowSeries.postPrimaryContributionEvents,
    todayYear,
  );
  const plainPensionPlacementEvents = reanchorEvents(
    cashflowSeries.plainPensionPlacementEvents,
    todayYear,
  );
  const cbpOwnerBirthdateByAccountId = new Map<string, string>();
  const birthdateByMemberId = new Map<string, string>();
  if (ctx.primary.payload.birthdate) {
    birthdateByMemberId.set(ctx.primary.id, ctx.primary.payload.birthdate);
  }
  if (ctx.secondary?.payload.birthdate) {
    birthdateByMemberId.set(ctx.secondary.id, ctx.secondary.payload.birthdate);
  }
  for (const proj of ctx.accountProjections) {
    if (proj.account.payload.type !== 'RETIREMENT_CASH_BALANCE') continue;
    const bd = birthdateByMemberId.get(proj.account.payload.ownerId);
    if (bd) cbpOwnerBirthdateByAccountId.set(proj.account.id, bd);
  }
  const rmdSnapshotForSplit = (ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE).rmd;
  // The guardrail block is computed only when a scenario in the chain enables it, so a no-guardrail bundle (and the `mcCacheKey` derived from it) stays byte-identical.
  const guardrailBlock = computeGuardrailBundleBlock(
    runArgs,
    ctx,
    nominalArrays,
    guardrailOverrideConfig,
  );
  const bundle = buildBalanceProjectionMcBundle({
    scenarioId: runArgs.scenarioId,
    scenarios: ctx.effectiveScenarios,
    accounts: [...runArgs.accounts],
    balances: [],
    incomeStreams: [...runArgs.incomeStreams],
    members: [...runArgs.members],
    expenses: [...runArgs.expenses],
    ssBenefits: [...runArgs.ssBenefits],
    cbpElections,
    cbpValidation: ctx.cbpValidation ?? {
      ok: true,
      unconfigured: [],
      annuityMissingStream: [],
      annuityDuplicateStream: [],
    },
    todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    retirementYear: ctx.primaryRetirementYear,
    primaryRetirementMonth0: ctx.primaryRetirementMonth0,
    horizonYear: ctx.horizonYear,
    retirementFractionalYear:
      ctx.primaryRetirementYear + ctx.primaryRetirementMonth0 / 12,
    lifeMarkers: [],
    accountBundles,
    monthlyExpenseBase: nominalArrays.monthlyExpenseBase,
    ...(nominalArrays.monthlyExpenseBucketsBase !== undefined
      ? { monthlyExpenseBucketsBase: nominalArrays.monthlyExpenseBucketsBase }
      : {}),
    ...(nominalArrays.monthlyMedicalDemandBase !== undefined
      ? {
          monthlyMedicalDemandBase: nominalArrays.monthlyMedicalDemandBase,
          medicalDemandRatePct: nominalArrays.medicalDemandRatePct,
          ...(nominalArrays.monthlyMedicalDemandBucketsBase !== undefined
            ? { monthlyMedicalDemandBucketsBase: nominalArrays.monthlyMedicalDemandBucketsBase }
            : {}),
        }
      : {}),
    ...(nominalArrays.monthlyMedicalExpenseBase !== undefined
      ? {
          monthlyMedicalExpenseBase: nominalArrays.monthlyMedicalExpenseBase,
          medicalExpenseRatePct: nominalArrays.medicalExpenseRatePct,
          ...(nominalArrays.monthlyMedicalExpenseBucketsBase !== undefined
            ? { monthlyMedicalExpenseBucketsBase: nominalArrays.monthlyMedicalExpenseBucketsBase }
            : {}),
        }
      : {}),
    ssByYear: nominalArrays.ssByYear,
    incomeByYear: nominalArrays.incomeByYear,
    // Use the per-field resolver (`ctx.projCtx.inflationPct`), not `ctx.resolvedScenario.inflation?.ratePct`: a split override (a child defining only `categoryRates`)
    // drops the parent's `ratePct` from the merged section, which would break parity with the deterministic engine.
    scenarioInflationPct: ctx.projCtx.inflationPct,
    targetedOneOffEvents,
    postPrimaryContributionEvents,
    plainPensionPlacementEvents,
    cbpOwnerBirthdateByAccountId,
    rmdSnapshot: rmdSnapshotForSplit,
    // Linked-CBP lump-sum event months, so `applyCbpAccount` grows the source CBP to the actual event month instead of the retirement step.
    cbpLumpSumEventAbsMonth: ctx.cbpLumpSumEventAbsMonth,
  });
  // The base plan carries no investment cost; only the "Higher fees" market stress sets the engine lever, overlaid in `market-stress.ts`.
  return guardrailBlock !== undefined
    ? { ...bundle, downturnGuardrails: guardrailBlock }
    : bundle;
}

// Per-drawdown-year real (today's-dollar) baseline series the funded ratio discounts: total spending, the essential-only cut floor, and net need
// = total minus guaranteed income (survivor-adjusted SS + lifetime annuity pension, deflated by the scenario's flat inflation); part-time, one-off and lump-sum pension income is excluded.
function computeGuardrailBundleBlock(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  nominalArrays: { ssByYear: number[]; incomeByYear: number[] },
  overrideConfig?: GuardrailConfig,
): GuardrailBundleBlock | undefined {
  let config: GuardrailConfig;
  if (overrideConfig !== undefined) {
    config = overrideConfig;
  } else {
    const resolved = resolveDownturnGuardrailsForScenario(
      runArgs.scenarioId,
      [...ctx.effectiveScenarios],
    );
    if (resolved === undefined || resolved.enabled !== true) return undefined;
    config = resolved;
  }

  const todayYear = runArgs.todayYear;
  // Anchor at the engine's clamped drawdown start: for an already-retired household drawdown year 0 is today, and the unclamped past year
  // would zero-pad the first N entries (negative indexes skip silently) and shift the series N years late, dropping the essential floor to 0.
  const anchorYear = Math.max(ctx.primaryRetirementYear, todayYear);
  const horizonYears = ctx.horizonYear - todayYear + 1;
  const retYearOffset = anchorYear - todayYear;
  const drawdownYearCount = Math.max(0, horizonYears - retYearOffset);
  if (drawdownYearCount === 0) return undefined;

  const { totalReal, essentialReal } = computeGuardrailExpenseRealByYear(
    runArgs,
    ctx,
    anchorYear,
    drawdownYearCount,
  );

  const inflationPct = ctx.projCtx.inflationPct;
  const annuityNominalByYear = computeGuaranteedAnnuityIncomeByYear(
    runArgs,
    ctx,
    horizonYears,
  );
  const netNeedReal = new Array<number>(drawdownYearCount);
  for (let y = 0; y < drawdownYearCount; y += 1) {
    const yearIdx = retYearOffset + y;
    const nominalGuaranteed =
      (nominalArrays.ssByYear[yearIdx] ?? 0) + (annuityNominalByYear[yearIdx] ?? 0);
    const deflator = Math.pow(1 + inflationPct / 100, yearIdx);
    const guaranteedReal = deflator > 0 ? nominalGuaranteed / deflator : 0;
    netNeedReal[y] = totalReal[y] - guaranteedReal;
  }

  return {
    config,
    baselineTotalRealByYear: totalReal,
    baselineNetNeedRealByYear: netNeedReal,
    essentialRealByYear: essentialReal,
    effectiveTaxRate: GUARDRAIL_EFFECTIVE_TAX_PROXY,
  };
}

function computeGuardrailExpenseRealByYear(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  anchorYear: number,
  drawdownYearCount: number,
): { totalReal: number[]; essentialReal: number[] } {
  const resolvedExpenses = resolveExpensesForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.expenses],
  );
  // Per-category real differential: the kernel grows each bucket at `(1 + rate/1200)/(1 + general/1200)` per month, while `projectExpensesByMonth`
  // compounds a category's rate annually, so feed it the annually-compounded equivalent; `rate - general` under-compounds and can flip a funded-ratio
  // band near the edge. General inflation is 0 (today's dollars); with no per-category override every spread is 0.
  const inflation = resolveInflationForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    medicalCategoryIdSet(runArgs.medicalCategoryIds),
  );
  const generalRate = inflation.ratePct;
  const differentialRates = new Map<string, number>();
  for (const [catId, rate] of inflation.categoryRates) {
    if (rate === generalRate) continue; // flat-real; leave at the general factor
    const monthlyRealFactor = (1 + rate / 1200) / (1 + generalRate / 1200);
    const annualPct = 100 * (Math.pow(monthlyRealFactor, 12) - 1);
    differentialRates.set(catId, annualPct);
  }
  const baseCtx = {
    ...buildExpenseProjectionContext({
      resolved: {
        discretionarySpending: ctx.resolvedScenario.discretionarySpending,
        lifeExpectancy: ctx.resolvedScenario.lifeExpectancy,
      },
      primary: { birthdate: ctx.primary.payload.birthdate },
      secondary: ctx.secondary ? { birthdate: ctx.secondary.payload.birthdate } : null,
      primaryRetirementIso: ctx.primaryRetIso,
    }),
    todayYear: runArgs.todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    retirementMonth0: ctx.primaryRetirementMonth0,
    inflation: { ratePct: 0, categoryRates: differentialRates },
  };
  const yearRange = { from: runArgs.todayYear, to: ctx.horizonYear };
  const monthlyPoints = projectExpensesByMonth(resolvedExpenses, baseCtx, yearRange);
  const totalReal = new Array<number>(drawdownYearCount).fill(0);
  const essentialReal = new Array<number>(drawdownYearCount).fill(0);
  const retMonthStart = (anchorYear - runArgs.todayYear) * 12;
  for (let y = 0; y < drawdownYearCount; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      const idx = retMonthStart + y * 12 + m;
      const p = monthlyPoints[idx];
      if (p === undefined) continue;
      const essential = monthlyChargeFromRunRate(p.essential, p.oneOffEssential);
      const discretionary = monthlyChargeFromRunRate(
        p.discretionary,
        p.oneOffDiscretionary,
      );
      essentialReal[y] += essential;
      totalReal[y] += essential + discretionary;
    }
  }
  return { totalReal, essentialReal };
}

function computeGuaranteedAnnuityIncomeByYear(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  horizonYears: number,
): number[] {
  const todayYear = runArgs.todayYear;
  const allResolved = resolveIncomeForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.incomeStreams],
  );
  const annuityStreams = allResolved.filter(
    (s) => s.payload.kind === 'pension' && s.payload.payoutType === 'annuity',
  );
  if (annuityStreams.length === 0) return new Array(horizonYears).fill(0);
  const inflationPct =
    ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const lifeExp = ctx.resolvedScenario.lifeExpectancy;
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const incomeCtx = buildIncomeContext([...runArgs.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary: lifeExp?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
    lifeExpectancySecondary: lifeExp?.secondary,
    retirementDateByMember,
    todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    inflationPct,
  });
  const yearRange = { from: todayYear, to: todayYear + horizonYears - 1 };
  const byYear = projectIncomeByYear(annuityStreams, incomeCtx, yearRange);
  return byYear.map((row) => row.spendable.total);
}

function buildAccountBundles(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): AccountBundleItem[] {
  const todayYear = runArgs.todayYear;
  const stopContributionsToday =
    ctx.resolvedScenario.contributions?.stopContributionsToday ?? false;
  const assetMixOverrides = resolveAccountAssetMixForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    ctx.accountProjections.map((p) => p.account),
  );
  const retirementAllocation = ctx.resolvedScenario.retirementAllocation ?? null;
  const horizonYears = ctx.horizonYear - todayYear + 1;
  const stepCount = horizonYears * 12;
  // Month-precise retirement step (as in `buildStepInputs`), so `assetMixSeries[retirementStepIdx]` is the first drawdown step.
  const retirementStepIdx = Math.max(
    0,
    (ctx.primaryRetirementYear - todayYear) * 12 + ctx.primaryRetirementMonth0,
  );
  // Latest stored pre/post split, so MIXED accounts keep their actual buckets (not the 50/50 default of `splitInitialByTaxTreatment`).
  const balancesByAccount = groupBalancesByAccount(runArgs.balances);
  const itemCtx: AccountBundleItemCtx = {
    stopContributionsToday,
    assetMixOverrides,
    retirementAllocation,
    retirementStepIdx,
    stepCount,
    todayYear,
    // Actual retirement year for the glide baseline: `retirementStepIdx` is clamped to 0 for already-retired households.
    primaryRetirementYear: ctx.primaryRetirementYear,
    balancesByAccount,
  };
  return ctx.accountProjections.map((p) => buildAccountBundleItem(p, itemCtx));
}

function computeNominalYearArrays(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): {
  monthlyExpenseBase: number[];
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  monthlyMedicalDemandBase?: number[];
  medicalDemandRatePct?: number;
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  ssByYear: number[];
  incomeByYear: number[];
} {
  const horizonYears = ctx.horizonYear - runArgs.todayYear + 1;
  const expense = computeWindowedExpenseBase(runArgs, ctx);
  return {
    monthlyExpenseBase: expense.monthlyExpenseBase,
    ...(expense.monthlyExpenseBucketsBase !== undefined
      ? { monthlyExpenseBucketsBase: expense.monthlyExpenseBucketsBase }
      : {}),
    ...(expense.monthlyMedicalDemandBase !== undefined
      ? {
          monthlyMedicalDemandBase: expense.monthlyMedicalDemandBase,
          medicalDemandRatePct: expense.medicalDemandRatePct,
          ...(expense.monthlyMedicalDemandBucketsBase !== undefined
            ? { monthlyMedicalDemandBucketsBase: expense.monthlyMedicalDemandBucketsBase }
            : {}),
        }
      : {}),
    ...(expense.monthlyMedicalExpenseBase !== undefined
      ? {
          monthlyMedicalExpenseBase: expense.monthlyMedicalExpenseBase,
          medicalExpenseRatePct: expense.medicalExpenseRatePct,
          ...(expense.monthlyMedicalExpenseBucketsBase !== undefined
            ? { monthlyMedicalExpenseBucketsBase: expense.monthlyMedicalExpenseBucketsBase }
            : {}),
        }
      : {}),
    ssByYear: computeSsByYear(runArgs, ctx, horizonYears),
    incomeByYear: computeNonSsIncomeByYear(runArgs, ctx, horizonYears),
  };
}

// Windowed per-month today's-dollar expense base from the deterministic windowing helpers with inflation pinned to 0 (each expense only in its active window,
// one-offs whole in their spike month, recurring at run-rate ÷ 12); length equals kernel `stepCount`. Buckets regroup each category by its effective rate and are
// emitted only when at least one rate differs from the general rate; a per-step residual-adjust pins `Σ_b base_b[i] === monthlyExpenseBase[i]` at cent precision.
function computeWindowedExpenseBase(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): {
  monthlyExpenseBase: number[];
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  monthlyMedicalDemandBase?: number[];
  medicalDemandRatePct?: number;
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Every `isMedical` row (the HSA demand is its qualified subset): caps the credit applied to premiums. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} {
  const resolvedExpenses = resolveExpensesForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.expenses],
  );
  const baseCtx = {
    ...buildExpenseProjectionContext({
      resolved: {
        discretionarySpending: ctx.resolvedScenario.discretionarySpending,
        lifeExpectancy: ctx.resolvedScenario.lifeExpectancy,
      },
      primary: { birthdate: ctx.primary.payload.birthdate },
      secondary: ctx.secondary
        ? { birthdate: ctx.secondary.payload.birthdate }
        : null,
      primaryRetirementIso: ctx.primaryRetIso,
    }),
    todayYear: runArgs.todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    retirementMonth0: ctx.primaryRetirementMonth0,
  };
  const yearRange = { from: runArgs.todayYear, to: ctx.horizonYear };
  const stepCount = (ctx.horizonYear - runArgs.todayYear + 1) * 12;

  const monthlyPoints = projectExpensesByMonth(resolvedExpenses, baseCtx, yearRange);
  const monthlyExpenseBase = monthlyPoints.map((p) =>
    round2(
      monthlyChargeFromRunRate(p.essentialBase, p.oneOffEssentialBase) +
        monthlyChargeFromRunRate(p.discretionaryBase, p.oneOffDiscretionaryBase),
    ),
  );
  assertExpenseBaseLength(monthlyExpenseBase, stepCount, 'monthlyExpenseBase');

  const inflation = resolveInflationForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    medicalCategoryIdSet(runArgs.medicalCategoryIds),
  );
  const generalRate = inflation.ratePct;

  const medicalArgs = { runArgs, resolvedExpenses, baseCtx, yearRange, inflation, generalRate, stepCount };
  const medical = {
    ...computeMedicalDemandBase(medicalArgs),
    ...computeMedicalExpenseBase(medicalArgs),
  };

  const anyNonGeneral = resolvedExpenses.some(
    (e) =>
      (inflation.categoryRates.get(e.payload.categoryId) ?? generalRate) !==
      generalRate,
  );
  if (!anyNonGeneral) return { monthlyExpenseBase, ...medical };

  const monthlyExpenseBucketsBase = buildWindowedBuckets({
    resolvedExpenses,
    baseCtx,
    yearRange,
    inflation,
    generalRate,
    monthlyExpenseBase,
    stepCount,
  });
  // `buildWindowedBuckets` returns undefined when every non-general-rate expense is outside the window; omit the field so the kernel takes the scalar path.
  if (monthlyExpenseBucketsBase === undefined) return { monthlyExpenseBase, ...medical };
  return { monthlyExpenseBase, monthlyExpenseBucketsBase, ...medical };
}

interface MedicalBaseArgs {
  runArgs: RunBalanceProjectionArgs;
  resolvedExpenses: ReturnType<typeof resolveExpensesForScenario>;
  baseCtx: Parameters<typeof projectExpensesByCategoryMonth>[1];
  yearRange: { from: number; to: number };
  inflation: ReturnType<typeof resolveInflationForScenario>;
  generalRate: number;
  stepCount: number;
}

// `medicalDemandRatePct` is the categories' effective inflation rate, so the demand inflates at the matching CPI and stays a subset of the inflated expense.
function computeMedicalDemandBase(args: MedicalBaseArgs): {
  monthlyMedicalDemandBase?: number[];
  medicalDemandRatePct?: number;
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} {
  const series = computeMedicalBaseSeries(args, isHsaQualifiedMedical, 'monthlyMedicalDemandBase');
  if (series === null) return {};
  return {
    monthlyMedicalDemandBase: series.base,
    medicalDemandRatePct: series.ratePct,
    ...(series.buckets !== undefined ? { monthlyMedicalDemandBucketsBase: series.buckets } : {}),
  };
}

// Buckets are sorted by rate so the cache key does not depend on category order.
function computeMedicalExpenseBase(args: MedicalBaseArgs): {
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} {
  const series = computeMedicalBaseSeries(args, isMedicalExpense, 'monthlyMedicalExpenseBase');
  if (series === null) return {};
  return {
    monthlyMedicalExpenseBase: series.base,
    medicalExpenseRatePct: series.ratePct,
    ...(series.buckets !== undefined
      ? { monthlyMedicalExpenseBucketsBase: [...series.buckets].sort((a, b) => a.ratePct - b.ratePct) }
      : {}),
  };
}

function computeMedicalBaseSeries(
  args: MedicalBaseArgs,
  qualifies: (
    expense: ReturnType<typeof resolveExpensesForScenario>[number],
    medicalIds: ReadonlySet<string>,
  ) => boolean,
  label: string,
): {
  base: number[];
  ratePct: number;
  buckets?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} | null {
  const { runArgs, resolvedExpenses, baseCtx, yearRange, inflation, generalRate, stepCount } = args;
  const medicalIds = medicalCategoryIdSet(runArgs.medicalCategoryIds);
  if (medicalIds.size === 0) return null;
  const qualifiedExpenses = resolvedExpenses.filter((e) => qualifies(e, medicalIds));
  if (qualifiedExpenses.length === 0) return null;
  const points = projectExpensesByCategoryMonth(qualifiedExpenses, baseCtx, yearRange);
  const base = new Array<number>(stepCount).fill(0);
  const byRate = new Map<number, number[]>();
  for (let i = 0; i < points.length && i < stepCount; i += 1) {
    const p = points[i];
    let recurring = 0;
    let oneOff = 0;
    for (const id of medicalIds) {
      const r = p.recurringByCategoryId[id] ?? 0;
      const o = p.oneOffByCategoryId[id] ?? 0;
      recurring += r;
      oneOff += o;
      const rate = inflation.categoryRates.get(id) ?? generalRate;
      if (!Number.isFinite(rate)) {
        throw new Error(`monte-carlo: non-finite medical bucket inflation rate ${String(rate)}`);
      }
      const monthly = monthlyChargeFromRunRate(r, o);
      if (monthly === 0) continue;
      let arr = byRate.get(rate);
      if (!arr) {
        arr = new Array<number>(stepCount).fill(0);
        byRate.set(rate, arr);
      }
      arr[i] = round2(arr[i] + monthly);
    }
    base[i] = round2(monthlyChargeFromRunRate(recurring, oneOff));
  }
  assertExpenseBaseLength(base, stepCount, label);
  // The shared rate is that of the sole nonzero-demand bucket: the first flagged id's rate would inflate demand at the wrong CPI when that category has a non-general
  // override but zero in-window spend, letting medical demand exceed medical expense. Falls back to the first flagged id only when `byRate` is empty (all-zero base, rate inert).
  let medicalRate: number;
  if (byRate.size >= 1) {
    medicalRate = [...byRate.keys()][0];
  } else {
    medicalRate = generalRate;
    for (const id of medicalIds) {
      medicalRate = inflation.categoryRates.get(id) ?? generalRate;
      break;
    }
  }
  if (byRate.size > 1) {
    const buckets = [...byRate.entries()].map(([ratePct, amount]) => {
      assertExpenseBaseLength(amount, stepCount, `${label.replace('Base', 'BucketsBase')}[${ratePct}]`);
      return { ratePct, amount };
    });
    return { base, ratePct: medicalRate, buckets };
  }
  return { base, ratePct: medicalRate };
}

function buildWindowedBuckets(args: {
  resolvedExpenses: ReturnType<typeof resolveExpensesForScenario>;
  baseCtx: Parameters<typeof projectExpensesByCategoryMonth>[1];
  yearRange: { from: number; to: number };
  inflation: ReturnType<typeof resolveInflationForScenario>;
  generalRate: number;
  monthlyExpenseBase: number[];
  stepCount: number;
}): ReadonlyArray<{ ratePct: number; amount: number[] }> | undefined {
  const { baseCtx, yearRange, inflation, generalRate, monthlyExpenseBase, stepCount } =
    args;
  const categoryPoints: ExpenseCategoryMonthlyPoint[] = projectExpensesByCategoryMonth(
    args.resolvedExpenses,
    baseCtx,
    yearRange,
  );
  const byRate = new Map<number, number[]>();
  for (let i = 0; i < stepCount; i += 1) {
    const point = categoryPoints[i];
    for (const [categoryId, runRate] of Object.entries(point.byCategoryId)) {
      const rate = inflation.categoryRates.get(categoryId) ?? generalRate;
      if (!Number.isFinite(rate)) {
        throw new Error(
          `monte-carlo: non-finite bucket inflation rate ${String(rate)}`,
        );
      }
      const spike = point.oneOffByCategoryId[categoryId] ?? 0;
      const monthly = monthlyChargeFromRunRate(runRate, spike);
      let arr = byRate.get(rate);
      if (!arr) {
        arr = new Array<number>(stepCount).fill(0);
        byRate.set(rate, arr);
      }
      arr[i] = round2(arr[i] + monthly);
    }
  }
  const buckets = [...byRate.entries()].map(([ratePct, amount]) => ({
    ratePct,
    amount,
  }));
  if (buckets.length === 0) return undefined;
  // Residual-adjust the last bucket so `Σ_b amount_b[i] === monthlyExpenseBase[i]` at cent precision.
  const last = buckets[buckets.length - 1].amount;
  for (let i = 0; i < stepCount; i += 1) {
    let sum = 0;
    for (const b of buckets) sum += b.amount[i];
    const residual = round2(monthlyExpenseBase[i] - sum);
    if (residual !== 0) last[i] = round2(last[i] + residual);
  }
  for (const b of buckets) {
    assertExpenseBaseLength(b.amount, stepCount, `monthlyExpenseBucketsBase[${b.ratePct}]`);
  }
  return buckets;
}

function assertExpenseBaseLength(
  arr: ReadonlyArray<number>,
  stepCount: number,
  label: string,
): void {
  if (arr.length !== stepCount) {
    throw new Error(
      `monte-carlo: ${label}.length (${arr.length}) !== stepCount (${stepCount})`,
    );
  }
  for (let i = 0; i < arr.length; i += 1) {
    if (!Number.isFinite(arr[i])) {
      throw new Error(`monte-carlo: ${label}[${i}] is non-finite (${String(arr[i])})`);
    }
  }
}

// Annualized run-rate with a one-off spike at its full literal amount to the true monthly charge: `(runRate - spike)/12 + spike`,
// the `monthlyBucket` math the cashflow band uses (inflation factor 1 for today's dollars).
function monthlyChargeFromRunRate(runRate: number, spike: number): number {
  return (runRate - spike) / 12 + spike;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeSsByYear(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  horizonYears: number,
): number[] {
  const ssOverride = ctx.resolvedScenario.socialSecurity;
  return computeSsByYearForClaimAges({
    runArgs,
    ctx,
    horizonYears,
    claimAgePrimary: ssOverride?.primary ?? { ageYears: 67, ageMonths: 0 },
    claimAgeSecondary: ssOverride?.secondary,
  });
}

/**
 * SS year array for an explicit primary/secondary claim-age pair, for the optimizer fast path: only this candidate-sensitive slice is recomputed per pair,
 * with the same `buildSsContext` + `projectSsByYear` as `computeSsByYear`. The SS context carries no earned income, so Monte Carlo skips the earnings test
 * that the deterministic projection applies (docs/math-social-security-and-health.md, "The earnings test").
 */
export function computeSsByYearForClaimAges(args: {
  runArgs: RunBalanceProjectionArgs;
  ctx: PipelineContext;
  horizonYears: number;
  claimAgePrimary: { ageYears: number; ageMonths: number };
  claimAgeSecondary?: { ageYears: number; ageMonths: number };
  /** Per-member survivor claim ages carried by the candidate overlay; absent applies the resolved scenario's stored `survivor` section, as in the deterministic `withCandidateOverlay`. */
  survivor?: {
    primary?: { ageYears: number; ageMonths: number };
    secondary?: { ageYears: number; ageMonths: number };
  };
}): number[] {
  const { runArgs, ctx, horizonYears, claimAgePrimary, claimAgeSecondary } = args;
  const todayYear = runArgs.todayYear;
  const ssOverride = ctx.resolvedScenario.socialSecurity;
  const lifeExp = ctx.resolvedScenario.lifeExpectancy;
  const survivor = args.survivor ?? ssOverride?.survivor;
  const ssCtx = buildSsContext(
    [...runArgs.members],
    [...runArgs.ssBenefits],
    {
      claimAgePrimary,
      claimAgeSecondary,
      // Survivor claim ages: the overlay's when carried, else the stored section; absent makes the shared engine withhold survivor-dependent results.
      survivorClaimAgePrimary: survivor?.primary,
      survivorClaimAgeSecondary: survivor?.secondary,
      lifeExpectancyPrimary: lifeExp?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
      lifeExpectancySecondary: lifeExp?.secondary,
      colaPct: resolveSsColaPct(
        ssOverride,
        ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
      ),
      benefitReductionPct: ssOverride?.benefitReductionPct ?? 0,
    },
  );
  if (!ssCtx) return Array(horizonYears).fill(0) as number[];
  const yearRange = { from: todayYear, to: todayYear + horizonYears - 1 };
  return projectSsByYear(ssCtx, yearRange).map((row) => row.total);
}

function computeNonSsIncomeByYear(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  horizonYears: number,
): number[] {
  const todayYear = runArgs.todayYear;
  const resolvedIncomeList = resolveIncomeForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.incomeStreams],
  );
  const inflationPct =
    ctx.resolvedScenario.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  const lifeExp = ctx.resolvedScenario.lifeExpectancy;
  const retirementDateByMember = buildMemberRetirementMap(ctx.retirementByMember);
  const incomeCtx = buildIncomeContext([...runArgs.members], {
    retirementStartYear: ctx.primaryRetirementYear,
    lifeExpectancyPrimary:
      lifeExp?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
    lifeExpectancySecondary: lifeExp?.secondary,
    retirementDateByMember,
    todayYear,
    todayMonthIndex: runArgs.todayMonthIndex,
    inflationPct,
  });
  const yearRange = { from: todayYear, to: todayYear + horizonYears - 1 };
  const byYear = projectIncomeByYear(resolvedIncomeList, incomeCtx, yearRange);
  return byYear.map((row) => row.spendable.total);
}

function reanchorEvents(
  events: ReadonlyArray<ClassifiedDepositEvent>,
  todayYear: number,
): ClassifiedDepositEvent[] {
  return events.map((e) => ({
    month: e.month - todayYear * 12,
    amount: e.amount,
    ...(e.amountPre !== undefined ? { amountPre: e.amountPre } : {}),
    ...(e.amountPost !== undefined ? { amountPost: e.amountPost } : {}),
    accountId: e.accountId,
  }));
}
