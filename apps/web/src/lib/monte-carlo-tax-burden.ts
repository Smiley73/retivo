/**
 * Monte Carlo tax / health-cost post-pass helper.
 *
 * After the representative-run replay has populated each drawdown-phase
 * `DrawdownYear.accountBalances` map AND `applyMcRmdToRepresentativeYears` has
 * stamped the per-owner `rmdFloorCents`, this post-pass walks the same
 * drawdown-phase rows and stamps `federalTaxCents` / `irmaaSurchargeCents` /
 * `acaPtcSubsidyCents` — the SAME field contract the deterministic
 * `applyTaxIntegrationToDrawdownYears` populates, so the Balance Projection
 * Tax & Health-Cost Burden chart consumes an MC representative run with zero
 * new view-model glue.
 *
 * Methodology parity: the post-pass reuses `monte-carlo-tax.ts`'s OWN
 * per-year helpers — `buildMcTaxYearInput` + the survivor recompute (`deriveMcSurvivors`),
 * the IRMAA MAGI ring, the Roth-basis carrier (`applyMcRothBasisOrdering`), and
 * the penalty fold-in (`computeMcPenaltyDollars`) — NOT a hand-rolled tax glue.
 * The only substitution: per year, the REAL per-account
 * `preWithdrawnCents` / `postWithdrawnCents` / `withdrawn` splits (classified by
 * the ledger `taxTreatment`) replace the kernel's proportional synthetic pool,
 * then flow through the same downstream.
 *
 * Representative DISPLAY cents: this post-pass is the SOLE source of the
 * representative run's stamped tax cents. The named-strategy MC drawdown
 * FUNDS tax per path (the engine's two-pass expense fold lowers the simulated
 * balances), so the captured rows it walks are already the funded (pass-2)
 * drawdown. The per-path success%/percentile arrays are stamped from the
 * funded pass-2 accumulator in `runOnePathViaStrategyEngine`; this post-pass
 * stamps ONLY the representative display cents — so exactly one source stamps
 * the representative cents (no double-stamp).
 *
 * RMD gross-up floor: the post-pass feeds the already-stamped per-owner
 * `rmdFloorCents` (in cents) as `buildMcTaxYearInput`'s `floorCentsOverride`,
 * NOT the kernel's whole-prior-portfolio synthetic floor (which overstates tax
 * on Roth/brokerage-heavy named strategies). This keeps the representative chart
 * on the accurate per-owner floor; the per-path bands (no per-owner RMD
 * post-pass exists) use the synthetic floor, so the two differ slightly by
 * construction. This makes the tax figure self-consistent with the RMD
 * chart on the same rows.
 *
 * Early-withdrawal penalty: `computeMcPenaltyDollars` (§72(t) / HSA /
 * Roth-earnings) is folded into the stamped `federalTaxCents`, matching the
 * deterministic chart (whose `federalTaxCents` includes the penalty). The
 * kernel MC glue keeps the penalty out of `fedTax`, so the post-pass adds it
 * back after calling the glue.
 *
 * IRMAA MAGI ring: advances ONLY on taxed (drawdown) years; year Y reads
 * the taxed-year MAGI from 2 taxed years prior; the first two taxed years use
 * `McTaxContext.magiBootstrapLookbackMinus2` / `magiBootstrapLookbackMinus1`,
 * and with no bootstrap IRMAA is $0 for those years (the deterministic engine
 * estimates those years from the projection; the kernel MC does not).
 *
 * Detect-and-skip: only stamps a run whose drawdown rows carry the
 * per-account `preWithdrawnCents` split (strategy path). A named strategy with
 * no ledger falls back to `runOnePathKernel`, whose representative rows lack
 * that split but already carry valid kernel-funded `federalTaxCents` — the
 * post-pass no-ops there so it never clobbers those values.
 *
 * Lives in its own module (zero additions to the already-over-cap
 * `monte-carlo-tax.ts`).
 *
 * The tax math is explained in docs/math-taxes.md.
 */
