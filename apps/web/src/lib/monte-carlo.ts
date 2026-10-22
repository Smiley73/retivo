/** Monte Carlo runner: drives N paths through the shared monthly kernel, sampling returns and CPI from the Shiller + Ken French dataset (1950-01 onward) and applying each tuple to every account's own `assetMix`; outputs household percentiles (P10/P25/P50) and depletion / ending-balance stats.
 * The model is explained in docs/math-projections.md ("The Monte Carlo stress test"). */
import {
  runStepKernel,
  type KernelAccount,
  type StepInputs,
} from './projection-engine/kernel.js';
import {
  runYearByYearStrategyAware,
  type RunYearByYearArgs,
  type GuardrailRuntimeContext,
} from './drawdown-engine-per-account-strategy.js';
import {
  fundedRatio,
  applyGuardrailStep,
  initGuardrailState,
  type GuardrailConfig,
} from './guardrails.js';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  RmdContextInput,
  QcdContextInput,
} from './drawdown-engine-types.js';
import { isInheritedRmdSubjectType, isQualifyingAccount } from './rmd.js';
import {
  buildMagiCapConfig,
} from './drawdown-engine-per-account-magi-cap.js';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers.js';
import {
  compareMagiCapWindows,
  resolveQcdLimitCentsForYear,
} from './balance-projection-runner-drawdown.js';
import { DEFAULT_INFLATION_PCT } from '../db/types.js';
import {
  advanceAfterTaxBase,
  applyPerYearTaxForPath,
  applyPerYearTaxForPathWithConversion,
  buildKernelWholePortfolioPreTaxByOwner,
  buildPreTaxCentsByOwnerIdx,
  buildPriorPreTaxByOwnerFromIdx,
  buildSurvivorStatesByYear,
  buildYearClassification,
  classifyMcWithdrawal,
  creditMcConversionToBasisCarrier,
  deriveMcSurvivors,
  seedMcAggregateRothBasisCarrier,
  MC_AGGREGATE_ROTH_OWNER_KEY,
  type AfterTaxBaseState,
  type McAccountYearState,
  type McAccountYearWithdrawal,
  type McLedgerTaxMeta,
  seedMcDesignatedRothPool,
  mcDesignatedRothPoolBalanceDollars,
  type McDesignatedRothPool,
  type McSurvivorState,
  type McTaxAccumulators,
  type McTaxYearResult,
} from './monte-carlo-tax.js';
import {
  buildMcFactRmdRequiredCentsByOwnerIdx,
  type McRmdBalanceCents,
} from './monte-carlo-rmd.js';
import type { RothBasisCarrier } from './balance-projection-runner-roth-basis.js';
import type { StepOutcome } from './projection-engine/kernel.js';
import { buildMcFillConversionHook } from './monte-carlo-fill-conversion.js';
import { foldYearDrawIntoExpense, sumPositiveNeed } from './credit-applied-to-premiums.js';
import {
  runPathRange,
  mergePathRanges,
  assembleAccumulationFromTyped,
} from './monte-carlo-shard.js';
import { assembleMonteCarloSummary } from './monte-carlo-summary.js';
import {
  buildStepInputs,
  computeYearSums,
  cpiShiftMonthlyFor,
} from './monte-carlo-step-inputs.js';
export type { McTaxContext } from './monte-carlo-tax.js';
export type {
  MonteCarloAccountLedger,
  MonteCarloInput,
  McRmdContext,
  McQcdContext,
  MonteCarloSummary,
  McBasis,
  RepresentativeRun,
} from './monte-carlo-types.js';
import type {
  MonteCarloInput,
  MonteCarloSummary,
  RepresentativeRun,
} from './monte-carlo-types.js';
import type { FilingUnitMagi } from './tax-integration.js';
import { allocateCentsByWeight } from './tax-integration.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';

/** Version stamp on every saved Monte Carlo result; a cached summary with a lower version is recomputed on read. Bump it with any change that affects the math (byte-identical output means no bump).
 *  The AGENTS.md "ENGINE_VERSION bump — required companion edits" checklist lists everything a bump updates. */
export const ENGINE_VERSION = 73;

interface PathOutcome {
  readonly balanceByYearNominal: number[];
  readonly balanceByYearReal: number[];
  readonly depletionYear: number | null;
  readonly endingBalanceNominal: number;
  readonly endingBalanceReal: number;
  // Per-year tax series in dollars (`effectiveTaxRateByYear` is 0..1), defined when `taxContext` is present.
  readonly federalTaxByYear?: number[];
  readonly irmaaSurchargeByYear?: number[];
  readonly acaPtcSubsidyByYear?: number[];
  readonly acaCreditAppliedToPremiumsByYear?: number[];
  readonly effectiveTaxRateByYear?: number[];
  readonly netAfterTaxByYear?: number[];
  // Populated only when the path is replayed under `captureRun`, so the hot per-path sweep allocates nothing extra; `seed` is filled by the caller.
  readonly representative?: Omit<RepresentativeRun, 'seed'>;
}

/** Seed-independent per-run values shared by all paths, so they are not rebuilt 10,000x a run. `legacyZero` is a read-only zero array backing the kernel's unused single-pool placeholder inputs; both kernel branches only read it. */
export interface RunContext {
  readonly stepCount: number;
  readonly legacyZero: Float64Array;
  readonly cpiShiftMonthly: number;
  readonly deterministicCumCpi: Float64Array;
  readonly baseExpenseYearSums: Float64Array;
  readonly bucketBaseYearSums: Float64Array[] | null;
  readonly medicalBucketShiftPct: number[] | null;
  readonly ledgerTaxMeta: McLedgerTaxMeta[];
  readonly survivorStateByYear: ReadonlyArray<McSurvivorState | null> | null;
}

/** Computes the per-run shared context once. `legacyZero` is shared only when the per-account branch will run; for an empty ledger the single-pool branch reads it, so a fresh zero array is allocated per path (see `assembleStepInputs`). */
export function buildRunContext(input: MonteCarloInput): RunContext {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const stepCount = horizonYears * 12;
  const legacyZero =
    input.accountMcLedger.length > 0
      ? new Float64Array(stepCount)
      : new Float64Array(0);

  const scenarioMonthlyInflation =
    (input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT) / 100 / 12;
  const deterministicCumCpi = new Float64Array(stepCount);
  let detCum = 1;
  for (let i = 0; i < stepCount; i += 1) {
    detCum *= 1 + scenarioMonthlyInflation;
    deterministicCumCpi[i] = detCum;
  }

  const baseExpenseYearSums = computeYearSums(input.monthlyExpenseBase, stepCount, horizonYears);
  const bucketBaseYearSums = input.monthlyExpenseBucketsBase
    ? input.monthlyExpenseBucketsBase.map((b) => computeYearSums(b.amount, stepCount, horizonYears))
    : null;

  const generalRatePct = input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT;
  const medicalBucketShiftPct = input.monthlyMedicalDemandBucketsBase
    ? input.monthlyMedicalDemandBucketsBase.map((b) => (b.ratePct - generalRatePct) / 12)
    : null;

  const survivorStateByYear = input.taxContext
    ? buildSurvivorStatesByYear(input.taxContext, input.firstYear, horizonYears, input.retirementYear)
    : null;

  return {
    stepCount,
    legacyZero,
    cpiShiftMonthly: cpiShiftMonthlyFor(input),
    deterministicCumCpi,
    baseExpenseYearSums,
    bucketBaseYearSums,
    medicalBucketShiftPct,
    ledgerTaxMeta: ledgerTaxMeta(input),
    survivorStateByYear,
  };
}

interface PathTaxAcc {
  fedTax: number[];
  irmaa: number[];
  ptc: number[];
  credit: number[];
  etr: number[];
  net: number[];
}

function newPathTaxAcc(horizonYears: number): PathTaxAcc {
  return {
    fedTax: new Array<number>(horizonYears).fill(0),
    irmaa: new Array<number>(horizonYears).fill(0),
    ptc: new Array<number>(horizonYears).fill(0),
    credit: new Array<number>(horizonYears).fill(0),
    etr: new Array<number>(horizonYears).fill(0),
    net: new Array<number>(horizonYears).fill(0),
  };
}

function resetPathTaxAcc(acc: PathTaxAcc): void {
  acc.fedTax.fill(0);
  acc.irmaa.fill(0);
  acc.ptc.fill(0);
  acc.credit.fill(0);
  acc.etr.fill(0);
  acc.net.fill(0);
}

function ledgerTaxMeta(input: MonteCarloInput): McLedgerTaxMeta[] {
  const exemptIds = new Set(
    input.taxContext?.earlyWithdrawalPenaltyExemptAccountIds ?? [],
  );
  const rmdFacts = input.mcRmdContext?.rmdFactsByAccountId;
  return input.accountMcLedger.map((e) => ({
    taxTreatment: e.taxTreatment,
    accountType: e.accountType,
    ...(exemptIds.has(e.id) ? { scenarioPenaltyExempt: true } : {}),
    // §72(t)(2)(A)(ii): an inherited account's distribution carries no 10% additional tax at any beneficiary age; pre-resolved per source so the pooled penalty leg excludes those dollars.
    ...(rmdFacts?.[e.id]?.inheritedAccount === true
      ? { deathExemptInherited: true }
      : {}),
  }));
}

// Each account's withdrawal summed over year `y`'s 12 steps plus its start-of-year pre/post buckets (from the prior year-end, or the initial buckets for y=0); `undefined` when the kernel ran the single-pool branch (all-pre-tax fallback).
function accountYearStates(
  input: MonteCarloInput,
  out: StepOutcome,
  y: number,
  stepCount: number,
): McAccountYearState[] | undefined {
  const accW = out.accountWithdrawal;
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  if (!accW || !accPre || !accPost) return undefined;
  const firstStep = y * 12;
  const lastStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
  const priorStep = firstStep - 1; // year start = prior year-end.
  return input.accountMcLedger.map((entry, a) => {
    let withdrawalDollars = 0;
    for (let s = firstStep; s <= lastStep; s += 1) withdrawalDollars += accW[a][s];
    const preBalanceStartDollars =
      priorStep >= 0 ? accPre[a][priorStep] : entry.initialPre;
    const postBalanceStartDollars =
      priorStep >= 0 ? accPost[a][priorStep] : entry.initialPost;
    return { withdrawalDollars, preBalanceStartDollars, postBalanceStartDollars };
  });
}

