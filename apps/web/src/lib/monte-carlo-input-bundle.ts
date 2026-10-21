/**
 * Monte-Carlo run-once input assembly, split out of
 * `balance-projection-runner-mc.ts` so the parent stays under the file
 * shape cap. These
 * helpers build the `BalanceProjectionMcBundle` (accounts, nominal SS/income
 * year arrays, windowed expense/medical bases, downturn-guardrail block) that
 * the MC builder consumes. Called once per projection, never per path.
 *
 * `assembleMcBundle` / `computeSsByYearForClaimAges` are re-imported by the
 * parent's optimizer setup; everything else is module-private.
 *
 * The taxable-income yield-drag base, evolving cost
 * basis, and cash-like interest (computed ONLY in the representative display
 * post-pass, `monte-carlo-tax-burden.ts` — never the funded per-path loop)
 * need NO bundle fields of their own — they derive entirely from carriers
 * `assembleMcBundle` already emits (the per-account `accountMcLedger` tax
 * metadata + initial balances + deposit series) plus the `McTaxContext`
 * (`assumedCostBasisFraction`, the calibration bundle's `assumedTaxableYield`
 * snapshot) built beside it in `balance-projection-runner-mc.ts`. Scenarios
 * that use none of them therefore produce unchanged bundles.
 */

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
  /** Live-advisory override: when present, the guardrail
   *  baseline series is computed for THIS config directly, bypassing the chain
   *  resolve + the `enabled` gate. Omitted by every projection-time caller, so
   *  their bundle is unaffected. */
  readonly guardrailOverrideConfig?: GuardrailConfig;
}): BalanceProjectionMcBundle {
  const { runArgs, ctx, cashflowSeries, guardrailOverrideConfig } = args;
  const todayYear = runArgs.todayYear;
  // Validation is already cached on the context. Treat the
  // null (no-CBP) case as `ok: true` so the elections lookup runs
  // when consumer code adds CBP accounts but a resolved-elections
  // path doesn't exist yet.
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
  // Source-CBP owner ISO birthdate keyed by CBP account id, for the
  // rollover-year RMD split. Resolve each CBP source's `ownerId` → the
  // household member's birthdate.
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
  // The rollover-year RMD split runs for every named strategy.
  const rmdSnapshotForSplit = (ctx.taxBundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE).rmd;
  // Downturn guardrail (guardrails): compute the config + baseline REAL series
  // ONLY when a scenario in the chain enables it, so a no-guardrail scenario's
  // bundle (and the `MonteCarloInput` + `mcCacheKey` derived from it) is
  // byte-identical to pre-feature.
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
    // Source the kernel mean-shift baseline from the SAME per-FIELD
    // resolver the bucket partition (`computeExpenseScalar` → `generalRate`)
    // and the deterministic engine use (`ctx.projCtx.inflationPct` is
    // `resolveInflationForScenario(...).ratePct`, finite by construction). The
    // whole-section `ctx.resolvedScenario.inflation?.ratePct` diverges from it
    // on a split override (a child defining only `categoryRates` drops the
    // parent's `ratePct` from the merged section) — using it would make the
    // partition and the kernel disagree on the general baseline and break MC
    // parity with the deterministic engine.
    scenarioInflationPct: ctx.projCtx.inflationPct,
    targetedOneOffEvents,
    postPrimaryContributionEvents,
    // Per-account plain-pension placements + the rollover-year RMD split
    // inputs (owner birthdate + RMD snapshot) so the MC seam fires the SAME
    // split as the deterministic engine (cent-exact parity).
    plainPensionPlacementEvents,
    cbpOwnerBirthdateByAccountId,
    rmdSnapshot: rmdSnapshotForSplit,
    // Thread linked-CBP lump-sum event months from resolved
    // income so `applyCbpAccount` grows the source CBP to the actual
    // event month (income stream's `start` anchor) instead of the
    // retirement step. Hard-coding the retirement step for every
    // lump-sum CBP would give wrong PlanStressTest +
    // optimizer numbers for post-primary lump-sum elections.
    cbpLumpSumEventAbsMonth: ctx.cbpLumpSumEventAbsMonth,
  });
  // The BASE plan carries no investment cost: the scenario setting that used to
  // feed `MonteCarloInput.annualInvestmentCostPct` is gone, and that engine
  // lever is now set ONLY by the "Higher fees" market stress, which overlays its
  // fixed +0.50 pp in `market-stress.ts` well after assembly.
  return guardrailBlock !== undefined
    ? { ...bundle, downturnGuardrails: guardrailBlock }
    : bundle;
}

