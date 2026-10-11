/**
 * Monte Carlo Fill-mode Roth-conversion hook (parity with the deterministic engine).
 *
 * The deterministic engine sizes Fill-mode conversions through the runner-tax
 * `TaxCashflowHook` (`solveFillConversionForYear` + `fundConversionTaxForYear`
 * in `balance-projection-runner-tax.ts`), an OUTER monotone bisection wrapping
 * the inner tax surface. The named-strategy Monte Carlo path runs the
 * SAME `runYearByYearStrategyAware` engine but funds tax through its own per-path
 * tax model (`applyPerYearTaxForPath` / `buildMcTaxYearInput`, the two-pass
 * expense fold), NOT the deterministic hook. So MC parity for conversions needs a
 * SEPARATE hook that drives the IDENTICAL conversion math (`solveFillConversion`)
 * against the MC per-path tax surface.
 *
 * This builder returns exactly that hook, per MC path:
 *   - `solveForYear` is a NO-OP (zero added need). The MC strategy path already
 *     funds ordinary-withdrawal tax via its two-pass fold; this hook exists only to
 *     enable the conversion fill, so it must NOT introduce a second tax-funding
 *     mechanism (that would double-fund and break the tax-aware parity).
 *   - `solveFillConversionForYear` runs the SAME outer bisection
 *     (`solveFillConversion`) the deterministic hook runs, but builds the year's
 *     tax input via `buildMcTaxYearInput` (the MC per-path tax surface). It keeps
 *     its OWN IRMAA 2-year MAGI look-back ring, advanced per drawdown year exactly
 *     as `fillStrategyYearTax` does, so the IRMAA-line solve sees the same Y-2 MAGI.
 *   - `fundConversionTaxForYear` returns the SAME-YEAR incremental federal/IRMAA
 *     cash tax the conversion adds (conversion-inclusive solve − withdrawals-only
 *     solve), so the engine draws it from cap-safe balances — keeping the MC path's
 *     ending balances conserved MINUS the funded conversion tax, exactly like the
 *     deterministic path. The conversion ordinary income SUMS on top of the year's
 *     `max(actualPreTaxDraw, rmdFloor)`: `buildMcTaxYearInput` grosses the
 *     pre-tax withdrawal up to the RMD floor, and the conversion is layered as
 *     ADDITIONAL ordinary income (`otherOrdinaryIncomeDollars`) — never folded into
 *     `preTaxWithdrawalDollars`, so it is correctly outside the `max()` and outside
 *     the §72(t) penalty basis.
 *
 * Side-effect-free probes; consumes no RNG; per-path deterministic. The committed
 * conversion's principal move + Roth-basis credit happen in the engine
 * (`applyRothConversionFill`), once, on the committing path.
 *
 * The conversion rules are explained in docs/math-retirement-accounts.md
 * (section on retirement "Fill" conversions) and the MAGI cap in
 * docs/math-withdrawals.md ("The MAGI cap").
 */
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

/** Split the deterministic Roth total into its wholesale tax-free INHERITED
 *  subset and the §408A-ordered remainder, for the Fill-mode conversion probe.
 *
 *  `TaxCashflowYearClassification` (deterministic) carries one `rothDollars` total
 *  plus the inherited SUBSET of it. The inherited tranche is wholesale tax-free in
 *  the committing pass, so it maps to the wholesale bucket and the remainder to the
 *  basis-ordered one; mapping it as ordered would have the probe solve against MORE
 *  Roth tax than the funded pass charges, and dropping it would shrink
 *  `fundedDollars` in `classifyForTarget`. The rest of the tranche stays
 *  basis-ordered: the deterministic classification is type-level, not
 *  account-level, so no finer split is available and ordered is the conservative
 *  parity choice.
 *
 *  Both halves stay in the tranche — the two buckets always sum to `rothDollars`,
 *  so every total built from them is unchanged. Extracted so the ROUTING itself is
 *  assertable: `buildMcTaxYearInput` consumes the two buckets only as their sum, so
 *  the split is not observable on the input object it returns. */