import {
  applyTaxYearForFilingPlan,
  centsToDollars,
  dollarsToCents,
  resolveAssumedTaxableYieldConfig,
} from './tax-integration.js';
import {
  advanceMcTaxableIncomeState,
  applyMcRothBasisOrdering,
  buildMcTaxYearInput,
  classifyMcWithdrawal,
  computeMcPenaltyDollars,
  creditMcConversionToBasisCarrier,
  deriveMcSurvivors,
  newMcBrokerageBasisState,
  seedMcAggregateRothBasisCarrier,
  seedMcDesignatedRothPool,
  mcDesignatedRothPoolBalanceDollars,
  type McAccountYearWithdrawal,
  type McTaxableIncomeYearAccount,
  type McWithdrawalClassification,
  type PerYearTaxArgs,
} from './monte-carlo-tax.js';
import type { FilingUnitMagi } from './tax-integration.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';
import type { McTaxPostPassArgs, MonteCarloAccountLedger } from './monte-carlo-types.js';

/** Per-account tax metadata derived once from the ledger, keyed by account id. */
interface LedgerTaxMeta {
  readonly taxTreatment: MonteCarloAccountLedger['taxTreatment'];
  readonly accountType: MonteCarloAccountLedger['accountType'];
  /** The account is INHERITED, so its distribution is made on account of the
   *  original owner's death (§72(t)(2)(A)(ii): no 10% at any beneficiary age). */
  readonly deathExemptInherited?: boolean;
  /** Scenario penalty exemption (id ∈ the exempt-id set), threaded into
   *  the classifier's per-source penalty-exempt accumulation. */
  readonly scenarioPenaltyExempt: boolean;
}

/** Build the per-account `{ taxTreatment, accountType, scenarioPenaltyExempt }`
 *  lookup from the ledger + the scenario exempt-id set. */
function buildLedgerMeta(
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
  scenarioExemptIds: ReadonlySet<string>,
  /** Inherited-account ids (the §72(t)(2)(A)(ii) death exemption). */
  deathExemptIds: ReadonlySet<string> = new Set(),
): Map<string, LedgerTaxMeta> {
  const byId = new Map<string, LedgerTaxMeta>();
  for (const e of ledger) {
    byId.set(e.id, {
      taxTreatment: e.taxTreatment,
      accountType: e.accountType,
      scenarioPenaltyExempt: scenarioExemptIds.has(e.id),
      deathExemptInherited: deathExemptIds.has(e.id),
    });
  }
  return byId;
}

/**
 * Classify ONE drawdown-phase year's per-account withdrawals into the tax
 * buckets, using the REAL per-account pre/post withdrawal split
 * (`preWithdrawnCents` / `postWithdrawnCents`) rather than the kernel's
 * start-of-year balance-ratio proxy. For a MIXED account the pre-tax
 * tranche routes to ordinary income and the post-tax tranche follows
 * `classifyMcWithdrawal`'s own MIXED post-bucket rule — Roth-designated types
 * (401k/403b/457b/TSP) → `rothBasisOrderedDollars` (§408A ordering + the
 * 457(b) penalty exemption), otherwise LTCG-proxy / cash-like by account type
 * (never collapsed to generic POST_TAX, which would mis-tax and
 * mis-penalize the Roth-designated tranche); non-MIXED accounts route their
 * whole `withdrawn` by treatment. Reuses `classifyMcWithdrawal` by
 * synthesising one entry per tranche so the bucket rules stay in one place.
 */