/**
 * Build the downturn-guardrail bundle block (guardrails) for the resolved
 * scenario, or `undefined` when the guardrail is absent / disabled. Computes the
 * per-DRAWDOWN-year REAL (today's-dollar) baseline series the funded ratio
 * discounts:
 *   - total spending  = essential + discretionary (`projectExpensesByMonth`,
 *     already today's-dollar → real by construction),
 *   - essential-only  = the cut floor,
 *   - net need        = total − guaranteed income (survivor-adjusted SS +
 *     lifetime annuity pension only), the guaranteed income deflated from
 *     nominal to real by the scenario's flat inflation (the baseline deflator —
 *     the per-path variation enters only via the nominal year-start POOL).
 * `partTime` / `oneOff` / lump-sum pension income is EXCLUDED from guaranteed
 * income. The essential floor is stored as a real dollar series and the
 * engine converts it to a per-year factor of the baseline total. The feature is
 * explained in docs/math-projections.md ("Spending guardrails").
 */
function computeGuardrailBundleBlock(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
  nominalArrays: { ssByYear: number[]; incomeByYear: number[] },
  overrideConfig?: GuardrailConfig,
): GuardrailBundleBlock | undefined {
  // Live-advisory bypass: when the caller supplies an
  // override, compute the baseline series for it DIRECTLY — skipping the chain
  // resolve AND the `config.enabled !== true` early-return — so the funded-ratio
  // baseline runs for ANY scenario regardless of its stored `enabled` flag. When
  // omitted (every projection-time call site), behavior is unchanged.
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
  // Anchor the baseline series at the engine's CLAMPED drawdown start. The MC
  // kernel snaps `retirementStepIdx = max(0, …)` (monte-carlo.ts), so for an
  // ALREADY-RETIRED household (retirementYear < todayYear) drawdown year 0 is
  // TODAY, not the past retirement year. Mirroring that clamp here is required:
  // anchoring at the unclamped past year makes `retYearOffset` negative, zero-
  // pads the first N drawdown entries (negative `monthlyPoints`/`ssByYear`
  // indexes silently skip), and shifts the real series N years late relative to
  // what the engine reads — dropping the essential floor to 0 and mis-windowing
  // the funded-ratio liability for exactly the retirees the feature protects.
  const anchorYear = Math.max(ctx.primaryRetirementYear, todayYear);
  const horizonYears = ctx.horizonYear - todayYear + 1;
  const retYearOffset = anchorYear - todayYear;
  const drawdownYearCount = Math.max(0, horizonYears - retYearOffset);
  if (drawdownYearCount === 0) return undefined;

  // Per-drawdown-year REAL total + essential spending from the SAME windowed
  // deterministic expense projection the MC expense base is built from.
  const { totalReal, essentialReal } = computeGuardrailExpenseRealByYear(
    runArgs,
    ctx,
    anchorYear,
    drawdownYearCount,
  );

  // Guaranteed income (real): survivor-adjusted SS (all of `ssByYear`) + the
  // lifetime annuity-pension spendable only, deflated from nominal to real
  // by the scenario's flat inflation.
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

/** Per-drawdown-year REAL (today's-dollar) total + essential spending, summed
 *  from the SAME windowed deterministic expense projection the MC expense base
 *  is built from (guardrails). */
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
  // Per-category REAL differential (guardrails). The MC kernel grows each expense
  // bucket at its OWN effective rate (buildHouseholdSeries), so a category whose
  // rate exceeds general CPI — Medical at general+2pp is seeded by default —
  // rises in REAL terms too, not just nominal. The baseline liability + essential
  // floor must track the SAME real trajectory the engine spends on, or a medical-
  // heavy plan reads an optimistic funded ratio (cuts fire late) and an
  // understated essential share (a deep cut can dip below true essentials).
  //
  // Match the kernel EXACTLY under the deterministic (flat-CPI) baseline. The
  // kernel adds a MONTHLY spread `(rate − general)/12` on top of monthly CPI
  // (`bucketCumCpi *= 1 + (cpiPct + (rate−general)/12)/100`), so a bucket's real
  // factor is `((1 + rate/1200)/(1 + general/1200))^monthOffset`.
  // `projectExpensesByMonth` instead compounds a category's rate ANNUALLY
  // (`(1 + R/100)^(monthOffset/12)`), so feed it the annually-compounded
  // equivalent `R` — NOT the naive `rate − general`, which under-compounds vs the
  // kernel and can flip a funded-ratio band decision near the edge for a
  // high-rate category. General inflation is neutralised to 0 (today's dollars);
  // the per-category spread is fixed, so the real series stays path-independent.
  // No per-category override → every spread 0 → identical to the flat-real
  // `*Base` read.
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
  // Same windowed projection context the MC expense base is built from (see
  // `computeWindowedExpenseBase`), with the per-category real differential above.
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
  // `anchorYear === max(retirementYear, todayYear)` → offset ≥ 0, mirroring the
  // engine's clamped drawdown start (see `computeGuardrailBundleBlock`).
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

/** Per-year NOMINAL guaranteed lifetime annuity-pension spendable income
 *  (guardrails). SS is netted separately (all of `ssByYear`); this filters
 *  the non-SS income to `pension` streams with `payoutType === 'annuity'` — a
 *  lifetime spendable stream — EXCLUDING part-time, one-off, and lump-sum
 *  pension income. Mirrors `computeTracksInflationIncomeByYear`'s filter shape. */
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
  // Glide re-alignment: the MC kernel's `retirementStepIdx` is
  // month-precise (`(retirementYear - firstYear) * 12 +
  // primaryRetirementMonth0`, monte-carlo.ts:buildStepInputs). Build the
  // glide `assetMixSeries` from the SAME month-offset index so
  // `assetMixSeries[retirementStepIdx]` is the FIRST drawdown step (not a
  // mid-year accumulation step).
  const retirementStepIdx = Math.max(
    0,
    (ctx.primaryRetirementYear - todayYear) * 12 + ctx.primaryRetirementMonth0,
  );
  // Thread the latest stored pre/post split into the bundle so
  // MIXED accounts honor their actual buckets in the MC ledger instead
  // of falling back to the 50/50 default in `splitInitialByTaxTreatment`.
  const balancesByAccount = groupBalancesByAccount(runArgs.balances);
  const itemCtx: AccountBundleItemCtx = {
    stopContributionsToday,
    assetMixOverrides,
    retirementAllocation,
    retirementStepIdx,
    stepCount,
    todayYear,
    // Pass the actual retirement year so the glide baseline is correct
    // for already-retired households (retirementStepIdx is clamped to 0 there,
    // so deriving it from firstYear+step/12 would give the wrong baseline).
    primaryRetirementYear: ctx.primaryRetirementYear,
    balancesByAccount,
  };
  return ctx.accountProjections.map((p) => buildAccountBundleItem(p, itemCtx));
}