export interface TaxPathContext {
  readonly input: MonteCarloInput;
  /** The kernel outcome, or `null` on the strategy path when the kernel was skipped (already retired) or truncated. Read only on the no-ledger kernel path, where it is always non-null; the reader throws on null. */
  readonly out: StepOutcome | null;
  readonly stepCount: number;
  readonly meta: McLedgerTaxMeta[];
  readonly acc: PathTaxAcc;
  /** Per-year same-year tax cashflow (nominal dollars) subtracted from balances; negative when the credit applied to premiums exceeds the tax need. */
  readonly taxDrawByYear: number[];
  readonly rothBasisCarrier: RothBasisCarrier;
  /** Pooled designated-Roth state, seeded fresh per path; a mutable object (not reassigned) so the pass-2 reseed can restore it in place; `null` without designated-Roth facts. */
  designatedRothPool: McDesignatedRothPool | null;
  readonly nominalExpenseByYear: Float64Array;
  readonly nominalMedicalExpenseByYear: Float64Array;
  readonly drawNeedByYear?: Float64Array;
  readonly survivorStateByYear: ReadonlyArray<McSurvivorState | null> | null;
}

interface MagiRing {
  minus2: number | undefined;
  minus1: number | undefined;
  /** The same two look-back years per tax unit, so each of the surcharge year's returns is tiered on its own look-back MAGI and schedule (a mixed `MFS`+`HoH` couple does not share one ladder). */
  unitsMinus2: readonly FilingUnitMagi[] | undefined;
  unitsMinus1: readonly FilingUnitMagi[] | undefined;
}

function applyTaxForYear(
  ctx: TaxPathContext,
  y: number,
  _endStep: number,
  priorBalance: number,
  magi: MagiRing,
): void {
  const { input, out } = ctx;
  // `out` is null only on the strategy path; this reader runs on the no-ledger kernel path, so throw loudly if that invariant breaks.
  if (out === null) throw new Error('taxState.out required on the kernel path');
  const classification = buildYearClassification(
    ctx.meta,
    accountYearStates(input, out, y, ctx.stepCount),
  );
  const taxYear = input.firstYear + y;
  // Use the precomputed survivor state: `?.[y].survivors` would throw out of bounds and `??` would re-derive a legitimately precomputed `null` (nobody alive).
  const survivorState = ctx.survivorStateByYear
    ? ctx.survivorStateByYear[y]
    : deriveMcSurvivors(input.taxContext!, taxYear, input.retirementYear);
  const priorPreTaxByOwner =
    survivorState === null
      ? new Map<string, number>()
      : buildKernelWholePortfolioPreTaxByOwner(
          survivorState.survivors,
          priorBalance,
          taxYear,
          input.taxContext!.taxBundle.rmd,
        );
  const taxResult = applyPerYearTaxForPath({
    taxCtx: input.taxContext!,
    taxYear,
    retirementYear: input.retirementYear,
    grossSsDollars: input.ssByYear[y] ?? 0,
    nominalExpense: ctx.nominalExpenseByYear[y] ?? 0,
    medicalExpenseDollars: ctx.nominalMedicalExpenseByYear[y] ?? 0,
    otherIncome: input.incomeByYear[y] ?? 0,
    priorBalance,
    priorPreTaxByOwner,
    magiMinus2: magi.minus2,
    irmaaLookbackUnitsMinus2: magi.unitsMinus2,
    classification,
    rothBasisCarrier: ctx.rothBasisCarrier,
    // The no-ledger fallback has no per-account balances, so the pool uses its own running balance as the pro-rata denominator.
    ...(ctx.designatedRothPool !== null
      ? { designatedRothPool: ctx.designatedRothPool }
      : {}),
    survivorState,
  });
  if (taxResult === null) return;
  accumulatePerYearTaxResult(ctx.acc, ctx.taxDrawByYear, y, taxResult, magi);
}

function accumulatePerYearTaxResult(
  acc: PathTaxAcc,
  taxDrawByYear: number[],
  y: number,
  taxResult: McTaxYearResult,
  magi: MagiRing,
  // MAGI for the look-back ring: the funded result's by default; the Fill strategy path passes the conversion-inclusive MAGI so the conversion's Y+2 surcharge is funded though the funded tax excludes it.
  magiForRingDollars: number = taxResult.magiDollars,
): void {
  acc.fedTax[y] = taxResult.fedTax;
  acc.irmaa[y] = taxResult.irmaa;
  acc.ptc[y] = taxResult.ptc;
  acc.credit[y] = taxResult.acaCreditAppliedToPremiums;
  acc.etr[y] = taxResult.effectiveTaxRate;
  acc.net[y] = taxResult.netAfterTax;
  taxDrawByYear[y] = taxResult.taxCashflowDollars;
  magi.minus2 = magi.minus1;
  magi.minus1 = magiForRingDollars;
  magi.unitsMinus2 = magi.unitsMinus1;
  // The per-return ring must carry the scalar ring's total; on the Fill path the per-unit figures come from the conversion-exclusive funded result, so rescale them (the conversion has no per-return attribution in MC).
  magi.unitsMinus1 = rescaleUnitMagiToTotal(taxResult.filingUnitMagi, magiForRingDollars);
}

// Exact to the cent by largest remainder (`allocateCentsByWeight`): rounding independently let equal returns of an odd-cent total drift a cent above the household ring, which becomes the IRMAA look-back, where a cent across a tier threshold moves the household onto a higher surcharge for the whole year.
function rescaleUnitMagiToTotal(
  units: readonly FilingUnitMagi[],
  totalDollars: number,
): readonly FilingUnitMagi[] {
  if (units.length === 0) return units;
  const targetCents = Math.round(totalDollars * 100);
  const currentCents = units.reduce((sum, u) => sum + u.magiCents, 0);
  if (currentCents === targetCents) return units;
  if (units.length === 1) return [{ ...units[0], magiCents: targetCents }];
  const weights = units.map((u) => (currentCents > 0 ? u.magiCents : 1));
  const rescaled = allocateCentsByWeight(targetCents, weights);
  return units.map((u, index) => ({ ...u, magiCents: rescaled[index] }));
}

/** Builds the per-path tax state when a `taxContext` is present, else null. */
export function newTaxPathState(
  input: MonteCarloInput,
  out: StepOutcome | null,
  stepCount: number,
  horizonYears: number,
  nominalExpenseByYear: Float64Array,
  nominalMedicalExpenseByYear: Float64Array,
  ctx: RunContext,
  drawNeedByYear?: Float64Array,
): TaxPathContext | null {
  if (input.taxContext === undefined) return null;
  return {
    input,
    out,
    stepCount,
    meta: ctx.ledgerTaxMeta,
    acc: newPathTaxAcc(horizonYears),
    taxDrawByYear: new Array<number>(horizonYears).fill(0),
    rothBasisCarrier: seedMcAggregateRothBasisCarrier(
      input.taxContext.rothBasisCentsByOwner,
      input.taxContext.rothOrderedProfile,
    ),
    designatedRothPool:
      seedMcDesignatedRothPool(input.taxContext.rothOrderedProfile) ?? null,
    nominalExpenseByYear,
    nominalMedicalExpenseByYear,
    ...(drawNeedByYear !== undefined ? { drawNeedByYear } : {}),
    survivorStateByYear: ctx.survivorStateByYear,
  };
}

/** Fills the per-year nominal/real balance arrays and, with a `taxContext`, runs the per-year tax estimate in one forward pass: the synthetic RMD account's prior-year base is the prior year's after-tax balance, tracked incrementally and absorbing (`advanceAfterTaxBase`) so a raw pre-tax recovery never revives a depleted base. No within-year fixpoint. */
export function fillYearBalancesAndTax(
  out: StepOutcome,
  balanceByYearNominal: number[],
  balanceByYearReal: number[],
  stepCount: number,
  taxState: TaxPathContext | null,
): void {
  const horizonYears = balanceByYearNominal.length;
  // Seed the ring from the MAGI bootstrap so projection years 0 and 1 charge IRMAA as the deterministic engine does; without one both slots stay undefined and MC charges $0 IRMAA for those years.
  const magi: MagiRing = {
    minus2: taxState?.input.taxContext?.magiBootstrapLookbackMinus2,
    minus1: taxState?.input.taxContext?.magiBootstrapLookbackMinus1,
    // The bootstrap years carry a household MAGI only, so the per-return ring starts empty and units fall back to that scalar until two projection years are filed.
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  let cumTax = 0;
  let baseState: AfterTaxBaseState = { base: 0, depleted: false };
  for (let y = 0; y < horizonYears; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const nominal = out.preEnd[endStep] + out.postEnd[endStep];
    balanceByYearNominal[y] = nominal;
    balanceByYearReal[y] = nominal / out.cumCpi[endStep];
    if (!taxState) continue;
    // Year 0's RMD base is today's portfolio (the deterministic engine's prior-year-balance rule); later years use the absorbing after-tax balance.
    const priorBalance = y === 0 ? taxState.input.portfolioToday : baseState.base;
    applyTaxForYear(taxState, y, endStep, priorBalance, magi);
    cumTax += taxState.taxDrawByYear[y];
    baseState = advanceAfterTaxBase(baseState, nominal, cumTax);
  }
}

function buildKernelAccountBalances(
  input: MonteCarloInput,
  out: StepOutcome,
  y: number,
  endStep: number,
  stepCount: number,
): ReadonlyMap<string, DrawdownAccountYear> | undefined {
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  const accW = out.accountWithdrawal;
  if (!accPre || !accPost || !accW) return undefined;
  // Per-account medical-qualified HSA dollars, giving the row the same medical/emergency split as the deterministic path.
  const accMed = out.accountMedicalQualifiedWithdrawal;
  // The per-account pre/post split makes the MIXED shortfall derivation exact (not the total-`withdrawn` proxy).
  const accPreW = out.accountPreWithdrawn;
  const accPostW = out.accountPostWithdrawn;
  const firstStep = y * 12;
  const lastStep = Math.min(stepCount - 1, endStep);
  const map = new Map<string, DrawdownAccountYear>();
  input.accountMcLedger.forEach((entry, a) => {
    let withdrawn = 0;
    let medical = 0;
    let preWithdrawnSum = 0;
    let postWithdrawnSum = 0;
    for (let s = firstStep; s <= lastStep; s += 1) {
      withdrawn += accW[a][s];
      medical += accMed?.[a]?.[s] ?? 0;
      preWithdrawnSum += accPreW?.[a]?.[s] ?? 0;
      postWithdrawnSum += accPostW?.[a]?.[s] ?? 0;
    }
    const preEnd = accPre[a][endStep];
    const postEnd = accPost[a][endStep];
    const priorEndStep = endStep - 12;
    const priorPreEnd =
      priorEndStep >= 0 ? (accPre[a][priorEndStep] ?? entry.initialPre) : entry.initialPre;
    // Cap medical-qualified cents at the committed withdrawal so the emergency residual stays >= 0 and buckets reconcile to the cent.
    const withdrawnCents = Math.round(withdrawn * 100);
    const medicalCents = entry.accountType === 'HSA' && medical > 0
      ? Math.min(withdrawnCents, Math.round(medical * 100))
      : 0;
    const hasSplit = accPreW != null;
    const preWithdrawnCents = hasSplit ? Math.round(preWithdrawnSum * 100) : undefined;
    const postWithdrawnCents = hasSplit ? Math.round(postWithdrawnSum * 100) : undefined;
    map.set(entry.id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn,
      deposit: 0,
      priorPreEnd,
      ...(preWithdrawnCents !== undefined ? { preWithdrawnCents, postWithdrawnCents } : {}),
      ...(medicalCents > 0 ? { medicalQualifiedWithdrawnCents: medicalCents } : {}),
    });
  });
  return map;
}

