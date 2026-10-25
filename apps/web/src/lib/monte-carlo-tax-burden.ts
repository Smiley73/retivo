/** Tax / health-cost display post-pass for the representative run: stamps `federalTaxCents` / `irmaaSurchargeCents` / `acaPtcSubsidyCents`,
 * the same field contract as the deterministic `applyTaxIntegrationToDrawdownYears`. See docs/math-taxes.md. */
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

interface LedgerTaxMeta {
  readonly taxTreatment: MonteCarloAccountLedger['taxTreatment'];
  readonly accountType: MonteCarloAccountLedger['accountType'];
  readonly deathExemptInherited?: boolean;
  readonly scenarioPenaltyExempt: boolean;
}

function buildLedgerMeta(
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
  scenarioExemptIds: ReadonlySet<string>,
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

// Classifies one year from the real per-account pre/post split. A MIXED account's post tranche follows `classifyMcWithdrawal`'s
// MIXED post-bucket rule: Roth-designated types (401k/403b/457b/TSP) go to `rothBasisOrderedDollars` (§408A ordering, 457(b) penalty exemption), never generic POST_TAX.
function classifyYear(
  accountBalances: ReadonlyMap<string, DrawdownAccountYear>,
  ledgerMeta: Map<string, LedgerTaxMeta>,
): McWithdrawalClassification {
  const entries: McAccountYearWithdrawal[] = [];
  for (const [id, row] of accountBalances) {
    const meta = ledgerMeta.get(id);
    const taxTreatment = meta?.taxTreatment;
    const accountType = meta?.accountType;
    const scenarioPenaltyExempt = meta?.scenarioPenaltyExempt === true;
    const deathExemptInherited = meta?.deathExemptInherited === true;
    const preDollars = (row.preWithdrawnCents ?? 0) / 100;
    const postDollars = (row.postWithdrawnCents ?? 0) / 100;
    if (taxTreatment === 'MIXED' && (preDollars > 0 || postDollars > 0)) {
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
        // A MIXED entry whose post balance is the whole tranche makes the ratio split exact (preShare 0, postShare = tranche).
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

// Kernel-fallback runs fund tax in-step and lack the split; skip them so their `federalTaxCents` is not clobbered.
function hasPerAccountSplit(years: ReadonlyArray<DrawdownYear>): boolean {
  for (const yr of years) {
    if (!yr.accountBalances) continue;
    for (const row of yr.accountBalances.values()) {
      if (row.preWithdrawnCents !== undefined) return true;
    }
  }
  return false;
}

interface MagiRing {
  minus2: number | undefined;
  minus1: number | undefined;
  // Same two look-back years per tax unit, so each separate-filing return is tiered on its own look-back.
  unitsMinus2: readonly FilingUnitMagi[] | undefined;
  unitsMinus1: readonly FilingUnitMagi[] | undefined;
}

/**
 * Stamps `federalTaxCents` / `irmaaSurchargeCents` / `acaPtcSubsidyCents` in place on each drawdown-phase year of a representative run.
 * Sole source of the representative's display cents; per-path arrays come from the funded accumulator in `runOnePathViaStrategyEngine`.
 * No-ops without a tax context or members, or when rows lack the per-account split.
 */
export function applyMcTaxToRepresentativeYears(args: McTaxPostPassArgs): void {
  const { taxCtx } = args;
  if (taxCtx.members.length === 0) return;
  if (!hasPerAccountSplit(args.years)) return; // Keep the kernel-fallback values.

  const ledgerMeta = buildLedgerMeta(
    args.ledger,
    new Set(taxCtx.earlyWithdrawalPenaltyExemptAccountIds ?? []),
    // Inherited accounts: §72(t)(2)(A)(ii) death exemption, so the displayed penalty matches the funded per-path penalty.
    new Set(args.deathExemptAccountIds ?? []),
  );
  // The Roth-basis carrier and designated-Roth pool are seeded once and mutated across taxed years, so the sequential replay
  // reproduces the §408A basis evolution (basis and in-plan rollover lots are consumed cumulatively).
  const rothBasisCarrier = seedMcAggregateRothBasisCarrier(
    taxCtx.rothBasisCentsByOwner,
    taxCtx.rothOrderedProfile,
  );
  const designatedRothPool = seedMcDesignatedRothPool(taxCtx.rothOrderedProfile);
  // The IRMAA MAGI ring advances only on taxed years; the first two use `magiBootstrapLookbackMinus1/2`, and with no bootstrap IRMAA is $0 for them.
  const magi: MagiRing = {
    minus2: taxCtx.magiBootstrapLookbackMinus2,
    minus1: taxCtx.magiBootstrapLookbackMinus1,
    // Per-return look-back buffered alongside the household scalar; the two bootstrap years carry a household MAGI only, so it starts empty and falls back to the scalar.
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  // Replays the shared taxable-income accumulator (`advanceMcTaxableIncomeState`) over the representative rows so displayed cents carry yield drag,
  // evolving basis and cash interest; the funded per-path fill omits them to stay in cross-engine parity. The first row starts from the
  // drawdown-entry buckets (last accumulation year's balances, else ledger initials).
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

  // Strictly-post-depletion years carry no portfolio and owe $0, but the depletion year is also balance-clamped to 0 despite real activity,
  // so skip only `year.year > depletionYear`; without a depletion year, skip `balance === 0`.
  const depletionYear = args.depletionYear ?? null;
  for (const year of args.years) {
    const accountBalances = year.accountBalances;
    if (!accountBalances) continue; // pre-retirement accumulation row.

    // Advance the taxable-income state on every drawdown row before the skip checks so basis evolution stays year-aligned across skipped years.
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
      nominalExpense: 0,
      otherIncome: args.incomeByYear[yIdx] ?? 0,
      // A committed Fill-mode conversion is additional ordinary income (raises displayed tax and the MagiRing so its Y+2 IRMAA shows), not spendable income, so never via `otherIncome`.
      additionalOrdinaryIncomeDollars: (year.rothConvertedCents ?? 0) / 100,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      // The QCD gift is excluded from ordinary income exactly once, structurally: the replay debited it without recording a taxable withdrawal,
      // so `preTaxDollars` already excludes it and the offset-reduced floor stops the gross-up re-adding it. Setting `qcdIncomeExclusionDollars` too would double-exclude.
      magiMinus2: magi.minus2,
      irmaaLookbackUnitsMinus2: magi.unitsMinus2,
      classification,
      ...taxableIncome,
      rothBasisCarrier,
      // Pooled designated-Roth state and the start-of-year designated-Roth pocket balance, the §402A(d)(4) pro-rata denominator.
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
    // `rmdFloorCents` is the gross IRA-pool floor; the taxable floor is `gross - Σ owner offset`, clamped at 0 (`netTaxableRmdCents`),
    // so a QCD-satisfied RMD is not re-grossed as phantom income.
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
        // Per-owner RMD floor from the RMD post-pass (net of QCD), not the kernel's whole-portfolio synthetic floor, which overstates tax for Roth/brokerage-heavy strategies.
        floorOverrideCents,
      ),
      taxCtx.taxBundle,
    );
    // The early-withdrawal, HSA and Roth-earnings penalty (§72(t)) is folded into `federalTaxCents` as in the deterministic chart; the kernel glue keeps it out.
    const penaltyCents = dollarsToCents(
      computeMcPenaltyDollars(perYearArgs, survivorState, rothEarnings.additionalTaxBaseDollars),
    );

    year.federalTaxCents = taxResult.federalTaxCents + penaltyCents;
    year.irmaaSurchargeCents = taxResult.irmaaSurchargeCents;
    year.acaPtcSubsidyCents = taxResult.acaPtcSubsidyCents;

    magi.minus2 = magi.minus1;
    magi.minus1 = centsToDollars(taxResult.magiCents);
    magi.unitsMinus2 = magi.unitsMinus1;
    magi.unitsMinus1 = taxResult.filingUnitMagi;

    // Credit converted principal to the §408A basis carrier after this year's Roth ordering: conversions land at year-end, so they are basis only for later years.
    creditMcConversionToBasisCarrier(
      rothBasisCarrier,
      year.rothConvertedCents ?? 0,
      // Dated conversion lot (its own five-tax-year recapture window).
      year.year,
    );
  }
}