/** Orchestrates the sub-builders. The SS / income arrays index
 *  calendar year `todayYear + i`; the expense base indexes projection MONTH
 *  `i = 0` at January of `todayYear`. */
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

/** Windowed per-month expense base in today's dollars (inflated per-path
 *  inside the MC kernel) PLUS the per-effective-rate medical-cost
 *  per-month buckets.
 *
 *  Built from the SAME deterministic windowing helpers the Planned/Historical
 *  projection uses (`projectExpensesByMonth` / `projectExpensesByCategoryMonth`)
 *  with inflation pinned to 0% so the output is the inflation-neutral
 *  today's-dollar `*Base` schedule — each expense charged ONLY in the months
 *  its start/end window is active, one-offs at their full literal amount in the
 *  single spike month, recurring expenses at run-rate ÷ 12 per active month.
 *  The discretionary glide + bump are baked in (they are real-terms
 *  knobs, not inflation). NEVER de-inflated from the nominal cashflow series
 *  (that is nominal/single-rate — the wrong shape).
 *
 *  `monthlyExpenseBase[i]` indexes projection month `i = 0` at January of
 *  `todayYear`; length === kernel `stepCount` (`horizonYears × 12`). A
 *  construction guard asserts the length + finiteness; a zero-expense
 *  scenario yields an all-zero base (valid, not an error).
 *
 *  Buckets regroup each category's per-month today's-dollar amount by its
 *  EFFECTIVE inflation rate from `resolveInflationForScenario`
 *  (`categoryRates.get(categoryId) ?? ratePct`, the SAME map the deterministic
 *  engine uses). A per-step residual-adjust pins `Σ_b base_b[i] ===
 *  monthlyExpenseBase[i]` at round2 cent precision. Buckets are emitted ONLY
 *  when ≥ 1 effective rate ≠ the general rate; otherwise ABSENT and the kernel
 *  runs the verbatim scalar base path. The resolved map is already sanitised
 *  to finite values, so every bucket rate is finite by construction — the
 *  `Number.isFinite` assert is an invariant guard for the Worker/structured-
 *  clone boundary, not a re-sanitisation. */
