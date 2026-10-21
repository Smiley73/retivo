/**
 * Standing estimate disclosure for the Balance Projection page.
 *
 * The projection now FUNDS the federal tax, Medicare IRMAA, and ACA
 * premium-tax-credit figures: the drawdown engine raises each year's
 * withdrawal to cover the estimated tax / health-cost bill, so these
 * numbers reduce the projected balances and can move the depletion year.
 * This note frames them as balance-affecting ESTIMATES (not exact tax
 * filings) so a reader treats the figures as a planning guide.
 *
 * Qualification: the yield / cash-interest / evolving-cost-basis tax
 * components are DISPLAY-exact but deliberately NOT funded into either
 * engine's balance progression (the funding solvers keep the shared
 * pre-commit approximation). The "What is not modeled" paragraph discloses
 * that portion as display-only so the funded assurance above stays accurate
 * for households with taxable brokerage / savings / money-market / CD
 * balances.
 *
 * The standard-deduction-only paragraph is ALWAYS ON. It is a blanket
 * disclosure, not a materiality-triggered warning: the itemized/AMT/QBI gap
 * is one-sided (a household that itemizes owes LESS than shown), and the
 * projection has no itemizable-expense inventory to size the gap from, so a
 * heuristic trigger would be an unlabeled assumption.
 *
 * The always-on health-coverage paragraph covers the rough age-priced ACA
 * benchmark and its assumptions, plus the fact that only the Medicare
 * income-related surcharge is modeled. The CONDITIONAL missing-premium
 * readiness warning fires only on positive evidence (an IRMAA surcharge is
 * charged while the plan records no medical spending at all).
 *
 * Follows the `OptimizerDisclaimerCard` precedent: a `role="note"` card
 * announced to assistive tech, styled with Tailwind defaults + the typed
 * component idiom (no inline style, no arbitrary-value utilities). Body
 * copy renders at the page baseline `text-sm`.
 */
import React from 'react';
// The single source of truth for the rough age-premium curve, so this
// disclosure can never quote a price the engine no longer charges.
import { ROUGH_BENCHMARK_ASSUMPTIONS } from '../lib/aca-ptc';

export interface BalanceProjectionEstimateNoteProps {
  /**
   * True when at least one projection year's Medicare IRMAA surcharge was
   * estimated from the projected first-year income because the member is on
   * Medicare in the first one or two retirement years and no historical
   * (two-years-prior) MAGI was provided. Adds the projected-first-year-MAGI
   * disclosure line to this note. Defaults to false.
   */
  readonly magiEstimatedFromProjection?: boolean;
  /**
   * True when a Monte Carlo basis is active. Every MC basis funds
   * tax from the portfolio each year (Combined-Pot and the named strategies
   * alike), so the simulated-run wording still states the figures reduce the
   * projected balances. Defaults to false (deterministic render verbatim).
   */
  readonly isMcBasisActive?: boolean;
  /**
   * True when the projection charges a Medicare income-related
   * surcharge while the plan records no medical spending at all, so the base
   * Medicare premium (a user-entered medical expense) is missing. Adds the
   * readiness warning below. Defaults to false.
   */
  readonly medicareBasePremiumMissing?: boolean;
  /**
   * True when at least one projection year has a household income at or below
   * 138% of the federal poverty line while someone is on a Marketplace plan,
   * so Medicaid may cover the household instead. Adds the Medicaid paragraph.
   * Defaults to false.
   */
  readonly medicaidMayApply?: boolean;
}

export const BalanceProjectionEstimateNote: React.FC<
  BalanceProjectionEstimateNoteProps