function buildKernelAccumulationBalances(
  input: MonteCarloInput,
  out: StepOutcome,
  endStep: number,
): ReadonlyMap<string, DrawdownAccountYear> | undefined {
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  if (!accPre || !accPost) return undefined;
  const map = new Map<string, DrawdownAccountYear>();
  input.accountMcLedger.forEach((entry, a) => {
    const preEnd = accPre[a][endStep];
    const postEnd = accPost[a][endStep];
    map.set(entry.id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn: 0,
      deposit: 0,
    });
  });
  return map;
}

function captureKernelRun(
  input: MonteCarloInput,
  out: StepOutcome,
  stepCount: number,
  taxAcc: PathTaxAcc | null,
  retStart: number,
): Omit<RepresentativeRun, 'seed'> {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const years: DrawdownYear[] = new Array(horizonYears);
  const realBalanceByYear: number[] = new Array(horizonYears).fill(0);
  const realGrowthByYear: number[] = new Array(horizonYears).fill(0);
  const realFactorByYear: number[] = new Array(horizonYears).fill(0);
  const accumulationAccountBalances: {
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }[] = [];
  for (let y = 0; y < horizonYears; y += 1) {
    let growth = 0;
    let withdrawn = 0;
    let expense = 0;
    let income = 0;
    let deposit = 0;
    for (let m = 0; m < 12; m += 1) {
      const i = y * 12 + m;
      if (i >= stepCount) break;
      growth += out.growth[i];
      withdrawn += out.withdrawal[i];
      expense += out.expense[i];
      income += out.income[i];
      // `deposit` carries accumulation contributions plus drawdown lump-sum deposits (neither is a withdrawal), keeping `balance = prior + growth - withdrawn + deposit` exact in both phases.
      deposit += out.deposit[i] + out.contributions[i];
    }
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const balance = out.preEnd[endStep] + out.postEnd[endStep];
    const cpi = out.cumCpi[endStep] || 1;
    const netNeed = Math.max(0, expense - income);
    const depleted = withdrawn < netNeed - 1e-6;
    const row: DrawdownYear = {
      year: input.firstYear + y,
      balance,
      withdrawn,
      netNeed,
      growth,
      deposit,
      depleted,
    };
    if (taxAcc) {
      row.federalTaxCents = Math.round((taxAcc.fedTax[y] ?? 0) * 100);
      row.irmaaSurchargeCents = Math.round((taxAcc.irmaa[y] ?? 0) * 100);
      row.acaPtcSubsidyCents = Math.round((taxAcc.ptc[y] ?? 0) * 100);
      row.acaCreditAppliedToPremiumsCents = Math.round((taxAcc.credit[y] ?? 0) * 100);
    }
    if (y * 12 >= retStart) {
      const accountBalances = buildKernelAccountBalances(
        input,
        out,
        y,
        endStep,
        stepCount,
      );
      if (accountBalances) row.accountBalances = accountBalances;
    } else {
      const accBalances = buildKernelAccumulationBalances(input, out, endStep);
      if (accBalances) {
        accumulationAccountBalances.push({
          year: input.firstYear + y,
          accountBalances: accBalances,
        });
      }
    }
    years[y] = row;
    realBalanceByYear[y] = balance / cpi;
    realGrowthByYear[y] = growth / cpi;
    realFactorByYear[y] = 1 / cpi;
  }
  const depletionYear =
    out.depletionStepIdx === -1
      ? null
      : input.firstYear + Math.floor(out.depletionStepIdx / 12);
  return {
    firstYear: input.firstYear,
    years,
    depletionYear,
    // The cashflow band indexes `perMonthWithdrawal` from the retirement year, so slice at the retirement-year whole-year boundary, as the deterministic runner does.
    perMonthWithdrawal: out.withdrawal.slice(Math.min(retStart, stepCount)),
    realBalanceByYear,
    realGrowthByYear,
    realFactorByYear,
    ...(accumulationAccountBalances.length > 0 ? { accumulationAccountBalances } : {}),
  };
}

function captureStrategyRun(
  input: MonteCarloInput,
  preRetYears: DrawdownYear[],
  retYears: DrawdownYear[],
  depletionYear: number | null,
  perMonthWithdrawal: Float64Array,
  cumCpi: Float64Array,
  stepCount: number,
  accumulationAccountBalances: ReadonlyArray<{
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>,
): Omit<RepresentativeRun, 'seed'> {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const years: DrawdownYear[] = [...preRetYears, ...retYears].slice(0, horizonYears);
  const realBalanceByYear: number[] = new Array(horizonYears).fill(0);
  const realGrowthByYear: number[] = new Array(horizonYears).fill(0);
  const realFactorByYear: number[] = new Array(horizonYears).fill(0);
  for (let y = 0; y < years.length; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const cpi = cumCpi[endStep] || 1;
    realBalanceByYear[y] = years[y].balance / cpi;
    realGrowthByYear[y] = years[y].growth / cpi;
    realFactorByYear[y] = 1 / cpi;
  }
  return {
    firstYear: input.firstYear,
    years,
    depletionYear,
    perMonthWithdrawal: perMonthWithdrawal.slice(),
    realBalanceByYear,
    realGrowthByYear,
    realFactorByYear,
    ...(accumulationAccountBalances.length > 0 ? { accumulationAccountBalances } : {}),
  };
}

type StrategyStartBuckets = Map<string, { pre: number; post: number }>;

function strategyYearWithdrawals(
  year: DrawdownYear,
  ledger: ReadonlyArray<MonteCarloInput['accountMcLedger'][number]>,
  startBuckets: StrategyStartBuckets,
  scenarioExemptIds: ReadonlySet<string>,
  deathExemptIds: ReadonlySet<string> = new Set(),
): McAccountYearWithdrawal[] {
  const accountBalances = year.accountBalances;
  return ledger.map((entry) => {
    const row = accountBalances?.get(entry.id);
    const start = startBuckets.get(entry.id) ?? { pre: 0, post: 0 };
    const result: McAccountYearWithdrawal = {
      taxTreatment: entry.taxTreatment,
      accountType: entry.accountType,
      withdrawalDollars: row?.withdrawn ?? 0,
      preBalanceStartDollars: start.pre,
      postBalanceStartDollars: start.post,
      ...(scenarioExemptIds.has(entry.id) ? { scenarioPenaltyExempt: true } : {}),
      ...(deathExemptIds.has(entry.id) ? { deathExemptInherited: true } : {}),
    };
    if (row !== undefined) startBuckets.set(entry.id, { pre: row.preEnd, post: row.postEnd });
    return result;
  });
}

// Only member-owned pre-tax accounts can carry an RMD, so an account owned by a non-member id gets no slot.
function mcOwnerIds(input: MonteCarloInput): string[] {
  return input.taxContext?.members.map((m) => m.memberId) ?? [];
}

// The year-0 basis uses `accountsIn[a].initialPre`, the kernel-accumulated drawdown-entry balance, not the ledger's today's `initialPre`, which understates it for a future-retirement scenario.
// Both sub-buckets pass through so `buildMcRmdAccountInput` nets the Roth-designated pocket (SECURE 2.0 §325) in the shared engine.
function buildEntryFactRmdRequiredCentsByOwnerIdx(
  input: MonteCarloInput,
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  ownerIds: ReadonlyArray<string>,
  firstDrawdownTaxYear: number,
): number[] | undefined {
  const facts = input.mcRmdContext?.rmdFactsByAccountId;
  const members = input.taxContext?.members ?? input.mcRmdContext?.members;
  const rmdSnapshot = input.taxContext?.taxBundle.rmd ?? input.mcRmdContext?.rmdSnapshot;
  if (facts === undefined || members === undefined || rmdSnapshot === undefined) {
    return undefined;
  }
  const priorBalancesCents = new Map<string, McRmdBalanceCents>();
  for (const acc of accountsIn) {
    priorBalancesCents.set(acc.id, {
      preCents: Math.round(acc.initialPre * 100),
      postCents: Math.round(acc.initialPost * 100),
    });
  }
  return buildMcFactRmdRequiredCentsByOwnerIdx({
    ledger: input.accountMcLedger,
    ownerIds,
    members,
    rmdSnapshot,
    // Year 0 of drawdown: entry balances are the Dec-31 prior-year base; with no two-years-prior base a first-year-deferral catch-up is reported as a blocker, not guessed.
    taxYear: firstDrawdownTaxYear,
    priorBalancesCents,
    rmdFactsByAccountId: facts,
    ...(input.mcRmdContext?.retirementYearByOwner !== undefined
      ? { retirementYearByOwner: input.mcRmdContext.retirementYearByOwner }
      : {}),
  });
}

function buildEntryPreTaxCentsByOwnerIdx(
  input: MonteCarloInput,
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  ownerIds: ReadonlyArray<string>,
): number[] {
  const idx = ownerIds.map(() => 0);
  const slotByOwner = new Map<string, number>();
  ownerIds.forEach((id, i) => slotByOwner.set(id, i));
  const entryPreById = new Map<string, number>();
  for (const acc of accountsIn) entryPreById.set(acc.id, acc.initialPre);
  // An account carrying RMD facts is excluded: it is computed per account through the shared engine, so leaving it in the pooled basis would double-count it.
  const rmdFacts = input.mcRmdContext?.rmdFactsByAccountId;
  for (const entry of input.accountMcLedger) {
    const treatment = entry.taxTreatment;
    const type = entry.accountType;
    if (treatment === undefined || type === undefined) continue;
    if (!isQualifyingAccount(type, treatment)) continue;
    if (rmdFacts?.[entry.id] !== undefined) continue;
    const entryPre = entryPreById.get(entry.id);
    if (entryPre === undefined) continue;
    const preTaxCents = Math.round(entryPre * 100);
    if (preTaxCents <= 0) continue;
    const slot = slotByOwner.get(entry.ownerId ?? entry.id);
    if (slot === undefined) continue;
    idx[slot] += preTaxCents;
  }
  return idx;
}

function rowBalancesCents(
  row: DrawdownYear | undefined,
): ReadonlyMap<string, McRmdBalanceCents> {
  const out = new Map<string, McRmdBalanceCents>();
  for (const [id, acct] of row?.accountBalances ?? []) {
    out.set(id, {
      preCents: Math.round(acct.preEnd * 100),
      postCents: Math.round(acct.postEnd * 100),
    });
  }
  return out;
}

// Facts-carrying accounts run through the shared `computeRmd` engine per owner, so the funded floor follows the real beneficiary schedule; required cents are stamped for row year + 1, since the next year's floor reads this row's Dec-31 balances.
function stampPreTaxCentsByOwnerIdx(
  years: DrawdownYear[],
  input: MonteCarloInput,
  ownerIds: ReadonlyArray<string>,
): void {
  const facts = input.mcRmdContext?.rmdFactsByAccountId;
  const members = input.taxContext?.members ?? input.mcRmdContext?.members;
  const rmdSnapshot = input.taxContext?.taxBundle.rmd ?? input.mcRmdContext?.rmdSnapshot;
  for (let i = 0; i < years.length; i += 1) {
    const row = years[i];
    row.preTaxCentsByOwnerIdx = buildPreTaxCentsByOwnerIdx(
      row.accountBalances,
      input.accountMcLedger,
      ownerIds,
      facts,
    );
    if (facts === undefined || members === undefined || rmdSnapshot === undefined) continue;
    if (row.accountBalances === undefined) continue;
    row.factRmdRequiredCentsByOwnerIdx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: input.accountMcLedger,
      ownerIds,
      members,
      rmdSnapshot,
      taxYear: row.year + 1,
      priorBalancesCents: rowBalancesCents(row),
      ...(i > 0 ? { twoYearsPriorBalancesCents: rowBalancesCents(years[i - 1]) } : {}),
      rmdFactsByAccountId: facts,
      ...(input.mcRmdContext?.retirementYearByOwner !== undefined
        ? { retirementYearByOwner: input.mcRmdContext.retirementYearByOwner }
        : {}),
    });
  }
}