function computeWindowedExpenseBase(
  runArgs: RunBalanceProjectionArgs,
  ctx: PipelineContext,
): {
  monthlyExpenseBase: number[];
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Per-month today's-dollar HSA medical-demand base — `isMedical`
   *  subset of `monthlyExpenseBase`. Absent when no category is flagged. */
  monthlyMedicalDemandBase?: number[];
  /** Effective inflation rate (%) the `isMedical` categories grow at. */
  medicalDemandRatePct?: number;
  /** Per-effective-rate medical-demand buckets — emitted only when the
   *  `isMedical` categories span > 1 effective rate. */
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Every `isMedical` row (the HSA demand above is its qualified subset), with
   *  its effective rate and per-rate buckets — caps the credit applied to
   *  premiums. Absent when no category is flagged. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} {
  const resolvedExpenses = resolveExpensesForScenario(
    runArgs.scenarioId,
    [...ctx.effectiveScenarios],
    [...runArgs.expenses],
  );
  // Inflation-neutral (0%) projection context: the `*Base` fields ARE the
  // today's-dollar windowed schedule. `todayYear` / `todayMonthIndex` anchor
  // the projection so the base covers the full [todayYear, horizonYear] range
  // (one entry per month, kernel `stepCount`); pre-window / pre-retirement
  // months are 0 by construction.
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

  // Scalar base: the TRUE per-month dollar charge in today's dollars. The
  // `projectExpensesBy*` family emits ANNUALIZED run-rates ($/yr) per month
  // with one-offs at their FULL literal amount in the spike month, so convert
  // each month via the `monthlyBucket` rule (same math the cashflow band
  // uses): recurring run-rate ÷ 12, one-off spike at full literal —
  // `(runRate − spike)/12 + spike`. The `*Base` fields are inflation-neutral
  // (today's dollars). One entry per projection month.
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

  // HSA medical-demand base: the `isMedical`-flagged categories' subset
  // of `monthlyExpenseBase`, in today's dollars, with the medical effective rate
  // so the MC engine inflates it per path the same way the matching expense is
  // inflated (keeping it a strict subset). Absent when no category is flagged.
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
  // When every non-general-rate expense is outside the projection window,
  // buildWindowedBuckets returns undefined. Omit the field so the kernel's
  // `!== undefined` gate takes the scalar path instead of a zero-bucket branch.
  if (monthlyExpenseBucketsBase === undefined) return { monthlyExpenseBase, ...medical };
  return { monthlyExpenseBase, monthlyExpenseBucketsBase, ...medical };
}

/** Inputs shared by the medical base builders. */
interface MedicalBaseArgs {
  runArgs: RunBalanceProjectionArgs;
  resolvedExpenses: ReturnType<typeof resolveExpensesForScenario>;
  baseCtx: Parameters<typeof projectExpensesByCategoryMonth>[1];
  yearRange: { from: number; to: number };
  inflation: ReturnType<typeof resolveInflationForScenario>;
  generalRate: number;
  stepCount: number;
}

/**
 * Per-month today's-dollar HSA medical-demand base — the `isMedical`
 * subset of `monthlyExpenseBase`, summed from the SAME category-month projection
 * with the identical `(recurring − spike)/12 + spike` monthly bucketing. Returns
 * `{}` (no fields) when no category is flagged `isMedical`. The
 * `medicalDemandRatePct` is the effective inflation rate the medical categories
 * grow at (their `categoryRates` entry, falling back to the general rate) so the
 * MC engine inflates the demand by the matching CPI and the inflated series
 * stays a subset of the inflated expense.
 */