function classifyYear(
  accountBalances: ReadonlyMap<string, DrawdownAccountYear>,
  ledgerMeta: Map<string, LedgerTaxMeta>,
): McWithdrawalClassification {
  const entries: McAccountYearWithdrawal[] = [];
  for (const [id, row] of accountBalances) {
    const meta = ledgerMeta.get(id);
    const taxTreatment = meta?.taxTreatment;
    const accountType = meta?.accountType;
    // Carry the account's scenario penalty exemption onto every tranche
    // synthesized from it, so per-source penalty provenance survives the split.
    const scenarioPenaltyExempt = meta?.scenarioPenaltyExempt === true;
    const deathExemptInherited = meta?.deathExemptInherited === true;
    const preDollars = (row.preWithdrawnCents ?? 0) / 100;
    const postDollars = (row.postWithdrawnCents ?? 0) / 100;
    if (taxTreatment === 'MIXED' && (preDollars > 0 || postDollars > 0)) {
      // Real pre/post split: pre tranche → ordinary income; post tranche →
      // LTCG-proxy / cash-like by type. Carrying the real split is more
      // accurate than the kernel's start-of-year ratio proxy.
      if (preDollars > 0) {
        entries.push({
          taxTreatment: 'PRE_TAX',
          accountType,
          withdrawalDollars: preDollars,
          preBalanceStartDollars: 0,
          postBalanceStartDollars: 0,
          scenarioPenaltyExempt,
          deathExemptInherited,
        });
      }
      if (postDollars > 0) {
        // Route the post tranche through `classifyMcWithdrawal`'s own
        // MIXED post-bucket rule — a Roth-designated type's (401k/403b/457b/
        // TSP) post sub-bucket is §408A Roth-ordered money with the 457(b)
        // penalty exemption, NOT generic POST_TAX; other types keep the
        // LTCG-proxy / cash-like routing. A MIXED entry whose post "balance"
        // carries the whole tranche makes the ratio split exact (preShare 0,
        // postShare = tranche) while keeping the bucket rules in one place.
        entries.push({
          taxTreatment: 'MIXED',
          accountType,
          withdrawalDollars: postDollars,
          preBalanceStartDollars: 0,
          postBalanceStartDollars: postDollars,
          scenarioPenaltyExempt,
          deathExemptInherited,
        });
      }
      continue;
    }
    entries.push({
      taxTreatment,
      accountType,
      withdrawalDollars: row.withdrawn,
      preBalanceStartDollars: row.preEnd,
      postBalanceStartDollars: row.postEnd,
      scenarioPenaltyExempt,
      deathExemptInherited,
    });
  }
  return classifyMcWithdrawal(entries);
}

/** True when this run's drawdown rows carry the per-account `preWithdrawnCents`
 *  split (defense-in-depth). The no-ledger kernel-fallback path funds tax
 *  in-step; this check keeps `applyMcTaxToRepresentativeYears` from
 *  clobbering those kernel-funded tax values when the rows lack the split. */
function hasPerAccountSplit(years: ReadonlyArray<DrawdownYear>): boolean {
  for (const yr of years) {
    if (!yr.accountBalances) continue;
    for (const row of yr.accountBalances.values()) {
      if (row.preWithdrawnCents !== undefined) return true;
    }
  }
  return false;
}

/** MAGI ring-buffer state for the IRMAA 2-year look-back — mirrors the
 *  kernel's `MagiRing`; advances ONLY on taxed years. */
interface MagiRing {
  minus2: number | undefined;
  minus1: number | undefined;
  /** The same two look-back years PER TAX UNIT, so each of a
   *  separate-filing household's returns is tiered on its own look-back. */
  unitsMinus2: readonly FilingUnitMagi[] | undefined;
  unitsMinus1: readonly FilingUnitMagi[] | undefined;
}

/**
 * Stamp `federalTaxCents` / `irmaaSurchargeCents` / `acaPtcSubsidyCents` on each
 * drawdown-phase year of a representative run, in place. Pre-retirement rows (no
 * `accountBalances`) are left untouched. No-ops when no `McTaxContext` /
 * members, or when the run's rows lack the per-account split (defense-in-
 * depth; e.g. the no-ledger kernel-fallback path).
 */
