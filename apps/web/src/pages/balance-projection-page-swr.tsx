/** "Safe withdrawal rate" tab panel: renders the resolver's bundle (useBalanceProjectionSwrData) off the page's own view model and computes nothing itself.
* It force-mounts with its siblings, so it never flips runStressTest or starts a Monte Carlo run; bare states cover already-retired, insufficient-data and mc-index-out-of-range. */
import React from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { SwrCompositionChart } from '../components/SwrCompositionChart';
import type { TooltipMember } from '../components/tooltip-member';
import { formatCurrencyShort } from '../lib/format-currency';
import type { DisplayMode } from '../lib/view-deflator';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type {
  Aggregate,
  ExpensePayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { McBasis } from '../lib/monte-carlo';
import type { PipelineData } from './balance-projection-page-data';
import type { BalanceProjectionViewModel } from './use-balance-projection-view-model';
import { useBalanceProjectionSwrData } from './use-balance-projection-swr-data';
import type { SwrComparisonBundle } from '../lib/safe-withdrawal-rate-chart-types';
import {
  CARD_SECTION_CLASS,
  SECTION_H2_CLASS,
  MC_REPRESENTATIVE_RUN_SUBLABEL,
} from './balance-projection-page-constants';

export interface BalanceProjectionSwrSectionProps {
  readonly data: PipelineData | null;
  readonly vm: BalanceProjectionViewModel;
  readonly selectedScenarioId: string | null;
  readonly canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly displayMode: DisplayMode;
  readonly activeMethod: ProjectionMethod;
  readonly activeMcBasis: McBasis | null;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
  readonly resolvedLabel: string;
  readonly isMcBasisActive: boolean;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
}

// States the direction in words rather than a sign glyph and never colors the figure: the card compares against a heuristic, it does not verdict the plan.
function formatDelta(delta: number): string {
  if (delta === 0) return 'Exactly matches';
  const magnitude = formatCurrencyShort(Math.abs(delta));
  return delta > 0 ? `${magnitude} above` : `${magnitude} below`;
}

// No page-level guard catches an already-past retirement date; no CTA, since there is nothing to set.
const AlreadyRetired: React.FC = () => (
  <EmptyState bare>
    This scenario&rsquo;s retirement date has already passed, so there&rsquo;s
    no at-retirement portfolio figure to compare against the 4% and 4.5%
    rules — the comparison needs a portfolio total from right at the start of
    retirement.
  </EmptyState>
);

// No page-level guard catches this: the MC run's own retirement boundary sits inside its first modeled year, leaving no accumulation year-end to value the portfolio at (balance-projection-swr-derivation.ts state 6).
// Only a different basis helps: firstYear is shared by every path, so "Show another likely path" would not change it. Never offer the reroll here.
const NoAccumulationYearEnd: React.FC = () => (
  <EmptyState bare>
    We can&rsquo;t value the portfolio under this basis — this example
    path&rsquo;s modeled window starts the same year it reaches retirement,
    so there&rsquo;s no earlier year-end balance to compare against the 4%
    and 4.5% rules. Choosing a different basis above may show the
    comparison.
  </EmptyState>
);

const InsufficientData: React.FC<{ readonly scenarioId: string | null }> = ({
  scenarioId,
}) => (
  <EmptyState
    bare
    action={
      <Link
        to={scenarioId ? `/scenarios/${scenarioId}` : '/scenarios'}
        className="underline"
      >
        Open the scenario editor
      </Link>
    }
  >
    We can&rsquo;t compare this scenario against the 4% and 4.5% rules yet —
    it needs a portfolio balance at retirement and at least one full
    retirement year of planned spending inside this basis&rsquo;s drawdown
    window.
  </EmptyState>
);

// Methodology prose for the (i) popover; this card's portfolio figure differs from the page's summary stats (a known exclusion).
const SwrMethodologyContent: React.FC = () => (
  <div className="flex flex-col gap-2">
    <p className="m-0">
      The 4% and 4.5% rule lines are each rate applied once to your portfolio
      at retirement, held level in today&rsquo;s dollars for every year after
      — a published rule of thumb from the safe-withdrawal-rate literature,
      not a projection of this plan. They&rsquo;re compared against your
      planned portfolio draw after tax, not your total planned spending —
      which also includes Social Security, pensions, and any other income.
    </p>
    <p className="m-0">
      The published 4% and 4.5% rates are stated on the whole amount
      withdrawn from the portfolio, including the tax that withdrawal pays.
      This card compares them against the part left after tax, so a plan can
      show under a rule line here while its total portfolio withdrawal is at
      or above that rate.
    </p>
    <p className="m-0">
      Portfolio at retirement here excludes any cash-balance-plan account you
      elected to annuitize or take as a lump sum before retirement, so it can
      read lower than the total on this page&rsquo;s own summary stats.
    </p>
  </div>
);

// The partial retirement-transition year (isPartialYear) differs from the valuation year under an MC tier, where valuation sits a year earlier; read off the flagged row, never re-derived.
function buildValuationNote(
  bundle: SwrComparisonBundle,
  isMcBasisActive: boolean,
): string {
  const valuationYear = bundle.anchorYear - bundle.valuationOffsetYears;
  const valuedAt = isMcBasisActive
    ? `December ${valuationYear}, the last full year before this example path reaches retirement`
    : `December ${valuationYear}, the year this scenario has you retiring`;
  if (bundle.valuationOffsetYears === 0) {
    return `Your portfolio is valued at ${valuedAt} — the same year the comparison below starts.`;
  }
  const comparisonStart =
    `The comparison below starts ${bundle.anchorYear}, the first full ` +
    `calendar year of retirement`;
  const partialYear = bundle.rows.find((row) => row.isPartialYear)?.year ?? null;
  if (partialYear === null) {
    return `Your portfolio is valued at ${valuedAt}. ${comparisonStart}.`;
  }
  if (partialYear === valuationYear) {
    return (
      `Your portfolio is valued at ${valuedAt}. ${comparisonStart} — ` +
      `${partialYear} is a partial year, charted but not compared against the rules.`
    );
  }
  return (
    `Your portfolio is valued at ${valuedAt}. ${comparisonStart} — ` +
    `${partialYear}, the year in between, is a partial retirement-transition ` +
    `year, charted but not compared against the rules.`
  );
}

const ReadyBody: React.FC<{
  readonly bundle: SwrComparisonBundle;
  readonly retirementYear: number;
  readonly isMcBasisActive: boolean;
  readonly displayMode: DisplayMode;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
}> = ({ bundle, retirementYear, isMcBasisActive, displayMode, tooltipMembers }) => (
  <>
    <p className="m-0 text-sm text-ink">
      {buildValuationNote(bundle, isMcBasisActive)}{' '}
      {displayMode === 'today'
        ? "Figures below are in today's dollars."
        : 'Figures below are in future (nominal) dollars.'}
    </p>
    <StatGrid cols="three" className="mt-4">
      <Stat label="Retirement year" value={retirementYear} />
      <Stat
        label="Portfolio at retirement"
        value={formatCurrencyShort(bundle.portfolioAtRetirement)}
      />
      <Stat
        label="First-full-year portfolio draw (after tax)"
        value={formatCurrencyShort(bundle.anchorAfterTaxDraw)}
      />
    </StatGrid>
    <StatGrid cols="four" className="mt-4">
      <Stat
        label="4% rule: implied spend"
        value={formatCurrencyShort(bundle.fourPercentRule.impliedFirstYearAnnualSpend)}
      />
      <Stat
        label="Your draw vs. the 4% rule"
        value={formatDelta(bundle.fourPercentRule.plannedMinusRuleFirstYearDelta)}
      />
      <Stat
        label="4.5% rule: implied spend"
        value={formatCurrencyShort(
          bundle.fourPointFivePercentRule.impliedFirstYearAnnualSpend,
        )}
      />
      <Stat
        label="Your draw vs. the 4.5% rule"
        value={formatDelta(bundle.fourPointFivePercentRule.plannedMinusRuleFirstYearDelta)}
      />
    </StatGrid>
    {bundle.rows.length >= 2 && (
      <div className="mt-4">
        <SwrCompositionChart
          rows={bundle.rows}
          depletionYear={bundle.depletionYear}
          members={tooltipMembers}
        />
      </div>
    )}
  </>
);

export const BalanceProjectionSwrSection: React.FC<BalanceProjectionSwrSectionProps> = ({
  data,
  vm,
  selectedScenarioId,
  canonicalIncome,
  canonicalExpenses,
  ssBenefits,
  displayMode,
  activeMethod,
  activeMcBasis,
  nowYear,
  nowMonthIndex,
  resolvedLabel,
  isMcBasisActive,
  tooltipMembers,
}) => {
  const result = useBalanceProjectionSwrData({
    data,
    vm,
    selectedScenarioId,
    canonicalIncome,
    canonicalExpenses,
    ssBenefits,
    displayMode,
    activeMethod,
    activeMcBasis,
    nowYear,
    nowMonthIndex,
  });

  // Historical-unavailable and unresolved MC tiers surface in the pinned strip, not here; mc-index-out-of-range does not, so it gets its own state below.
  if (
    result.state === 'historical-unavailable' ||
    result.state === 'mc-run-unavailable'
  ) {
    return null;
  }

  return (
    <section className={CARD_SECTION_CLASS} aria-labelledby="swr-heading">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h2 id="swr-heading" className={SECTION_H2_CLASS}>
            Safe withdrawal rate comparison ({resolvedLabel})
          </h2>
          <ChartInfoPopover label="About the safe withdrawal rate chart">
            <SwrMethodologyContent />
          </ChartInfoPopover>
        </div>
        {isMcBasisActive && (
          <Muted as="p" className="m-0 text-xs">
            {MC_REPRESENTATIVE_RUN_SUBLABEL}
          </Muted>
        )}
      </div>
      {result.state === 'no-retirement-year' && <AlreadyRetired />}
      {(result.state === 'no-runner-result' ||
        result.state === 'no-full-retirement-year') && (
        <InsufficientData scenarioId={selectedScenarioId} />
      )}
      {result.state === 'mc-index-out-of-range' && <NoAccumulationYearEnd />}
      {result.state === 'ok' && result.bundle && (
        <ReadyBody
          bundle={result.bundle}
          retirementYear={vm.primaryRetirementYear ?? result.bundle.anchorYear}
          isMcBasisActive={isMcBasisActive}
          displayMode={displayMode}
          tooltipMembers={tooltipMembers}
        />
      )}
    </section>
  );
};