export function computeMedicalDemandBase(args: MedicalBaseArgs): {
  monthlyMedicalDemandBase?: number[];
  medicalDemandRatePct?: number;
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
} {
  // Pre-filter to HSA-qualified medical rows using the SINGLE-SOURCE
  // predicate (isHsaQualifiedMedical) — same gate the deterministic builder uses.
  // Absent hsaQualified ⇒ not qualified.
  const series = computeMedicalBaseSeries(args, isHsaQualifiedMedical, 'monthlyMedicalDemandBase');
  if (series === null) return {};
  return {
    monthlyMedicalDemandBase: series.base,
    medicalDemandRatePct: series.ratePct,
    ...(series.buckets !== undefined ? { monthlyMedicalDemandBucketsBase: series.buckets } : {}),
  };
}

/**
 * The same base for EVERY `isMedical` row, HSA-qualified or not: the cap on the
 * ACA credit applied to premiums. Built by the one routine the HSA demand uses
 * with the predicate switched, so windowing, monthly bucketing and rounding are
 * identical. Buckets are sorted by rate so the serialized input (and its cache
 * key) does not depend on category order.
 */
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

/** One medical base series: the scalar base, the single shared rate, and the
 *  per-rate buckets when the admitted categories span more than one rate. */
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
  // Filtering before projectExpensesByCategoryMonth preserves the per-rate byRate
  // binning and the strict-subset invariant.
  const qualifiedExpenses = resolvedExpenses.filter((e) => qualifies(e, medicalIds));
  if (qualifiedExpenses.length === 0) return null;
  const points = projectExpensesByCategoryMonth(qualifiedExpenses, baseCtx, yearRange);
  const base = new Array<number>(stepCount).fill(0);
  // Group the per-category medical charge by each category's OWN effective
  // rate so a multi-rate medical set inflates each sub-series at its own rate
  // (mirrors `buildWindowedBuckets`). When every medical category shares one
  // rate this collapses to one bucket and we emit only the scalar base (the
  // single-rate path).
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
  // The single shared rate is the rate of the sole NONZERO-demand bucket
  // (`byRate` only records rates with positive in-window monthly demand). Using
  // the first FLAGGED id's rate unconditionally would inflate the real demand at
  // the wrong CPI when that first-iterated category carried a non-general rate
  // override but ZERO in-window spend — the inflated medical series could then
  // exceed the inflated medical expense, breaking the strict-subset invariant.
  // Fall back to the first-flagged-id rate only when `byRate` is empty (all-zero
  // demand), where the scalar base is itself all-zero so the rate is inert.
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
  // Multi-rate medical set → emit per-rate buckets so each sub-series inflates
  // at its own rate. Single-rate → omit the bucketed field (scalar path).
  if (byRate.size > 1) {
    const buckets = [...byRate.entries()].map(([ratePct, amount]) => {
      assertExpenseBaseLength(amount, stepCount, `${label.replace('Base', 'BucketsBase')}[${ratePct}]`);
      return { ratePct, amount };
    });
    return { base, ratePct: medicalRate, buckets };
  }
  return { base, ratePct: medicalRate };
}

/** Per-effective-rate per-month buckets. Regroups the per-category
 *  today's-dollar monthly amounts by each category's effective rate, then
 *  per-step residual-adjusts the last bucket so `Σ_b amount_b[i] ===
 *  monthlyExpenseBase[i]` at round2 cent precision (additive residual bounded
 *  by `N_buckets × ½¢`/month; no catastrophic cancellation). */
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
  // Per-category today's-dollar monthly amounts (inflation-neutral baseCtx → the
  // `byCategoryId` values ARE today's dollars; per-category windowing inherited).
  const categoryPoints: ExpenseCategoryMonthlyPoint[] = projectExpensesByCategoryMonth(
    args.resolvedExpenses,
    baseCtx,
    yearRange,
  );
  // Group categories by effective rate. Each bucket holds a per-month array of
  // the TRUE per-month charge: the per-category run-rate ($/yr) converted via
  // the `monthlyBucket` rule (recurring ÷ 12, one-off spike at full literal).
  // `baseCtx` pins inflation to 0%, so the per-category `byCategoryId` /
  // `oneOffByCategoryId` ARE today's dollars (nominal == base).
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
  // Guard: if every non-general-rate expense falls outside the projection
  // window, no month contributes any entry to `byRate` → empty buckets.
  // Return undefined so the caller omits the field entirely; the kernel's
  // `!== undefined` gate then takes the scalar path (not the bucketed branch
  // with an empty loop that would zero all expenses).
  if (buckets.length === 0) return undefined;
  // Per-step residual-adjust: pin `Σ_b amount_b[i] === monthlyExpenseBase[i]`
  // (round2 cents) on the LAST bucket. Skip a zero-target month (no-op).
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