export function applyMcTaxToRepresentativeYears(args: McTaxPostPassArgs): void {
  const { taxCtx } = args;
  if (taxCtx.members.length === 0) return;
  if (!hasPerAccountSplit(args.years)) return; // Keep the kernel-fallback values.

  const ledgerMeta = buildLedgerMeta(
    args.ledger,
    // Per-source scenario penalty exemption for the year classifier.
    new Set(taxCtx.earlyWithdrawalPenaltyExemptAccountIds ?? []),
    // Per-source §72(t)(2)(A)(ii) death exemption (inherited accounts), so
    // the DISPLAYED penalty matches the funded per-path penalty.
    new Set(args.deathExemptAccountIds ?? []),
  );
  // The Roth-basis carrier is seeded once and mutated across taxed years, so a
  // sequential replay reconstructs the same §408A basis evolution the kernel
  // path maintains.
  const rothBasisCarrier = seedMcAggregateRothBasisCarrier(
    taxCtx.rothBasisCentsByOwner,
    taxCtx.rothOrderedProfile,
  );
  // The pooled designated-Roth state, seeded once and mutated across the
  // replayed years for the same reason — its basis and in-plan-rollover lots are
  // consumed cumulatively, so the DISPLAYED tax matches the funded per-path tax.
  const designatedRothPool = seedMcDesignatedRothPool(taxCtx.rothOrderedProfile);
  // Seed the ring from the bootstrap; advance only on taxed years.
  const magi: MagiRing = {
    minus2: taxCtx.magiBootstrapLookbackMinus2,
    minus1: taxCtx.magiBootstrapLookbackMinus1,
    // The per-RETURN look-back, buffered alongside the household scalar
    // so a separate-filing household's DISPLAYED IRMAA is tiered on each
    // return's own look-back exactly as the funded per-path tax is. The two
    // pre-projection bootstrap years carry a household MAGI only, so this
    // starts empty and falls back to the scalar.
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  // Display parity for the taxable-income state (yield drag, evolving basis
  // fraction, cash interest): the SAME shared accumulator the deterministic
  // annotation runs
  // (`advanceMcTaxableIncomeState` → `advanceBrokerageLikeBasis` /
  // `computeCashLikeInterestDollars`), replayed sequentially over the
  // representative rows so the displayed cents carry the yield drag / evolving
  // basis / cash interest. This display post-pass is the accumulator's ONLY MC
  // consumer — the FUNDED per-path fill deliberately omits these inputs (the
  // shared pre-commit approximation that keeps funded balances in cross-engine
  // parity). Start-of-year balances carry across rows; the first drawdown row
  // starts from the drawdown-entry buckets (the LAST accumulation year's
  // captured balances when present, else the ledger initial balances — the
  // already-retired case).
  const basisState = newMcBrokerageBasisState(taxCtx);
  const startBalanceByAccountId = new Map<string, number>();
  const lastAccumulation =
    args.accumulationAccountBalances && args.accumulationAccountBalances.length > 0
      ? args.accumulationAccountBalances[args.accumulationAccountBalances.length - 1]
          .accountBalances
      : undefined;
  for (const e of args.ledger) {
    const accumRow = lastAccumulation?.get(e.id);
    startBalanceByAccountId.set(
      e.id,
      accumRow !== undefined ? accumRow.balance : e.initialPre + e.initialPost,
    );
  }

  // STRICTLY-post-depletion years carry no portfolio (the absorbing-depletion
  // clamp zeroed their balance) and had no real activity, so they owe $0 tax and are
  // skipped. The DEPLETION year itself, however, is also balance-clamped to 0 by
  // the clamp even though it had REAL taxable withdrawals / RMDs / conversions — so it
  // must still be taxed. Skip only `year.year > depletionYear`; when depletionYear
  // is absent/null fall back to the `balance === 0` skip.
  const depletionYear = args.depletionYear ?? null;
  for (const year of args.years) {
    const accountBalances = year.accountBalances;
    if (!accountBalances) continue; // pre-retirement accumulation row.

    // Advance the taxable-income state on EVERY drawdown row — BEFORE the
    // depletion/survivor skip checks below — so the basis evolution stays
    // year-aligned even across skipped years (the deterministic annotation
    // walks every year the same way); then carry each account's year-END
    // balance forward as the next year's start.
    const taxableIncomeRows: McTaxableIncomeYearAccount[] = [];
    for (const e of args.ledger) {
      const row = accountBalances.get(e.id);
      if (row === undefined) continue;
      taxableIncomeRows.push({
        id: e.id,
        taxTreatment: e.taxTreatment,
        accountType: e.accountType,
        startBalanceDollars: startBalanceByAccountId.get(e.id) ?? 0,
        endBalanceDollars: row.balance,
        withdrawnDollars: row.withdrawn,
        depositDollars: row.deposit,
      });
      startBalanceByAccountId.set(e.id, row.balance);
    }
    const taxableIncome = advanceMcTaxableIncomeState(
      taxableIncomeRows,
      basisState,
      resolveAssumedTaxableYieldConfig(taxCtx.taxBundle.assumedTaxableYield, year.year)
        .totalYieldPct,
    );

    if (depletionYear !== null) {
      if (year.year > depletionYear) continue; // strictly post-depletion: untaxed.
    } else if (year.balance === 0) {
      continue;
    }

    const survivorState = deriveMcSurvivors(taxCtx, year.year, args.retirementYear);
    if (survivorState === null) continue; // before retirement / no survivors.

    const yIdx = year.year - args.firstYear;
    const classification = classifyYear(accountBalances, ledgerMeta);
    // Each account's PRE-distribution pre/post buckets for this year (year-END
    // sub-balance plus the sub-bucket's own withdrawal added back) — the same
    // quantity the deterministic per-account designated-Roth path divides by.
    const designatedStartBuckets = new Map<string, { pre: number; post: number }>();
    for (const [id, row] of accountBalances) {
      const preWithdrawn = (row.preWithdrawnCents ?? 0) / 100;
      const postWithdrawn =
        row.postWithdrawnCents !== undefined
          ? row.postWithdrawnCents / 100
          : Math.max(0, row.withdrawn - preWithdrawn);
      designatedStartBuckets.set(id, {
        pre: row.preEnd + preWithdrawn,
        post: row.postEnd + postWithdrawn,
      });
    }
    const perYearArgs: PerYearTaxArgs = {
      taxCtx,
      taxYear: year.year,
      retirementYear: args.retirementYear,
      grossSsDollars: args.ssByYear[yIdx] ?? 0,
      // `nominalExpense` only feeds the (unused) fallback drawdown / netAfterTax
      // path — this display post-pass supplies a full classification, so 0 is
      // INERT here (it walks the already
      // windowed-draw representative rows, so the per-category windowing is
      // reflected via the supplied classification, not the expense scalar).
      nominalExpense: 0,
      otherIncome: args.incomeByYear[yIdx] ?? 0,
      // The year's committed Fill-mode Roth conversion is ADDITIONAL ordinary
      // income — it raises the DISPLAYED federal/IRMAA tax + the post-pass MagiRing
      // (so a conversion's Y+2 IRMAA shows), mirroring the per-path tax fill and the
      // deterministic chart. Not spendable income → never via `otherIncome`.
      additionalOrdinaryIncomeDollars: (year.rothConvertedCents ?? 0) / 100,
      // `priorBalance` is retained for diagnostics; the RMD floor is supplied
      // directly via `floorCentsOverride` (year.rmdFloorCents) below.
      priorBalance: 0,
      // The per-owner RMD floor is bypassed by `floorCentsOverride`
      // (the already-stamped per-owner `rmdFloorCents`), so an empty map is inert.
      priorPreTaxByOwner: new Map<string, number>(),
      // QCD display: the gift is excluded from ordinary income / MAGI
      // EXACTLY ONCE, STRUCTURALLY — the strategy replay debited it from the IRA
      // balance without recording it as a taxable pre-tax withdrawal, so
      // `classification.preTaxDollars` already excludes it, and the offset-reduced
      // `floorOverrideCents` below keeps the gross-up from re-adding it. Threading
      // `qcdIncomeExclusionDollars` here too would double-exclude, diverging
      // from the per-path bands + the deterministic chart; we mirror the
      // deterministic engine, which never sets it.
      magiMinus2: magi.minus2,
      irmaaLookbackUnitsMinus2: magi.unitsMinus2,
      classification,
      // Yield base + evolved basis fraction + cash-like interest —
      // threaded ONLY here (the representative display post-pass); the funded
      // per-path fill deliberately omits them (cross-engine funded parity).
      ...taxableIncome,
      rothBasisCarrier,
      // The pooled designated-Roth state + the year's designated-Roth pocket
      // balance at the START of the year (this replay tracks per-account start
      // balances), the §402A(d)(4) pro-rata denominator.
      ...(designatedRothPool !== undefined
        ? {
            designatedRothPool,
            designatedRothPoolBalanceDollars: mcDesignatedRothPoolBalanceDollars(
              args.ledger,
              designatedStartBuckets,
            ),
          }
        : {}),
    };

    // Mirror of the deterministic engine: the pre-59½ Roth earnings excess is ordinary income.
    const rothEarnings = applyMcRothBasisOrdering(perYearArgs);
    // QCD display: the stamped `rmdFloorCents` is the GROSS IRA-pool
    // RMD floor; the QCD counts toward it, so the TAXABLE floor the gross-up uses
    // is `gross − Σ_owner offset`, clamped ≥ 0 (`netTaxableRmdCents`). Without
    // this the override floor would re-gross-up the QCD-satisfied RMD as phantom
    // taxable income. 0 (no offset) → identical to the no-QCD override.
    const qcdOffsetTotalCents = Object.values(year.qcdRmdOffsetCentsByOwner ?? {}).reduce(
      (sum, c) => sum + c,
      0,
    );
    const floorOverrideCents =
      year.rmdFloorCents === undefined
        ? undefined
        : Math.max(0, year.rmdFloorCents - qcdOffsetTotalCents);
    const taxResult = applyTaxYearForFilingPlan(
      buildMcTaxYearInput(
        perYearArgs,
        survivorState,
        classification.preTaxDollars,
        rothEarnings.earningsExcessDollars,
        // Per-owner RMD floor already stamped by the RMD post-pass, NET of
        // the QCD offset so the QCD-satisfied RMD is not re-taxed.
        floorOverrideCents,
      ),
      taxCtx.taxBundle,
    );
    // Fold the early-withdrawal / HSA / Roth-earnings penalty into the
    // stamped federal tax (the deterministic chart's `federalTaxCents` includes
    // it; the kernel glue keeps it out, so add it back here).
    const penaltyCents = dollarsToCents(
      computeMcPenaltyDollars(perYearArgs, survivorState, rothEarnings.additionalTaxBaseDollars),
    );

    year.federalTaxCents = taxResult.federalTaxCents + penaltyCents;
    year.irmaaSurchargeCents = taxResult.irmaaSurchargeCents;
    year.acaPtcSubsidyCents = taxResult.acaPtcSubsidyCents;

    // Advance the ring on this taxed year only.
    magi.minus2 = magi.minus1;
    magi.minus1 = centsToDollars(taxResult.magiCents);
    magi.unitsMinus2 = magi.unitsMinus1;
    magi.unitsMinus1 = taxResult.filingUnitMagi;

    // Credit this year's converted principal to the aggregate §408A
    // basis carrier AFTER the per-year Roth ordering above, so the DISPLAYED
    // representative-run Roth-withdrawal tax matches the balance path and the
    // deterministic engine. Converted dollars land at year-END → basis only for
    // LATER years' Roth withdrawals, never the same year's.
    creditMcConversionToBasisCarrier(
      rothBasisCarrier,
      year.rothConvertedCents ?? 0,
      // Dated conversion lot (its own five-tax-year recapture window).
      year.year,
    );
  }
}
