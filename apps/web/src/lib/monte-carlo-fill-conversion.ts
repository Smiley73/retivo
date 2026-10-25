/** Monte Carlo Fill-mode Roth-conversion hook: drives `solveFillConversion` against the MC per-path tax surface, matching the deterministic engine.
 * See docs/math-retirement-accounts.md (retirement "Fill" conversions) and docs/math-withdrawals.md ("The MAGI cap"). */
import { applyTaxYearForFilingPlan } from './tax-integration.js';
import {
  buildMcTaxYearInput,
  deriveMcSurvivors,
  type McTaxContext,
} from './monte-carlo-tax.js';
import { solveTaxCashflow, solveFillConversion } from './tax-cashflow-solver.js';
import type {
  TaxCashflowHook,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types.js';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers.js';
import type { MonteCarloInput } from './monte-carlo-types.js';

// Mapping the inherited tranche as ordered would solve against more Roth tax than the funded pass charges; no account-level split exists, so the rest stays basis-ordered.
function splitProbeRothTranche(classification: {
  readonly rothDollars: number;
  readonly rothInheritedTaxFreeDollars?: number;
}): { readonly rothBasisOrderedDollars: number; readonly rothWholesaleTaxFreeDollars: number } {
  const inheritedRothDollars = Math.min(
    Math.max(0, classification.rothDollars),
    Math.max(0, classification.rothInheritedTaxFreeDollars ?? 0),
  );
  return {
    rothBasisOrderedDollars: classification.rothDollars - inheritedRothDollars,
    rothWholesaleTaxFreeDollars: inheritedRothDollars,
  };
}

// The RMD floor derives from `priorPreTaxByOwner`, the basis `fillStrategyYearTax` threads, so a Roth-heavy or all-taxable household sees a $0 floor (no phantom RMD income).
function buildYearTaxInput(
  input: MonteCarloInput,
  taxCtx: McTaxContext,
  taxYear: number,
  globalYearOffset: number,
  nominalExpenseByYear: Float64Array,
  classification: TaxCashflowYearClassification,
  magiMinus2: number | undefined,
  priorBalance: number,
  priorPreTaxByOwner: ReadonlyMap<string, number>,
  // The QCD offset reduces the per-owner RMD floor as in `fillStrategyYearTax`, so a QCD-satisfied RMD is not re-grossed as phantom taxable income.
  qcdRmdOffsetCentsByOwner?: ReadonlyMap<string, number>,
): ReturnType<typeof buildMcTaxYearInput> | null {
  const survivorState = deriveMcSurvivors(taxCtx, taxYear, input.retirementYear);
  if (survivorState === null) return null;
  const rothTranche = splitProbeRothTranche(classification);
  const perYearArgs = {
    taxCtx,
    taxYear,
    retirementYear: input.retirementYear,
    grossSsDollars: input.ssByYear[globalYearOffset] ?? 0,
    nominalExpense: nominalExpenseByYear[globalYearOffset] ?? 0,
    otherIncome: input.incomeByYear[globalYearOffset] ?? 0,
    priorBalance,
    priorPreTaxByOwner,
    ...(qcdRmdOffsetCentsByOwner !== undefined
      ? { qcdRmdOffsetCentsByOwner }
      : {}),
    magiMinus2,
    classification: {
      preTaxDollars: classification.preTaxDollars,
      postTaxNonRothDollars: classification.postTaxNonRothDollars,
      postTaxCashLikeDollars: classification.postTaxCashLikeDollars,
      ...rothTranche,
    },
  };
  // Conversion income is layered on top of the committed pre-tax draw (grossed up to the RMD floor in `buildMcTaxYearInput`), so it sits outside `max(draw, rmdFloor)` and the §72(t) penalty basis.
  return buildMcTaxYearInput(perYearArgs, survivorState, classification.preTaxDollars, 0);
}

/**
 * Per-path Fill-mode conversion hook for the MC strategy path; `undefined` when there is no MAGI cap, no Fill mode or
 * no MC tax context. `cumCpi` and `preRetirementYears` align the per-year tax context with `fillStrategyYearTax`.
 */
export function buildMcFillConversionHook(args: {
  readonly input: MonteCarloInput;
  /** Runtime window list rebuilt engine-side: its configs carry closures that cannot cross `postMessage`, so it is not on `MonteCarloInput`. */
  readonly magiCapWindows: ReadonlyArray<MagiCapWindowRuntime> | undefined;
  readonly nominalExpenseByYear: Float64Array;
  readonly preRetirementYears: number;
  readonly entryTotalBalance: number;
  /** Prior-year-end portfolio total by retirement-relative year index; absent or short falls back to `entryTotalBalance`. */
  readonly priorBalanceByYearIndex?: ReadonlyArray<number>;
  readonly entryPreTaxByOwner: ReadonlyMap<string, number>;
  /** Per-owner prior pre-tax basis by year index, shared with the committed `fillStrategyYearTax` so both derive one RMD floor; absent or short falls back to `entryPreTaxByOwner`. */
  readonly priorPreTaxByOwnerByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>;
  /** Per-owner QCD RMD offset by year index from the prior pass's committed rows; absent (draft pass 1 or no QCD) means the gross floor. */
  readonly qcdRmdOffsetByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>;
}): TaxCashflowHook | undefined {
  const { input, magiCapWindows, nominalExpenseByYear, preRetirementYears } = args;
  const { entryTotalBalance, priorBalanceByYearIndex } = args;
  const { entryPreTaxByOwner, priorPreTaxByOwnerByYearIndex } = args;
  const { qcdRmdOffsetByYearIndex } = args;
  const taxCtx = input.taxContext;
  const hasFillWindow =
    magiCapWindows !== undefined &&
    magiCapWindows.some((w) => !w.brokenAnchor && w.config.capMode === 'fill');
  if (!hasFillWindow || taxCtx === undefined || taxCtx.members.length === 0) {
    return undefined;
  }
  const priorBalanceFor = (yearIndex: number): number => {
    if (yearIndex <= 0) return entryTotalBalance;
    return priorBalanceByYearIndex?.[yearIndex] ?? entryTotalBalance;
  };
  const priorPreTaxByOwnerFor = (yearIndex: number): ReadonlyMap<string, number> => {
    if (yearIndex <= 0) return entryPreTaxByOwner;
    return priorPreTaxByOwnerByYearIndex?.[yearIndex] ?? entryPreTaxByOwner;
  };
  const qcdRmdOffsetByOwnerFor = (
    yearIndex: number,
  ): ReadonlyMap<string, number> | undefined => qcdRmdOffsetByYearIndex?.[yearIndex];
  const bundle = taxCtx.taxBundle;
  // IRMAA 2-year MAGI look-back keyed by year index (not a sliding ring), so a year with no conversion cannot desynchronize later years; the first two years use the threaded bootstrap.
  const inclusiveMagiByYearIndex = new Map<number, number>();
  const lookbackMinus2For = (yearIndex: number): number | undefined => {
    if (yearIndex >= 2) return inclusiveMagiByYearIndex.get(yearIndex - 2);
    if (yearIndex === 0) return taxCtx.magiBootstrapLookbackMinus2;
    return taxCtx.magiBootstrapLookbackMinus1;
  };

  // No-op: the MC path funds ordinary-withdrawal tax via the two-pass fold, so a second funding need here would double-fund.
  const solveForYear = (): TaxCashflowYearOutcome => ({
    addedNeedDollars: 0,
    federalTaxCashNeedCents: 0,
    irmaaWithheldFromSsCents: 0,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 0,
    acaCreditAppliedToPremiumsCents: 0,
    totalTaxCashflowNeedCents: 0,
    taxCashflowIterations: 0,
    taxCashflowConverged: true,
    taxCashflowShortfallCents: 0,
  });

  const solveFillConversionForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertibleRoomDollars: number,
    capMagiLine: 'irmaa' | 'aca',
    magiCeilingDollars: number,
  ): number => {
    if (convertibleRoomDollars <= 0) return 0;
    const taxYear = input.retirementYear + yearIndex;
    const globalYearOffset = preRetirementYears + yearIndex;
    const taxInputBase = buildYearTaxInput(
      input,
      taxCtx,
      taxYear,
      globalYearOffset,
      nominalExpenseByYear,
      withdrawalClassification,
      lookbackMinus2For(yearIndex),
      priorBalanceFor(yearIndex),
      priorPreTaxByOwnerFor(yearIndex),
      qcdRmdOffsetByOwnerFor(yearIndex),
    );
    if (taxInputBase === null) return 0;
    const { convertedDollars } = solveFillConversion({
      taxInputBase,
      bundle,
      capMagiLine,
      magiCeilingDollars,
      convertibleRoomDollars,
    });
    // Records the solve amount, not the committed amount the deterministic engine records. Numerically inert: `magiMinus2` drives only the Y+2 IRMAA surcharge,
    // which is outside the solve objective and cancels in `fundConversionTaxForYear`'s with-minus-without difference.
    const inclusiveInput = {
      ...taxInputBase,
      otherOrdinaryIncomeDollars: taxInputBase.otherOrdinaryIncomeDollars + convertedDollars,
    };
    inclusiveMagiByYearIndex.set(
      yearIndex,
      applyTaxYearForFilingPlan(inclusiveInput, bundle).magiCents / 100,
    );
    return convertedDollars;
  };

  const fundConversionTaxForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertedDollars: number,
  ): number => {
    if (convertedDollars <= 0) return 0;
    const taxYear = input.retirementYear + yearIndex;
    const globalYearOffset = preRetirementYears + yearIndex;
    const baseTaxInput = buildYearTaxInput(
      input,
      taxCtx,
      taxYear,
      globalYearOffset,
      nominalExpenseByYear,
      withdrawalClassification,
      lookbackMinus2For(yearIndex),
      priorBalanceFor(yearIndex),
      priorPreTaxByOwnerFor(yearIndex),
      qcdRmdOffsetByOwnerFor(yearIndex),
    );
    if (baseTaxInput === null) return 0;
    const fundingNeedCents = (taxInput: typeof baseTaxInput): number => {
      const r = solveTaxCashflow({
        ordinaryNetNeedDollars: 0,
        taxInputBase: taxInput,
        bundle,
        irmaaPayment: { ownSsDollarsByMemberId: {} },
        classifyForTarget: () => {
          const pre = taxInput.preTaxWithdrawalDollars ?? 0;
          const postNonRoth = taxInput.postTaxNonRothWithdrawalDollars ?? 0;
          const postCashLike = taxInput.postTaxCashLikeWithdrawalDollars ?? 0;
          const roth = taxInput.rothWithdrawalDollars ?? 0;
          return {
            preTaxDollars: pre,
            postTaxNonRothDollars: postNonRoth,
            postTaxCashLikeDollars: postCashLike,
            rothDollars: roth,
            fundedDollars: pre + postNonRoth + postCashLike + roth,
          };
        },
      });
      // MC funds the full IRMAA surcharge (no per-member SS split on the path), so add the withheld portion back.
      return r.totalTaxCashflowNeedCents + r.irmaaWithheldFromSsCents;
    };
    const withoutConvCents = fundingNeedCents(baseTaxInput);
    const withConvCents = fundingNeedCents({
      ...baseTaxInput,
      otherOrdinaryIncomeDollars: baseTaxInput.otherOrdinaryIncomeDollars + convertedDollars,
    });
    return Math.max(0, withConvCents - withoutConvCents) / 100;
  };

  return { solveForYear, solveFillConversionForYear, fundConversionTaxForYear };
}