/** Construction-time guard: per-month expense base arrays must equal the
 *  kernel `stepCount` and carry only finite values (the boundary `throw`
 *  mirrors the `runMonteCarlo` length guard — no silent `?? 0`). */
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

/** Convert an ANNUALIZED run-rate ($/yr, with a one-off spike carried at its
 *  FULL literal amount) into the TRUE per-month dollar charge: the recurring
 *  run-rate spreads ÷ 12, the one-off spike enters whole in its month —
 *  `(runRate − spike)/12 + spike` (same `monthlyBucket` math the cashflow
 *  band uses, with the inflation factor `f = 1` since the base is today's
 *  dollars). */
function monthlyChargeFromRunRate(runRate: number, spike: number): number {
  return (runRate - spike) / 12 + spike;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pre-computed SS year array. Delegates to the authoritative
 *  `buildSsContext` + `projectSsByYear` pair so MC and deterministic
 *  engines share one SS implementation. `ssOverride?.colaPct`
 *  propagates; the secondary member defaults to FRA-67 when no
 *  explicit claim age override exists. */
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

/** SS year array for an explicit primary/secondary claim-age pair, reusing
 *  the resolved scenario's COLA + benefit-reduction + life-expectancy
 *  settings. Optimizer fast path: the per-scenario invariant MC input is
 *  built once via the shared pipeline; only this candidate-sensitive
 *  `ssByYear` slice is recomputed and swapped per claim-age pair, so the
 *  optimizer never re-runs the full BPP pipeline per candidate. Parity is
 *  guaranteed because this is the SAME `buildSsContext` + `projectSsByYear`
 *  pair `computeSsByYear` uses — claim age is the ONLY SS-overlay input that
 *  varies across optimizer candidates.
 *
 *  The SS context built here carries no earned income, so Monte Carlo skips
 *  the Social Security earnings test end to end; the deterministic projection
 *  applies it (see docs/math-social-security-and-health.md, "The earnings
 *  test"). */
export function computeSsByYearForClaimAges(args: {
  runArgs: RunBalanceProjectionArgs;
  ctx: PipelineContext;
  horizonYears: number;
  claimAgePrimary: { ageYears: number; ageMonths: number };
  claimAgeSecondary?: { ageYears: number; ageMonths: number };
  /**
   * Per-member SURVIVOR claim ages carried by the candidate overlay.
   * Absent (`undefined`) → the resolved scenario's stored `survivor`
   * section applies — the exact semantics of the deterministic path's
   * `withCandidateOverlay` (an overlay without a survivor field preserves
   * the stored section), so MC ranks the same plan the deterministic
   * optimizer simulated. An overlay-carried age is always the
   * VERBATIM stored value (the grid never transforms one), so this and the
   * stored-section fallback can never disagree on an in-window age.
   */
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
      // SEPARATE survivor claim ages — the candidate overlay's ages when
      // carried, else the resolved override's stored section. Absent
      // → the shared engine withholds survivor-dependent results,
      // keeping MC and deterministic outputs consistent.
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

/** Non-SS income year array built via the authoritative
 *  `projectIncomeByYear` helper — honours pension `monthlyBenefit`,
 *  COLA, J&S survivor, and part-time start/end windows. Returns
 *  `spendable.total` per year (deposits route separately via the
 *  deterministic deposit-event path). */
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
    // Carry the post-primary pre/post split through re-anchoring so the
    // bundle ledger / per-account engine route each slice to the right bucket.
    ...(e.amountPre !== undefined ? { amountPre: e.amountPre } : {}),
    ...(e.amountPost !== undefined ? { amountPost: e.amountPost } : {}),
    accountId: e.accountId,
  }));
}