> = ({
  magiEstimatedFromProjection = false,
  isMcBasisActive = false,
  medicareBasePremiumMissing = false,
  medicaidMayApply = false,
}) => (
  <div
    className="my-3 rounded-lg border border-line bg-surface-raised p-5 shadow-sm"
    role="note"
    aria-label="Tax, IRMAA, and ACA estimate disclosure"
  >
    <p className="m-0 text-sm text-muted">
      <strong className="text-ink">
        Estimates only.
      </strong>{' '}
      The federal tax, Medicare IRMAA, and ACA premium-tax-credit figures
      shown here are estimates,{' '}
      {isMcBasisActive
        ? 'these figures are estimated for the simulated run, and the simulation funds them from the portfolio each year, so they reduce its projected balances and can move the year your savings run out.'
        : 'and the projection now pulls extra from your portfolio each year to fund them, so they reduce your projected balances and can move the year your savings run out.'}{' '}
      Treat them as a planning guide to the general size of the tax and health
      costs your plan may face.
    </p>
    <p className="m-0 mt-3 text-sm text-muted">
      <strong className="text-ink">
        Standard deduction only.
      </strong>{' '}
      Every year is estimated using the standard deduction — including the extra
      amount for people 65 and older and the new senior bonus deduction — and
      never itemized deductions. The alternative minimum tax and the deduction
      for qualified business income are not modeled either. If you itemize
      (large mortgage interest, charitable gifts, or medical bills, for
      example), your real tax could be meaningfully lower than the figures
      shown here. This applies to every scenario, whatever your filing choice.
    </p>
    <p className="m-0 mt-3 text-sm text-muted">
      <strong className="text-ink">
        Health coverage costs.
      </strong>{' '}
      The Marketplace subsidy is worked out from a rough estimated benchmark
      plan price — ${ROUGH_BENCHMARK_ASSUMPTIONS.baseMonthlyDollars.toLocaleString('en-US')} a month for a{' '}
      {ROUGH_BENCHMARK_ASSUMPTIONS.baseAge}-year-old, rising{' '}
      {Math.round(ROUGH_BENCHMARK_ASSUMPTIONS.ageGrowthRate * 100)}% for each year
      of age, counted for each covered person and only for the months they are
      covered. From {ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows
      every year at the scenario&rsquo;s medical inflation rate. That is an
      estimate, not a real quote from your exchange; enter your own benchmark
      price in the scenario&rsquo;s health coverage settings to replace it, and
      it is used exactly as entered. The projection also estimates only the Medicare
      income-related surcharge (IRMAA). The base Medicare premium, Medigap,
      Medicare Advantage, and drug-plan premiums are yours to enter as Medical
      expenses — if you have not, your health costs in retirement are
      understated.
    </p>
    {medicareBasePremiumMissing && (
      <p className="m-0 mt-3 text-sm text-muted">
        <strong className="text-ink">
          Medicare premiums are missing.
        </strong>{' '}
        This plan is charged a Medicare income-related surcharge, but it has no
        medical spending at all. The base Medicare premium and any Medigap,
        Medicare Advantage, or drug-plan premiums are yours to enter as Medical
        expenses — until you do, this plan understates what you will actually
        pay for health care.
      </p>
    )}
    {medicaidMayApply && (
      <p className="m-0 mt-3 text-sm text-muted">
        <strong className="text-ink">
          Medicaid may apply.
        </strong>{' '}
        In at least one year your income is at or below 138% of the federal
        poverty line while you are on a Marketplace plan. Depending on your
        state, Medicaid may cover your household instead of a Marketplace plan
        in that year. Retivo does not model states or Medicaid, so the figures
        shown here do not assume Medicaid; the Marketplace credit shown between
        100% and 138% of the poverty line is what a state that did not expand
        Medicaid would give. Medicaid is not free money: states seek repayment
        from the estates of people who received it at 55 or older.
      </p>
    )}
    <p className="m-0 mt-3 text-sm text-muted">
      What is not modeled: only federal income tax is estimated (no state tax).
      Early-withdrawal penalties use simple age rules and do
      not check the detailed exceptions (such as disability or 72(t) payment
      plans). For taxable brokerage accounts, the displayed tax uses an
      estimated year-by-year cost basis seeded from a planning percentage you
      set — an estimate, not your actual purchase records. The displayed tax
      figures also include the yearly tax on estimated investment yield inside
      taxable brokerage accounts and on savings, money-market, and CD
      interest. These yield, interest, and cost-basis amounts refine the tax
      shown, but they are not yet pulled from the portfolio — the projected
      balances do not subtract that portion, so the balances shown may be
      slightly higher than they would be after paying it. Tax-exempt
      (municipal-bond) interest is
      modeled as zero at this projection layer. In practice this means it is
      not added back into the income figures used for Social Security
      provisional income (which determines what fraction of your SS benefit is
      taxable), IRMAA, ACA premium-tax-credit thresholds, or federal income
      tax. If you hold significant municipal-bond positions, your actual tax
      burden may be lower than estimated here.
    </p>
    {magiEstimatedFromProjection && (
      <p className="m-0 mt-3 text-sm text-muted">
        First-year Medicare surcharge estimated from your projected first-year
        income; no historical (two-years-prior) MAGI was provided. Medicare's
        IRMAA surcharge normally looks at your tax return from two years prior,
        so the first retirement year uses your projected first-year income as a
        stand-in. Enter your pre-retirement income in the scenario's withdrawal
        settings to replace this estimate. Because the first-year income is
        still being projected while the surcharge is calculated, the displayed
        surcharge is a planning guide only — it is not deducted from the
        projected balance for that year.
      </p>
    )}
  </div>
);