// Index 0 is the drawdown-entry pre-tax map; index i is the prior committed year's per-owner pre-tax, so the committed pass-2 tax floor and the conversion solve floor share one source.
function buildPriorPreTaxByOwnerByYearIndex(
  years: ReadonlyArray<DrawdownYear>,
  entryIdx: readonly number[],
  ownerIds: ReadonlyArray<string>,
  entryFactRmdIdx?: readonly number[],
): ReadonlyMap<string, number>[] {
  const out: ReadonlyMap<string, number>[] = new Array(years.length);
  out[0] = buildPriorPreTaxByOwnerFromIdx(entryIdx, ownerIds, entryFactRmdIdx);
  for (let i = 1; i < years.length; i += 1) {
    out[i] = buildPriorPreTaxByOwnerFromIdx(
      years[i - 1].preTaxCentsByOwnerIdx,
      ownerIds,
      years[i - 1].factRmdRequiredCentsByOwnerIdx,
    );
  }
  return out;
}

/** Mutates `taxState.acc` / `taxState.taxDrawByYear`; `priorBalance` is the drawdown-entry total for year 0, the prior row's end balance afterwards. Exported for the shared-pass-1-QCD-offset pin in `monte-carlo-fill-conversion.test.ts`. */
export function fillStrategyYearTax(
  input: MonteCarloInput,
  retYears: DrawdownYear[],
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  preRetirementYears: number,
  taxState: TaxPathContext,
  // Fill mode only: the same prior-balance basis the conversion hook used, so the committed floor and the conversion solve's are one source. Omitted keeps this pass's running prior-year-end balance.
  priorBalanceByYearIndex: ReadonlyArray<number> | undefined,
  // Prior per-owner pre-tax basis for the RMD floor; required, since an empty map yields a $0 floor and so no phantom RMD income.
  priorPreTaxByOwnerByYearIndex: ReadonlyArray<ReadonlyMap<string, number>>,
  // Fill two-pass only: the QCD offset the conversion hook also used, derived once from pass-1 rows, so the committed floor and the conversion solve's stay one source; omitted reads this row's offset.
  qcdRmdOffsetByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>,
): void {
  const magi: MagiRing = {
    minus2: input.taxContext?.magiBootstrapLookbackMinus2,
    minus1: input.taxContext?.magiBootstrapLookbackMinus1,
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  const startBuckets: StrategyStartBuckets = new Map(
    accountsIn.map((acc) => [acc.id, { pre: acc.initialPre, post: acc.initialPost }]),
  );
  const scenarioExemptIds = new Set(
    input.taxContext?.earlyWithdrawalPenaltyExemptAccountIds ?? [],
  );
  const deathExemptIds = new Set(
    Object.entries(input.mcRmdContext?.rmdFactsByAccountId ?? {})
      .filter(([, facts]) => facts.inheritedAccount === true)
      .map(([id]) => id),
  );
  const entryTotal = accountsIn.reduce((sum, a) => sum + a.initialPre + a.initialPost, 0);
  let priorTotalBalance = entryTotal;
  for (let i = 0; i < retYears.length; i += 1) {
    const y = preRetirementYears + i;
    if (y >= taxState.acc.fedTax.length) break;
    // Read before `strategyYearWithdrawals` advances `startBuckets`: the pre-distribution balance the §402A(d)(4) pro rata divides by.
    const designatedRothPoolBalanceDollars =
      taxState.designatedRothPool !== null
        ? mcDesignatedRothPoolBalanceDollars(input.accountMcLedger, startBuckets)
        : 0;
    const classification = classifyMcWithdrawal(
      strategyYearWithdrawals(
        retYears[i],
        input.accountMcLedger,
        startBuckets,
        scenarioExemptIds,
        deathExemptIds,
      ),
    );
    // A committed Fill-mode conversion is ordinary income for the ring but must not enter the funded same-year tax, since the engine funds it separately (`fundConversionTaxForYear`): folding it in would double-fund it.
    // `applyPerYearTaxForPathWithConversion` returns the withdrawals-only funded result plus the conversion-inclusive MAGI. It is not a distribution, so it never feeds the pre-tax withdrawal (and the §72(t) penalty basis).
    const rothConvertedDollars = (retYears[i].rothConvertedCents ?? 0) / 100;
    const priorBalance =
      priorBalanceByYearIndex !== undefined
        ? (i <= 0 ? entryTotal : priorBalanceByYearIndex[i] ?? entryTotal)
        : priorTotalBalance;
    const taxOutcome = applyPerYearTaxForPathWithConversion({
      taxCtx: input.taxContext!,
      taxYear: input.firstYear + y,
      retirementYear: input.retirementYear,
      grossSsDollars: input.ssByYear[y] ?? 0,
      nominalExpense: taxState.nominalExpenseByYear[y] ?? 0,
      medicalExpenseDollars: taxState.nominalMedicalExpenseByYear[y] ?? 0,
      ...(taxState.drawNeedByYear !== undefined
        ? { drawNeedDollars: taxState.drawNeedByYear[y] ?? 0 }
        : {}),
      otherIncome: input.incomeByYear[y] ?? 0,
      additionalOrdinaryIncomeDollars: rothConvertedDollars,
      priorBalance,
      priorPreTaxByOwner: priorPreTaxByOwnerByYearIndex[i] ?? new Map<string, number>(),
      // The per-owner QCD offset comes from the shared pass-1 array in the Fill two-pass, else this row's stamped offset. It reduces the RMD floor so the gross-up never re-adds the QCD-satisfied RMD;
      // the gift itself is excluded once, structurally (`applyQcdPrePass` debits the IRA without recording a taxable withdrawal), so `qcdIncomeExclusionDollars` stays unset.
      ...(qcdRmdOffsetByYearIndex !== undefined
        ? (qcdRmdOffsetByYearIndex[i] !== undefined
            ? { qcdRmdOffsetCentsByOwner: new Map(qcdRmdOffsetByYearIndex[i]) }
            : {})
        : retYears[i].qcdRmdOffsetCentsByOwner !== undefined
          ? {
              qcdRmdOffsetCentsByOwner: new Map(
                Object.entries(retYears[i].qcdRmdOffsetCentsByOwner ?? {}),
              ),
            }
          : {}),
      magiMinus2: magi.minus2,
      irmaaLookbackUnitsMinus2: magi.unitsMinus2,
      classification,
      // Yield / basis / cash-interest inputs stay out of the funded tax, as in the deterministic funding solver, which keeps the cross-engine $1 ending-balance parity; they reach only the display surfaces.
      rothBasisCarrier: taxState.rothBasisCarrier,
      // Real designated-Roth pocket balance from the carried start buckets, so the pro-rata fraction is `remaining basis / current balance`, not a frozen snapshot.
      ...(taxState.designatedRothPool !== null
        ? {
            designatedRothPool: taxState.designatedRothPool,
            designatedRothPoolBalanceDollars,
          }
        : {}),
      survivorState: taxState.survivorStateByYear?.[y],
    });
    // Credit converted principal after this year's tax has consumed basis for this year's Roth withdrawals: conversions land at year-end, so they are basis only for later years.
    // Safe across passes since `reseedRothBasisCarrier` restarts the carrier before pass 2, which re-credits.
    // The credit is dated by tax year, so the principal carries its own five-taxable-year §408A(d)(3)(F) recapture window.
    creditMcConversionToBasisCarrier(
      taxState.rothBasisCarrier,
      retYears[i].rothConvertedCents ?? 0,
      input.firstYear + y,
    );
    // Only the non-shared (Minimize / no-cap) path reads the running prior-year-end balance.
    if (priorBalanceByYearIndex === undefined) priorTotalBalance = retYears[i].balance;
    if (taxOutcome === null) continue;
    accumulatePerYearTaxResult(
      taxState.acc,
      taxState.taxDrawByYear,
      y,
      taxOutcome.result,
      magi,
      taxOutcome.magiInclusiveDollars,
    );
  }
}

// `expense` is retirement-year-relative (index 0 = first retirement month), so year `y`'s monthly tax lands at `i*12 + m`; a negative draw (credit applied to premiums) follows each month's need.
function foldTaxIntoStrategyExpense(
  expense: Float64Array,
  income: Float64Array,
  taxDrawByYear: number[],
  preRetirementYears: number,
): void {
  for (let start = 0; start < expense.length; start += 12) {
    const y = preRetirementYears + start / 12;
    foldYearDrawIntoExpense(
      expense, income, start, Math.min(start + 12, expense.length), taxDrawByYear[y] ?? 0,
    );
  }
}

function drawNeedByYearFromSlice(
  expense: Float64Array,
  income: Float64Array,
  preRetirementYears: number,
  horizonYears: number,
): Float64Array {
  const needByYear = new Float64Array(horizonYears);
  for (let start = 0; start < expense.length; start += 12) {
    const y = preRetirementYears + start / 12;
    if (y >= horizonYears) break;
    needByYear[y] = sumPositiveNeed(expense, income, start, Math.min(start + 12, expense.length));
  }
  return needByYear;
}

// Resets the carrier in place before the pass-2 fill so §408A ordering restarts from full household basis (the field is readonly, so clear and re-seed the map).
function reseedRothBasisCarrier(taxState: TaxPathContext): void {
  const carrier = taxState.rothBasisCarrier;
  carrier.clear();
  const seeded = seedMcAggregateRothBasisCarrier(
    taxState.input.taxContext?.rothBasisCentsByOwner,
    taxState.input.taxContext?.rothOrderedProfile,
  );
  const entry = seeded.get(MC_AGGREGATE_ROTH_OWNER_KEY);
  if (entry !== undefined) carrier.set(MC_AGGREGATE_ROTH_OWNER_KEY, entry);
  // The pooled designated-Roth state is cumulative too; restart it from the full recorded basis and lots, or pass 2 would run against basis pass 1 already consumed and over-tax.
  taxState.designatedRothPool =
    seedMcDesignatedRothPool(taxState.input.taxContext?.rothOrderedProfile) ?? null;
}

// Carries the per-account RMD facts and separation years off `mcRmdContext` so the forced draw matches the MC tax floor; admission is inherited-aware (a household holding only inherited accounts still gets a context).
function buildStrategyRmdContext(input: MonteCarloInput): RmdContextInput | undefined {
  const taxCtx = input.taxContext;
  if (taxCtx === undefined || taxCtx.members.length === 0) return undefined;
  const rmdFactsByAccountId = input.mcRmdContext?.rmdFactsByAccountId;
  const retirementYearByOwner = input.mcRmdContext?.retirementYearByOwner;
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  taxCtx.members.forEach((m, idx) => {
    const deathYear = idx === 0 ? taxCtx.primaryDeathYear : taxCtx.secondaryDeathYear;
    // `RmdContextInput.deathYear` is a plain number (Infinity = alive every year).
    ownerMeta.set(m.memberId, {
      isoBirthdate: m.isoBirthdate,
      deathYear: deathYear ?? Number.POSITIVE_INFINITY,
    });
  });
  const ownerByAccountId = new Map<string, string>();
  let anyQualifies = false;
  for (const e of input.accountMcLedger) {
    const ownerId = e.ownerId ?? e.id;
    ownerByAccountId.set(e.id, ownerId);
    const accountType = e.accountType ?? 'OTHER';
    const admitted =
      rmdFactsByAccountId?.[e.id]?.inheritedAccount === true
        ? isInheritedRmdSubjectType(accountType)
        : isQualifyingAccount(accountType, e.taxTreatment ?? 'PRE_TAX');
    if (admitted) anyQualifies = true;
  }
  if (!anyQualifies) return undefined;
  return {
    ownerMeta,
    ownerByAccountId,
    rmdSnapshot: taxCtx.taxBundle.rmd,
    ...(rmdFactsByAccountId !== undefined ? { rmdFactsByAccountId } : {}),
    ...(retirementYearByOwner !== undefined ? { retirementYearByOwner } : {}),
  };
}

// Per-path guardrail runtime context, threaded into the strategy engine; `undefined` when the guardrail is absent or disabled or the baseline net-need series is missing. The year-start cumCpi for drawdown year `y` is the factor at the end of the prior month
// (`retStart + y*12 - 1`, or 1 at run start); the baseline real series are path-CPI-independent, so only the nominal year-start pool is deflated by path CPI.
function buildGuardrailRuntimeContext(
  input: MonteCarloInput,
  cumCpi: ArrayLike<number>,
  retStart: number,
  retYearCount: number,
): GuardrailRuntimeContext | undefined {
  const cfg = input.downturnGuardrails;
  if (cfg === undefined || cfg.enabled !== true) return undefined;
  const baselineNetNeed = input.guardrailBaselineRealNetNeedByYear;
  const baselineTotal = input.guardrailBaselineTotalRealByYear;
  const essential = input.guardrailEssentialRealByYear;
  if (
    baselineNetNeed === undefined ||
    baselineTotal === undefined ||
    essential === undefined
  ) {
    return undefined;
  }
  const cumCpiAtYearStart = new Array<number>(retYearCount);
  for (let y = 0; y < retYearCount; y += 1) {
    const priorStep = retStart + y * 12 - 1;
    cumCpiAtYearStart[y] = priorStep >= 0 ? (cumCpi[priorStep] ?? 1) : 1;
  }
  const config: GuardrailConfig = {
    enabled: cfg.enabled,
    lowerBandPct: cfg.lowerBandPct,
    upperBandPct: cfg.upperBandPct,
    stepPct: cfg.stepPct,
    maxRaisePct: cfg.maxRaisePct,
    discretionaryFloorPct: cfg.discretionaryFloorPct,
  };
  return {
    config,
    baselineTotalRealByYear: baselineTotal,
    baselineNetNeedRealByYear: baselineNetNeed,
    essentialRealByYear: essential,
    cumCpiAtYearStart,
    effectiveTaxRate: input.guardrailEffectiveTaxRate ?? 0,
    appliedFactorByYear: new Array<number>(retYearCount).fill(1),
  };
}

// Rebuilds the windowed nominal expense with the guardrail's pass-1 spend factor, since the engine scales the monthly `expense` in place but `nominalExpenseByYear` is built independently: otherwise a cut or raise would never reach the tax cashflow or the after-tax band.
// `appliedFactorByYear[i]` is retirement-relative year `i`; with no change the original array is returned, keeping a no-op guardrail byte-identical.
function guardrailAdjustedNominalExpenseByYear(
  nominalExpenseByYear: Float64Array,
  appliedFactorByYear: readonly number[],
  preRetirementYears: number,
): Float64Array {
  let anyAdjusted = false;
  for (let i = 0; i < appliedFactorByYear.length; i += 1) {
    if (appliedFactorByYear[i] !== 1) {
      anyAdjusted = true;
      break;
    }
  }
  if (!anyAdjusted) return nominalExpenseByYear;
  const adjusted = nominalExpenseByYear.slice();
  for (let i = 0; i < appliedFactorByYear.length; i += 1) {
    const y = preRetirementYears + i;
    if (y < 0 || y >= adjusted.length) continue;
    adjusted[y] = (nominalExpenseByYear[y] ?? 0) * appliedFactorByYear[i];
  }
  return adjusted;
}

// Builds the engine's `QcdContextInput` from `input.qcdContext`, inflating the real annual amount by this path's year-end `cumCpi` and resolving the indexed per-person §408(d)(8) limit; `undefined` without a QCD or an owner-to-account map.
// Year-end matches the factor used for `nominalExpenseByYear`; the deterministic engine's year-mean factor differs only by that documented approximation and agrees under zero CPI.
function buildMcQcdRuntimeForPath(
  input: MonteCarloInput,
  cumCpi: Float64Array,
): QcdContextInput | undefined {
  const qcd = input.qcdContext;
  if (qcd === undefined || qcd.entries.length === 0) return undefined;
  const stepCount = cumCpi.length;
  const firstEligibleYearByOwner = new Map<string, number>(
    Object.entries(qcd.firstEligibleYearByOwner),
  );
  const inflationPct = qcd.inflationPct;
  return {
    entries: qcd.entries.map((e) => ({
      memberId: e.memberId,
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: e.annualAmountDollars,
      startYear: e.startYear,
      endYear: e.endYear,
    })),
    firstEligibleYearByOwner,
    inflationFactorForYear: (taxYear: number): number => {
      const endStep = Math.min(
        stepCount - 1,
        Math.max(0, (taxYear - input.firstYear + 1) * 12 - 1),
      );
      return cumCpi[endStep] ?? 1;
    },
    qcdLimitCentsForYear: (taxYear: number): number =>
      resolveQcdLimitCentsForYear(taxYear, inflationPct),
  };
}

// Rebuilds the runtime MAGI-cap window list engine-side from the serializable overlay (closures throw `DataCloneError` crossing the Worker boundary): pairs each window with its precomputed bounds, drops non-positive intervals, flags broken anchors inactive
// and sorts by `(startYear, endYear, originalIndex)` so `selectActiveMagiCapWindow` matches the deterministic engine.
function buildMcMagiCapWindows(
  input: MonteCarloInput,
): ReadonlyArray<MagiCapWindowRuntime> | undefined {
  const overlay = input.magiCapOverride;
  const bounds = input.magiCapWindowBounds;
  if (overlay === undefined || bounds === undefined || overlay.windows.length === 0) {
    return undefined;
  }
  const resolved: MagiCapWindowRuntime[] = [];
  for (let i = 0; i < overlay.windows.length; i += 1) {
    const b = bounds[i];
    if (b === undefined) continue;
    if (b.brokenAnchor) {
      resolved.push({
        startYear: 0,
        endYear: 0,
        originalIndex: i,
        brokenAnchor: true,
        config: buildMagiCapConfig(overlay.windows[i], 0),
      });
      continue;
    }
    if (b.endYear <= b.startYear) continue;
    resolved.push({
      startYear: b.startYear,
      endYear: b.endYear,
      originalIndex: i,
      config: buildMagiCapConfig(overlay.windows[i], b.endYear),
    });
  }
  if (resolved.length === 0) return undefined;
  resolved.sort(compareMagiCapWindows);
  return resolved;
}

// `depositPost` is carried separately in `depositsPostByMonth` and always lands in `post`, so the pre-eligible slot gets the summed `deposit` minus it (absent means the summed slice passes through).
function sliceDepositPre(
  acc: KernelAccount,
  retStart: number,
  stepCount: number,
): Float64Array {
  const summed = acc.deposit.slice(retStart, stepCount);
  if (!acc.depositPost) return summed;
  for (let i = 0; i < summed.length; i += 1) {
    summed[i] -= acc.depositPost[retStart + i] ?? 0;
  }
  return summed;
}

// The strategy path reads only accumulation-phase kernel output (steps `< retStart`) plus `cumCpi` from `buildStepInputs`, so the kernel gets `retStart`-length `subarray` views (no copy); accumulation outputs are bit-identical to a full-length run. Skipped when `retStart === 0`.
function truncateAccountForAccumulation(acc: KernelAccount, retStart: number): KernelAccount {
  return {
    ...acc,
    contribPre: acc.contribPre.subarray(0, retStart),
    contribPost: acc.contribPost.subarray(0, retStart),
    deposit: acc.deposit.subarray(0, retStart),
    ...(acc.depositPost !== undefined
      ? { depositPost: acc.depositPost.subarray(0, retStart) }
      : {}),
    returnPct: acc.returnPct.subarray(0, retStart),
  };
}

export function truncateStepForAccumulation(step: StepInputs, retStart: number): StepInputs {
  return {
    ...step,
    mainReturnPct: step.mainReturnPct.subarray(0, retStart),
    cpiPct: step.cpiPct.subarray(0, retStart),
    contribPre: step.contribPre.subarray(0, retStart),
    contribPost: step.contribPost.subarray(0, retStart),
    expense: step.expense.subarray(0, retStart),
    income: step.income.subarray(0, retStart),
    deposit: step.deposit.subarray(0, retStart),
    ...(step.medicalDemandCents !== undefined
      ? { medicalDemandCents: step.medicalDemandCents.subarray(0, retStart) }
      : {}),
    accounts: step.accounts?.map((acc) => truncateAccountForAccumulation(acc, retStart)),
  };
}

// Named-strategy runner on `runYearByYearStrategyAware`: pass 1 estimates each year's tax draw (`classifyMcWithdrawal` + `applyPerYearTaxForPath`),
// folded into the sliced expense before pass 2 so the portfolio funds tax in strategy order; per-path success and percentile arrays come from pass 2.
// Pre-retirement years come from the proportional kernel, spliced at `retirementStepIdx`; the Roth-basis carrier is re-seeded between passes.
function runOnePathViaStrategyEngine(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  const {
    step, stepCount, retirementStepIdx, nominalExpenseByYear, nominalMedicalExpenseByYear,
    medicalDemandCents, cumCpi,
  } = buildStepInputs(input, seed, ctx);
  const horizonYears = input.horizonYear - input.firstYear + 1;

  // With no ledger the strategy engine has nothing to model, so fall back to the proportional kernel (production strategy paths always have a ledger).
  const stepAccounts = step.accounts;
  if (!stepAccounts || stepAccounts.length === 0) {
    return runOnePathKernel(input, seed, ctx, captureRun);
  }

  // The strategy engine runs whole years, so trim at the retirement-year boundary (`retStart = preRetirementYears * 12`), not the month-precise `retirementStepIdx`, or the sliced arrays would not be whole years and the engine would index past their ends (NaN growth).
  const preRetirementYears = Math.floor(retirementStepIdx / 12);
  const retStart = preRetirementYears * 12;
  const retYearCount = horizonYears - preRetirementYears;

  // Pre-retirement balances and entry buckets come from the kernel, truncated to `[0, retStart)`; with no accumulation phase (`retStart === 0`) it is skipped (`kernelOut = null`) and the entry-bucket fallbacks use the ledger initial balances.
  const kernelOut =
    retStart > 0 ? runStepKernel(truncateStepForAccumulation(step, retStart)) : null;

  const expense = step.expense.slice(retStart, stepCount);
  const income = step.income.subarray(retStart, stepCount);
  const householdDeposit = step.deposit.subarray(retStart, stepCount);
  const priorStep = retStart - 1;

  const accountsIn: DrawdownAccountInput[] = stepAccounts.map((acc, a) => {
    const ledger = input.accountMcLedger[a];
    const entryPre =
      priorStep >= 0 ? (kernelOut!.accountPreEnd?.[a]?.[priorStep] ?? acc.initialPre) : acc.initialPre;
    const entryPost =
      priorStep >= 0 ? (kernelOut!.accountPostEnd?.[a]?.[priorStep] ?? acc.initialPost) : acc.initialPost;
    return {
      id: acc.id,
      initialPre: entryPre,
      initialPost: entryPost,
      annualRatePct: 0, // overridden by returnPctByMonth
      // `depositsByMonth` is treatment-routed (CBP/one-off plus the post-primary pre-tax slice) and `depositsPostByMonth` is the designated-Roth slice, always `post`; slicing summed-minus-Roth into the pre slot avoids double-crediting the Roth slice.
      depositsByMonth: {
        startYear: input.retirementYear,
        startMonthIndex: 0,
        values: sliceDepositPre(acc, retStart, stepCount),
      },
      depositsPostByMonth: {
        startYear: input.retirementYear,
        startMonthIndex: 0,
        values: acc.depositPost
          ? acc.depositPost.slice(retStart, stepCount)
          : new Float64Array(stepCount - retStart),
      },
      taxTreatment: ledger?.taxTreatment ?? 'PRE_TAX',
      accountType: ledger?.accountType ?? 'BROKERAGE',
      returnPctByMonth: acc.returnPct.subarray(retStart, stepCount),
      ...(ledger?.floorDollars !== undefined
        ? { floorDollars: ledger.floorDollars, floorHsaMode: ledger.floorHsaMode }
        : {}),
    };
  });

  const strategyKind = input.strategyKind;
  const rmdContext = buildStrategyRmdContext(input);
  // The QCD pass runs only when both `qcdContext` and `rmdContext` are present (it reads the owner-to-account map off `rmdContext`); this path's own `cumCpi` inflates the real gift.
  const qcdContext = buildMcQcdRuntimeForPath(input, cumCpi);
  // Rebuild the closure-bearing MAGI-cap window list engine-side from the serializable overlay and bounds (see `buildMcMagiCapWindows`); undefined for Minimize, no cap or no tax context.
  // The pass-1 conversion hook runs against the draft pass-1 prior-balance basis; pass 2 rebuilds it from pass 1's committed prior-year-end balances so the solve sees the same synthetic RMD floor as the pass-2 committed tax.
  // Pass-1 and pass-2 conversions can differ in RMD years; the funded pass-2 result is authoritative.
  const magiCapWindows: ReadonlyArray<MagiCapWindowRuntime> | undefined =
    buildMcMagiCapWindows(input);
  const entryTotalBalance = accountsIn.reduce((sum, a) => sum + a.initialPre + a.initialPost, 0);
  const ownerIds = mcOwnerIds(input);
  const entryPreTaxIdx = buildEntryPreTaxCentsByOwnerIdx(input, accountsIn, ownerIds);
  const entryFactRmdIdx = buildEntryFactRmdRequiredCentsByOwnerIdx(
    input,
    accountsIn,
    ownerIds,
    input.firstYear + preRetirementYears,
  );
  const entryPreTaxByOwner = buildPriorPreTaxByOwnerFromIdx(
    entryPreTaxIdx,
    ownerIds,
    entryFactRmdIdx,
  );
  const fillConversionHook = buildMcFillConversionHook({
    input,
    magiCapWindows,
    nominalExpenseByYear,
    preRetirementYears,
    entryTotalBalance,
    entryPreTaxByOwner,
  });
  const medicalDemandByMonth = Array.from(medicalDemandCents.slice(retStart, stepCount));
  // The guardrail is threaded onto pass 1 only: it scales the shared `expense` array in place there and pass 2 reuses the scaled array, so the factor is evaluated once.
  const guardrail = buildGuardrailRuntimeContext(input, cumCpi, retStart, retYearCount);
  const args: RunYearByYearArgs = {
    input: {
      retirementYear: input.retirementYear,
      medicalDemandByMonth,
    } as unknown as DrawdownInput,
    yearCount: retYearCount,
    accountsIn,
    expense,
    income,
    householdDeposit,
    strategyKind,
    ...(rmdContext !== undefined ? { rmdContext } : {}),
    ...(qcdContext !== undefined ? { qcdContext } : {}),
    ...(input.customTiers !== undefined ? { customTiers: input.customTiers } : {}),
    ...(input.excludedIndices !== undefined ? { excludedIndices: input.excludedIndices } : {}),
    ...(magiCapWindows !== undefined ? { magiCapWindows } : {}),
    ...(fillConversionHook !== undefined ? { taxCashflow: fillConversionHook } : {}),
  };

  const pass1Args: RunYearByYearArgs =
    guardrail !== undefined ? { ...args, guardrail } : args;
  const pass1 = runYearByYearStrategyAware(pass1Args);
  stampPreTaxCentsByOwnerIdx(pass1.years, input, ownerIds);

  // Two-pass tax: pass 1's per-year tax draw is folded into the sliced expense and the engine re-runs once (no within-year fixpoint). Rebuild `nominalExpenseByYear` with pass 1's guardrail factor (see `guardrailAdjustedNominalExpenseByYear`).
  const taxNominalExpenseByYear =
    guardrail !== undefined
      ? guardrailAdjustedNominalExpenseByYear(
          nominalExpenseByYear,
          guardrail.appliedFactorByYear,
          preRetirementYears,
        )
      : nominalExpenseByYear;
  const taxState = newTaxPathState(
    input, kernelOut, stepCount, horizonYears, taxNominalExpenseByYear,
    nominalMedicalExpenseByYear, ctx,
    drawNeedByYearFromSlice(expense, income, preRetirementYears, horizonYears),
  );
  let years = pass1.years;
  let depletionYear = pass1.depletionYear;
  let perMonthWithdrawal = pass1.perMonthWithdrawal;
  if (taxState) {
    const priorPreTaxByOwnerByYearIndex = buildPriorPreTaxByOwnerByYearIndex(
      pass1.years,
      entryPreTaxIdx,
      ownerIds,
      entryFactRmdIdx,
    );
    fillStrategyYearTax(
      input,
      pass1.years,
      accountsIn,
      preRetirementYears,
      taxState,
      undefined,
      priorPreTaxByOwnerByYearIndex,
    );
    foldTaxIntoStrategyExpense(expense, income, taxState.taxDrawByYear, preRetirementYears);
    // Keep pass 1's line: it is what lowered pass 2's draw. The pass-2 fill would
    // restate it from the lower MAGI, a figure that never funded anything.
    const creditFundedByYear = taxState.acc.credit.slice();
    reseedRothBasisCarrier(taxState);
    resetPathTaxAcc(taxState.acc);
    taxState.taxDrawByYear.fill(0);
    // Rebuild the conversion hook for the authoritative pass with pass 1's committed prior-year-end totals, so the Fill solve's synthetic RMD floor matches the surface `fillStrategyYearTax` taxes pass 2 against; otherwise it solves against a no-floor surface and over-converts in RMD years.
    let pass2Args = args;
    let sharedPriorBalanceByYearIndex: number[] | undefined;
    let sharedQcdRmdOffsetByYearIndex: ReadonlyArray<ReadonlyMap<string, number>> | undefined;
    if (fillConversionHook !== undefined) {
      const priorBalanceByYearIndex: number[] = new Array<number>(pass1.years.length).fill(0);
      for (let i = 1; i < pass1.years.length; i += 1) {
        priorBalanceByYearIndex[i] = pass1.years[i - 1].balance;
      }
      sharedPriorBalanceByYearIndex = priorBalanceByYearIndex;
      // Derived once from pass 1 and shared by the pass-2 conversion hook and the committed `fillStrategyYearTax`, so the solve and the committed tax cannot desync; at the accepted cost of being one pass stale versus the deterministic committing pass (as for the floor basis and the MAGI ring).
      const qcdRmdOffsetByYearIndex: ReadonlyArray<ReadonlyMap<string, number>> =
        pass1.years.map((yr) =>
          yr.qcdRmdOffsetCentsByOwner !== undefined
            ? new Map(Object.entries(yr.qcdRmdOffsetCentsByOwner))
            : new Map<string, number>(),
        );
      sharedQcdRmdOffsetByYearIndex = qcdRmdOffsetByYearIndex;
      const pass2Hook = buildMcFillConversionHook({
        input,
        magiCapWindows,
        nominalExpenseByYear,
        preRetirementYears,
        entryTotalBalance,
        entryPreTaxByOwner,
        priorBalanceByYearIndex,
        priorPreTaxByOwnerByYearIndex,
        qcdRmdOffsetByYearIndex,
      });
      if (pass2Hook !== undefined) pass2Args = { ...args, taxCashflow: pass2Hook };
    }
    const pass2 = runYearByYearStrategyAware(pass2Args);
    years = pass2.years;
    depletionYear = pass2.depletionYear;
    perMonthWithdrawal = pass2.perMonthWithdrawal;
    stampPreTaxCentsByOwnerIdx(pass2.years, input, ownerIds);
    fillStrategyYearTax(
      input,
      pass2.years,
      accountsIn,
      preRetirementYears,
      taxState,
      sharedPriorBalanceByYearIndex,
      priorPreTaxByOwnerByYearIndex,
      sharedQcdRmdOffsetByYearIndex,
    );
    for (let y = 0; y < creditFundedByYear.length; y += 1) {
      taxState.acc.credit[y] = creditFundedByYear[y];
    }
  }

  // Stamp `priorPreEnd` on the first drawdown row so `applyMcRmdToRepresentativeYears` uses Dec 31 of the last accumulation year at the accumulation-to-drawdown boundary, as on the kernel path.
  if (captureRun && years.length > 0 && years[0].accountBalances !== undefined) {
    const firstRowAccts = years[0].accountBalances;
    const stamped = new Map<string, DrawdownAccountYear>();
    firstRowAccts.forEach((acct, id) => {
      const matchIdx = accountsIn.findIndex((ac) => ac.id === id);
      const priorPreEnd = matchIdx >= 0 ? accountsIn[matchIdx].initialPre : acct.preEnd;
      stamped.set(id, { ...acct, priorPreEnd });
    });
    years[0].accountBalances = stamped;
  }

  const balanceByYearNominal: number[] = new Array(horizonYears).fill(0);
  const balanceByYearReal: number[] = new Array(horizonYears).fill(0);
  const preRetYears: DrawdownYear[] = [];
  const accumulationAccountBalances: {
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }[] = [];

  for (let y = 0; y < preRetirementYears; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    balanceByYearNominal[y] = kernelOut!.preEnd[endStep] + kernelOut!.postEnd[endStep];
    balanceByYearReal[y] = balanceByYearNominal[y] / cumCpi[endStep];
    if (captureRun) {
      let growth = 0;
      let contributions = 0;
      for (let m = 0; m < 12; m += 1) {
        const i = y * 12 + m;
        if (i >= stepCount) break;
        growth += kernelOut!.growth[i];
        contributions += kernelOut!.contributions[i];
      }
      preRetYears.push({
        year: input.firstYear + y,
        balance: balanceByYearNominal[y],
        withdrawn: 0,
        netNeed: 0,
        growth,
        deposit: contributions,
        depleted: false,
      });
      const accBalances = buildKernelAccumulationBalances(input, kernelOut!, endStep);
      if (accBalances) {
        accumulationAccountBalances.push({
          year: input.firstYear + y,
          accountBalances: accBalances,
        });
      }
    }
  }

  // Absorbing depletion: the strategy engine is non-absorbing, but ruin is permanent (Bengen/Trinity convention), so zero-clamp the balance at the source for every retirement year at or after depletion.
  // `years[0]` is the first retirement year, so the offset subtracts both `firstYear` and the accumulation period (`depletionYear - input.retirementYear`).
  // Downstream consumers (balance arrays, `captureStrategyRun`, representative ranking, the `EPS_REAL` gate, the reroll band) then read zeroed values.
  const depletionRetIndex =
    depletionYear === null ? Number.POSITIVE_INFINITY : depletionYear - input.retirementYear;

  for (let y = 0; y < years.length; y += 1) {
    const portfolioYear = preRetirementYears + y;
    if (portfolioYear >= horizonYears) break;
    if (y >= depletionRetIndex) years[y].balance = 0;
    // Strictly-post-depletion growth is a phantom of the non-absorbing engine; zero it. The depletion year keeps its real growth.
    if (y > depletionRetIndex) years[y].growth = 0;
    // The aggregate clamp does not reach per-account sub-balances, so zero each account row's year-end balance fields (`balance`, `preEnd`, `postEnd`, `priorPreEnd`) and the per-owner pre-tax index at or after depletion, including the depletion year itself
    // (positive stacked bars under a $0 pooled line were a visible inconsistency). Withdrawal / deposit / distribution fields are preserved: the activity that depleted the money is real. `growth` and the per-path tax arrays below stay strictly-post-depletion.
    if (y >= depletionRetIndex) {
      const accts = years[y].accountBalances;
      if (accts !== undefined) {
        const zeroed = new Map<string, DrawdownAccountYear>();
        accts.forEach((acct, id) => {
          zeroed.set(id, {
            ...acct,
            balance: 0,
            preEnd: 0,
            postEnd: 0,
            ...(acct.priorPreEnd !== undefined ? { priorPreEnd: 0 } : {}),
          });
        });
        years[y].accountBalances = zeroed;
      }
      if (years[y].preTaxCentsByOwnerIdx !== undefined) {
        years[y].preTaxCentsByOwnerIdx = years[y].preTaxCentsByOwnerIdx!.map(() => 0);
      }
      if (years[y].factRmdRequiredCentsByOwnerIdx !== undefined) {
        years[y].factRmdRequiredCentsByOwnerIdx = years[
          y
        ].factRmdRequiredCentsByOwnerIdx!.map(() => 0);
      }
    }
    if (y > depletionRetIndex) {
      // `fillStrategyYearTax` populated the per-path tax arrays on un-clamped rows, so zero them for strictly-post-depletion years (no portfolio, no real tax); stale values would leak into the percentile tax bands. The depletion year keeps its real tax.
      if (taxState && portfolioYear < taxState.acc.fedTax.length) {
        taxState.acc.fedTax[portfolioYear] = 0;
        taxState.acc.irmaa[portfolioYear] = 0;
        taxState.acc.ptc[portfolioYear] = 0;
        taxState.acc.credit[portfolioYear] = 0;
        taxState.acc.etr[portfolioYear] = 0;
        taxState.acc.net[portfolioYear] = 0;
      }
    }
    if (captureRun && taxState && portfolioYear < taxState.acc.credit.length) {
      years[y].acaCreditAppliedToPremiumsCents = Math.round(taxState.acc.credit[portfolioYear] * 100);
    }
    const totalBalance = years[y].balance;
    balanceByYearNominal[portfolioYear] = totalBalance;
    const endStep = Math.min(stepCount - 1, (portfolioYear + 1) * 12 - 1);
    balanceByYearReal[portfolioYear] = totalBalance / cumCpi[endStep];
  }

  return {
    balanceByYearNominal,
    balanceByYearReal,
    depletionYear,
    endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
    endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
    ...(taxState
      ? {
          federalTaxByYear: taxState.acc.fedTax,
          irmaaSurchargeByYear: taxState.acc.irmaa,
          acaPtcSubsidyByYear: taxState.acc.ptc,
          acaCreditAppliedToPremiumsByYear: taxState.acc.credit,
          effectiveTaxRateByYear: taxState.acc.etr,
          netAfterTaxByYear: taxState.acc.net,
        }
      : {}),
    ...(captureRun
      ? {
          representative: captureStrategyRun(
            input,
            preRetYears,
            [...years],
            depletionYear,
            perMonthWithdrawal,
            cumCpi,
            stepCount,
            accumulationAccountBalances,
          ),
        }
      : {}),
  };
}

export function runOnePath(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  return runOnePathViaStrategyEngine(input, seed, ctx, captureRun);
}

// Guardrail mirror for the no-ledger kernel fallback: scales `expense` per drawdown year in place from the `out1` year-start pool with the same pure helpers the strategy engine uses. Edge and unit-test inputs only; real runs have a ledger.
function applyGuardrailToKernelExpense(
  input: MonteCarloInput,
  out1: StepOutcome,
  expense: Float64Array,
  retStart: number,
  retirementStepIdx: number,
  stepCount: number,
): void {
  const retYearCount = Math.floor((stepCount - retStart) / 12);
  const guardrail = buildGuardrailRuntimeContext(input, out1.cumCpi, retStart, retYearCount);
  if (guardrail === undefined) return;
  const state = initGuardrailState();
  for (let y = 0; y < retYearCount; y += 1) {
    const priorStep = retStart + y * 12 - 1;
    const poolNominal =
      priorStep >= 0 ? out1.preEnd[priorStep] + out1.postEnd[priorStep] : input.portfolioToday;
    const factor = evaluateKernelGuardrailYear(guardrail, state, y, poolNominal);
    if (factor !== 1) {
      const base = retStart + y * 12;
      for (let m = 0; m < 12; m += 1) {
        const i = base + m;
        if (i >= retirementStepIdx && i < stepCount) expense[i] *= factor;
      }
    }
  }
}

function evaluateKernelGuardrailYear(
  guardrail: GuardrailRuntimeContext,
  state: ReturnType<typeof initGuardrailState>,
  y: number,
  poolNominal: number,
): number {
  const priorSettled = state.settledFactor;
  const n = guardrail.baselineNetNeedRealByYear.length;
  const remaining = Math.max(0, n - y);
  const netNeedReal = new Array<number>(remaining);
  const cumOnes = new Array<number>(remaining);
  for (let k = 0; k < remaining; k += 1) {
    const idx = y + k;
    const baseNet = guardrail.baselineNetNeedRealByYear[idx] ?? 0;
    const baseTotal = guardrail.baselineTotalRealByYear[idx] ?? 0;
    netNeedReal[k] = baseNet + baseTotal * (priorSettled - 1);
    cumOnes[k] = 1;
  }
  const ratio = fundedRatio({
    portfolioNominal: poolNominal,
    portfolioCumCpi: guardrail.cumCpiAtYearStart[y] ?? 1,
    netNeedNominalByYear: netNeedReal,
    cumCpiByYear: cumOnes,
    effectiveTaxRate: guardrail.effectiveTaxRate,
  });
  const baseTotalThisYear = guardrail.baselineTotalRealByYear[y] ?? 0;
  const essentialThisYear = guardrail.essentialRealByYear[y] ?? 0;
  const essentialFloorFactor =
    baseTotalThisYear > 0 ? essentialThisYear / baseTotalThisYear : 0;
  return applyGuardrailStep({ state, ratio, config: guardrail.config, essentialFloorFactor }).factor;
}

// No-ledger proportional-kernel runner with a two-pass in-step tax correction; edge and unit-test inputs only, since the strategy engine needs a ledger.
function runOnePathKernel(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  const { step, stepCount, retirementStepIdx, nominalExpenseByYear, nominalMedicalExpenseByYear } =
    buildStepInputs(input, seed, ctx);
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const retStart = Math.floor(retirementStepIdx / 12) * 12;

  const out1 = runStepKernel(step);
  // Evaluated once against out1 and reused across both passes, since it mutates the shared `step.expense` in place.
  applyGuardrailToKernelExpense(input, out1, step.expense, retStart, retirementStepIdx, stepCount);
  const taxState = newTaxPathState(
    input, out1, stepCount, horizonYears, nominalExpenseByYear, nominalMedicalExpenseByYear, ctx,
  );

  if (taxState) {
    const balPass1Nom: number[] = new Array(horizonYears);
    const balPass1Real: number[] = new Array(horizonYears);
    fillYearBalancesAndTax(out1, balPass1Nom, balPass1Real, stepCount, taxState);

    // Fold the estimated monthly tax into the expense so pass 2 funds it in-step; `step.expense` is a fresh array per path, so mutating it is safe.
    for (let yearStart = Math.floor(retirementStepIdx / 12) * 12; yearStart < stepCount; yearStart += 12) {
      foldYearDrawIntoExpense(
        step.expense,
        step.income,
        Math.max(yearStart, retirementStepIdx),
        Math.min(yearStart + 12, stepCount),
        taxState.taxDrawByYear[yearStart / 12],
      );
    }

    const out2 = runStepKernel(step);

    // `out1.cumCpi === out2.cumCpi` (CPI derives from the unchanged `step.cpiPct`), so taxState linked to out1 is reused for the pass-2 balance fill.
    const balanceByYearNominal: number[] = new Array(horizonYears);
    const balanceByYearReal: number[] = new Array(horizonYears);
    // `applyTaxForYear` reads `taxState.out` (out1) for per-account classification, so pass-2 tax figures are a second-order approximation (no within-year fixpoint); balances come from out2.
    taxState.taxDrawByYear.fill(0);
    fillYearBalancesAndTax(out2, balanceByYearNominal, balanceByYearReal, stepCount, taxState);

    const depletionYear =
      out2.depletionStepIdx === -1
        ? null
        : input.firstYear + Math.floor(out2.depletionStepIdx / 12);

    const pathTaxAcc = taxState.acc;
    // The no-ledger kernel has no absorbing-depletion clamp, so zero the strictly-post-depletion tax slots to match the strategy path's invariant for the percentile tax bands; the depletion year keeps its real tax.
    if (depletionYear !== null) {
      const depletionYearIdx = depletionYear - input.firstYear;
      for (let y = depletionYearIdx + 1; y < horizonYears; y += 1) {
        pathTaxAcc.fedTax[y] = 0;
        pathTaxAcc.irmaa[y] = 0;
        pathTaxAcc.ptc[y] = 0;
        pathTaxAcc.credit[y] = 0;
        pathTaxAcc.etr[y] = 0;
        pathTaxAcc.net[y] = 0;
      }
    }
    return {
      balanceByYearNominal,
      balanceByYearReal,
      depletionYear,
      endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
      endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
      federalTaxByYear: pathTaxAcc.fedTax,
      irmaaSurchargeByYear: pathTaxAcc.irmaa,
      acaPtcSubsidyByYear: pathTaxAcc.ptc,
      acaCreditAppliedToPremiumsByYear: pathTaxAcc.credit,
      effectiveTaxRateByYear: pathTaxAcc.etr,
      netAfterTaxByYear: pathTaxAcc.net,
      ...(captureRun
        ? { representative: captureKernelRun(input, out2, stepCount, pathTaxAcc, retStart) }
        : {}),
    };
  }

  const balanceByYearNominal: number[] = new Array(horizonYears);
  const balanceByYearReal: number[] = new Array(horizonYears);
  fillYearBalancesAndTax(out1, balanceByYearNominal, balanceByYearReal, stepCount, null);
  const depletionYear =
    out1.depletionStepIdx === -1
      ? null
      : input.firstYear + Math.floor(out1.depletionStepIdx / 12);
  return {
    balanceByYearNominal,
    balanceByYearReal,
    depletionYear,
    endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
    endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
    ...(captureRun
      ? { representative: captureKernelRun(input, out1, stepCount, null, retStart) }
      : {}),
  };
}

/** Everything `runMonteCarlo`'s path loop accumulates, handed to the summary assembly; `taxAcc` is null without a `taxContext`. */
export interface PathLoopAccumulation {
  balancesByYearNominal: number[][];
  balancesByYearReal: number[][];
  taxAcc: McTaxAccumulators | null;
  endingNominal: number[];
  endingReal: number[];
  depletionYears: number[];
  /** Per-path depletion year in path-index order (`null` when never depleted), unlike `depletionYears`, which lists only failed paths; lets the representative tie-break reconcile a path's run-out age to its card percentile. */
  depletionYearByPath: (number | null)[];
  failureYearHistogram: number[];
  successes: number;
}

/** Seed for the path at `pathIndex`, the derivation the hot loop uses, so it needs no extra allocation to recover. */
export function seedForPathIndex(baseSeed: number, pathIndex: number): number {
  return (baseSeed + pathIndex * 0x9e3779b1) >>> 0;
}

/** Fail-fast validation of the pre-computed per-run arrays before any path work, so the sharded coordinator can reject malformed input on the main thread, synchronously and identically to the serial path. Covers the pre-loop checks only; the per-path `injectedReturns` / `injectedCpi` guards are out of scope. */
export function validateMonteCarloInput(input: MonteCarloInput): void {
  const horizon = input.horizonYear - input.firstYear + 1;
  // A length mismatch silently produces wrong income (the `?? 0` fallback in `buildHouseholdSeries` masks the gap).
  if (input.ssByYear.length !== horizon) {
    throw new Error(
      `runMonteCarlo: ssByYear.length (${input.ssByYear.length}) !== horizon (${horizon})`,
    );
  }
  if (input.incomeByYear.length !== horizon) {
    throw new Error(
      `runMonteCarlo: incomeByYear.length (${input.incomeByYear.length}) !== horizon (${horizon})`,
    );
  }
  // The expense base (and each bucket's array) must equal `stepCount`; a mismatch would silently read past or short of it. Throw, never `?? 0`.
  const stepCount = horizon * 12;
  if (input.monthlyExpenseBase.length !== stepCount) {
    throw new Error(
      `runMonteCarlo: monthlyExpenseBase.length (${input.monthlyExpenseBase.length}) !== stepCount (${stepCount})`,
    );
  }
  if (input.monthlyExpenseBucketsBase !== undefined) {
    for (const b of input.monthlyExpenseBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyExpenseBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
  if (input.monthlyMedicalDemandBucketsBase !== undefined) {
    for (const b of input.monthlyMedicalDemandBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyMedicalDemandBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
  if (
    input.monthlyMedicalExpenseBase !== undefined &&
    input.monthlyMedicalExpenseBase.length !== stepCount
  ) {
    throw new Error(
      `runMonteCarlo: monthlyMedicalExpenseBase.length (${input.monthlyMedicalExpenseBase.length}) !== stepCount (${stepCount})`,
    );
  }
  if (input.monthlyMedicalExpenseBucketsBase !== undefined) {
    for (const b of input.monthlyMedicalExpenseBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyMedicalExpenseBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloSummary {
  validateMonteCarloInput(input);
  const runCtx = buildRunContext(input);

  // A serial run drives the same two-stage pipeline as the sharded coordinator (one `[0, pathCount)` range), so serial and sharded results are bit-identical.
  const range = runPathRange(input, runCtx, 0, input.pathCount, input.onProgress);
  const merged = mergePathRanges([range], input);
  const acc = assembleAccumulationFromTyped(merged, input);
  return assembleMonteCarloSummary(input, runCtx, acc);
}