export function splitProbeRothTranche(classification: {
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

/** A withdrawals-only `applyTaxYear` input for one MC drawdown year, built from
 *  the committed withdrawal classification + the year's MC tax context. Returns
 *  `null` for a year before retirement or with no survivors (no conversion).
 *
 *  `priorBalance` is the prior-year-end portfolio total (retained for
 *  diagnostics / non-RMD use). The RMD floor derives from the
 *  per-owner `priorPreTaxByOwner` basis — the SAME per-owner basis
 *  `fillStrategyYearTax` threads — so `buildMcTaxYearInput`'s per-owner RMD floor
 *  (`computeMcRmdFloorCents`) grosses the pre-tax tranche up to `max(draw,
 *  rmdFloor)` against the IDENTICAL surface that taxes the path's balance, and a
 *  Roth-heavy / all-taxable household sees a $0 floor (no phantom RMD income). */
export function buildYearTaxInput(
  input: MonteCarloInput,
  taxCtx: McTaxContext,
  taxYear: number,
  globalYearOffset: number,
  nominalExpenseByYear: Float64Array,
  classification: TaxCashflowYearClassification,
  magiMinus2: number | undefined,
  priorBalance: number,
  // The per-owner prior pre-tax (RMD-eligible) basis for this year —
  // feeds `computeMcRmdFloorCents` (the per-owner RMD floor) inside
  // `buildMcTaxYearInput`, REPLACING the whole-portfolio synthetic floor.
  priorPreTaxByOwner: ReadonlyMap<string, number>,
  // The per-owner QCD IRA-pool RMD offset for this year (memberId →
  // cents). Threaded into `buildMcTaxYearInput` so the conversion solve's RMD
  // floor is REDUCED by the QCD exactly as the committed `fillStrategyYearTax`
  // floor and the deterministic Fill solve are — a QCD-satisfied RMD is never
  // re-grossed as phantom taxable income that crowds out convertible headroom.
  // Empty / omitted → no offset (identical to a no-QCD run).
  qcdRmdOffsetCentsByOwner?: ReadonlyMap<string, number>,
): ReturnType<typeof buildMcTaxYearInput> | null {
  const survivorState = deriveMcSurvivors(taxCtx, taxYear, input.retirementYear);
  if (survivorState === null) return null;
  // The wholesale tax-free inherited subset and the §408A-ordered remainder.
  // Both halves stay in the tranche, so every total below is unchanged.
  const rothTranche = splitProbeRothTranche(classification);
  const perYearArgs = {
    taxCtx,
    taxYear,
    retirementYear: input.retirementYear,
    grossSsDollars: input.ssByYear[globalYearOffset] ?? 0,
    // The windowed nominal expense at this
    // year-END step. INERT here (see below) — threaded so the tax arg shape
    // stays valid without reading a removed field.
    nominalExpense: nominalExpenseByYear[globalYearOffset] ?? 0,
    otherIncome: input.incomeByYear[globalYearOffset] ?? 0,
    priorBalance,
    priorPreTaxByOwner,
    // Reduce the conversion solve's per-owner RMD floor by the QCD
    // IRA-pool offset (inert when absent/empty), matching the committed tax +
    // deterministic Fill solve.
    ...(qcdRmdOffsetCentsByOwner !== undefined
      ? { qcdRmdOffsetCentsByOwner }
      : {}),
    magiMinus2,
    classification: {
      preTaxDollars: classification.preTaxDollars,
      postTaxNonRothDollars: classification.postTaxNonRothDollars,
      postTaxCashLikeDollars: classification.postTaxCashLikeDollars,
      // Routing (see `splitProbeRothTranche`): inherited → wholesale tax-free,
      // remainder → §408A-ordered. The two buckets sum to the whole tranche.
      ...rothTranche,
    },
  };
  // The conversion income is layered separately; the pre-tax tranche here is the
  // committed pre-tax withdrawal (grossed up to the RMD floor inside
  // `buildMcTaxYearInput` — so the conversion correctly SUMS on top of
  // `max(draw, rmdFloor)`).
  //
  // `nominalExpense` is INERT here — `buildMcTaxYearInput` is handed the
  // committed windowed-draw classification (`classification.preTaxDollars`)
  // directly, so the conversion solve sizes off the per-category windowed
  // withdrawal, not the expense scalar.
  return buildMcTaxYearInput(perYearArgs, survivorState, classification.preTaxDollars, 0);
}

/**
 * Build the per-path Fill-mode conversion hook for the MC strategy path.
 * `cumCpi` is the path's sampled cumulative-CPI series and `preRetirementYears`
 * the accumulation-year offset, so the per-year tax context aligns with
 * `fillStrategyYearTax`. Returns `undefined` when there is no MAGI cap, no Fill
 * mode, or no MC tax context (the engine then performs no conversions).
 */
export function buildMcFillConversionHook(args: {
  readonly input: MonteCarloInput;
  /** The runtime MAGI-cap WINDOW LIST rebuilt
   *  engine-side (its per-window configs carry closures that cannot cross
   *  `postMessage`, so the runtime list is NOT carried on `MonteCarloInput`).
   *  The hook is enabled when ANY window runs Fill mode; the active window's
   *  `capMagiLine` / `magiCeilingDollars` reach `solveFillConversionForYear`
   *  per-year from the engine's `selectActiveMagiCapWindow`, so the hook body
   *  itself stays window-agnostic. */
  readonly magiCapWindows: ReadonlyArray<MagiCapWindowRuntime> | undefined;
  /** The path's per-year windowed nominal
   *  expense at the year-END step (`buildStepInputs.nominalExpenseByYear`).
   *  Threaded into the per-year tax inputs; inert for the conversion solve. */
  readonly nominalExpenseByYear: Float64Array;
  readonly preRetirementYears: number;
  /** Drawdown-entry portfolio total (sum of accountsIn pre+post). The
   *  synthetic RMD-floor basis for retirement year 0. */
  readonly entryTotalBalance: number;
  /** Prior-year-END portfolio total by retirement-relative year index,
   *  threaded from the prior pass's committed rows. Index i carries year i's
   *  prior balance (= year (i-1)'s end). Year 0 falls back to `entryTotalBalance`.
   *  Absent / short → year 0 uses the entry total, later years fall back to it
   *  too (the draft pass-1 basis, before any committed rows exist). */
  readonly priorBalanceByYearIndex?: ReadonlyArray<number>;
  /** Drawdown-ENTRY per-owner pre-tax (RMD-eligible) basis — the
   *  year-0 prior basis for the per-owner RMD floor. */
  readonly entryPreTaxByOwner: ReadonlyMap<string, number>;
  /** Per-owner prior pre-tax basis by retirement-relative year index
   *  (year i = year (i-1)'s end). Built from `pass1.years[i-1].preTaxCentsByOwnerIdx`,
   *  SHARED with the committed `fillStrategyYearTax`, so the
   *  conversion solve + the committed tax derive ONE per-owner RMD floor. Absent /
   *  short → year 0 uses `entryPreTaxByOwner`, later years fall back to it. */
  readonly priorPreTaxByOwnerByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>;
  /** Per-owner QCD IRA-pool RMD offset by retirement-relative year
   *  index (memberId → cents), built from the PRIOR pass's committed rows
   *  (`pass1.years[i].qcdRmdOffsetCentsByOwner`) exactly as
   *  `priorPreTaxByOwnerByYearIndex` is — the SAME source the committed
   *  `fillStrategyYearTax` reads, so the conversion solve's RMD floor is reduced
   *  by the same QCD the committed tax sees. Absent (pass-1 draft hook, or a
   *  no-QCD run) → no offset, gross floor (the draft pass is non-authoritative;
   *  pass-2 is the parity contract). Index i = year i's offset. */
  readonly qcdRmdOffsetByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>;
}): TaxCashflowHook | undefined {
  const { input, magiCapWindows, nominalExpenseByYear, preRetirementYears } = args;
  const { entryTotalBalance, priorBalanceByYearIndex } = args;
  const { entryPreTaxByOwner, priorPreTaxByOwnerByYearIndex } = args;
  const { qcdRmdOffsetByYearIndex } = args;
  const taxCtx = input.taxContext;
  // The hook is needed iff at least one ACTIVE-eligible window runs Fill mode.
  // A Minimize-only ladder / no cap / no tax context →
  // no conversion hook.
  const hasFillWindow =
    magiCapWindows !== undefined &&
    magiCapWindows.some((w) => !w.brokenAnchor && w.config.capMode === 'fill');
  if (!hasFillWindow || taxCtx === undefined || taxCtx.members.length === 0) {
    return undefined;
  }
  // The prior-year-end portfolio total feeding the synthetic RMD floor for
  // retirement-relative year `yearIndex`. Year 0 = the drawdown-entry total; later
  // years read the prior pass's committed end balance (falling back to the entry
  // total before any committed rows exist — the draft pass-1 basis).
  const priorBalanceFor = (yearIndex: number): number => {
    if (yearIndex <= 0) return entryTotalBalance;
    return priorBalanceByYearIndex?.[yearIndex] ?? entryTotalBalance;
  };
  // The per-owner prior pre-tax basis feeding the per-owner RMD floor
  // for retirement-relative year `yearIndex`. Year 0 = the drawdown-entry map;
  // later years read the shared per-year array (falling back to the entry map
  // before any committed rows exist).
  const priorPreTaxByOwnerFor = (yearIndex: number): ReadonlyMap<string, number> => {
    if (yearIndex <= 0) return entryPreTaxByOwner;
    return priorPreTaxByOwnerByYearIndex?.[yearIndex] ?? entryPreTaxByOwner;
  };
  // The per-owner QCD IRA-pool RMD offset feeding this year's
  // offset-reduced floor. Index i = year i's offset (committed by the prior pass).
  // Absent (no QCD / pass-1 draft) → undefined, gross floor.
  const qcdRmdOffsetByOwnerFor = (
    yearIndex: number,
  ): ReadonlyMap<string, number> | undefined => qcdRmdOffsetByYearIndex?.[yearIndex];
  const bundle = taxCtx.taxBundle;
  // IRMAA 2-year MAGI look-back: the conversion-INCLUSIVE MAGI of each solved
  // drawdown year, keyed by retirement-relative year index. Year Y's IRMAA-line
  // solve reads year (Y-2)'s stored MAGI; the first two years fall back to the
  // threaded bootstrap (`magiBootstrap*`). Keyed (not a sliding ring) so a gap
  // year — one with no conversion / no headroom — never desynchronizes the
  // look-back for later years (mirrors the MC tax model: $0 IRMAA when no Y-2
  // sample exists).
  const inclusiveMagiByYearIndex = new Map<number, number>();
  const lookbackMinus2For = (yearIndex: number): number | undefined => {
    if (yearIndex >= 2) return inclusiveMagiByYearIndex.get(yearIndex - 2);
    if (yearIndex === 0) return taxCtx.magiBootstrapLookbackMinus2;
    return taxCtx.magiBootstrapLookbackMinus1;
  };

  // `solveForYear` is a NO-OP: the MC path funds ordinary-withdrawal tax via the
  // two-pass fold, so this hook must not add a second tax-funding need.
  const solveForYear = (): TaxCashflowYearOutcome => ({
    addedNeedDollars: 0,
    federalTaxCashNeedCents: 0,
    irmaaWithheldFromSsCents: 0,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 0,
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
    // Record this year's conversion-INCLUSIVE MAGI so year (Y+2)'s IRMAA-line
    // solve sees the surcharge the conversion drives (the Y+2 anchor).
    // This records the SOLVE amount (`convertedDollars`), whereas the
    // deterministic engine records the committed/moved amount. The divergence is
    // NUMERICALLY INERT here: `magiMinus2` drives ONLY the Y+2 IRMAA surcharge,
    // which (a) does not enter the MAGI solve objective and (b) cancels in
    // `fundConversionTaxForYear`'s withConv−withoutConv difference. The funded
    // Y+2 IRMAA flows through the separate committed MagiRing, not this map. Do
    // NOT "fix" this into recording the committed amount — that would be a
    // behavior change with no numeric effect on this path.
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
      // The same Y-2 look-back the conversion solve used for this year — keyed by
      // index, so it is unaffected by the year being recorded above.
      lookbackMinus2For(yearIndex),
      priorBalanceFor(yearIndex),
      priorPreTaxByOwnerFor(yearIndex),
      qcdRmdOffsetByOwnerFor(yearIndex),
    );
    if (baseTaxInput === null) return 0;
    // Same-year incremental federal/IRMAA cash tax the conversion adds: a
    // conversion-inclusive funding solve minus the withdrawals-only solve, using
    // the same composition the MC path funds for ordinary withdrawals.
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
      // MC funds the FULL IRMAA surcharge (no per-member SS split on the path —
      // `assembleMcTaxResult`), so mirror that: cash need + withheld portion.
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
