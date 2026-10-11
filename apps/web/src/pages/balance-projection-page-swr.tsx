/**
 * Balance Projection page — the "Safe withdrawal rate" tab panel body.
 *
 * Computes nothing of its own: calls the resolver
 * (`useBalanceProjectionSwrData`) against the page's already-resolved view
 * model, renders the card figures straight off the returned bundle, and
 * mounts the stacked composition chart with the bundle's per-year rows —
 * every layer, including the other-income residual and the tooltip's
 * per-source split, passed straight through. This panel force-mounts with
 * its siblings, so it reads only fields the page's own single view-model
 * call already computed; it never flips `runStressTest` or starts a Monte
 * Carlo run of its own.
 *
 * States: the page's existing loading / error / no-accounts / no-history /
 * no-retirement-age guards intercept before any tab renders, and Historical-
 * unavailable / an unresolved Monte Carlo tier surface in the pinned strip
 * and CBP banner outside every panel — this module adds no copy for those
 * (`historical-unavailable` / `mc-run-unavailable` render nothing). Three
 * states have no page-level precedent and get their own bare state here:
 * `already-retired` (a retirement boundary already in the past resolves no
 * at-retirement figure — no CTA, this being no misconfiguration),
 * `insufficient-data` (the resolver reports no usable comparison at all), and
 * `mc-index-out-of-range` (the representative run's own retirement boundary
 * sits inside its own first modeled year, so there is no accumulation-phase
 * year-end to value the portfolio at — the Basis select still offers and
 * enables the tier and nothing else on the page surfaces this, so it is
 * NOT one of the two inherited-blank states above).
 */
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
import type { PipelineData, McBasis } from './balance-projection-page-pipeline';
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
  /** The page's own view model — the SAME object every other tab reads,
   *  never a second `useBalanceProjectionViewModel()` call. */
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
  /** `resolvedBasisLabel(activeMcBasis, activeMethod)` — the same label every
   *  other MC-aware section on this page suffixes onto its own title. */
  readonly resolvedLabel: string;
  readonly isMcBasisActive: boolean;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
}

/** `+$4k above` / `-$4k below` / an exact match — states the DIRECTION in
 *  words rather than a sign glyph, and never colors the figure: this card
 *  compares against a fixed heuristic, it does not verdict the plan. Mirrors
 *  the deleted `RetirementReadinessSwrCard.formatDelta`. */
function formatDelta(delta: number): string {
  if (delta === 0) return 'Exactly matches';
  const magnitude = formatCurrencyShort(Math.abs(delta));
  return delta > 0 ? `${magnitude} above` : `${magnitude} below`;
}

/** No page-level guard catches an already-past retirement date (only "no
 *  retirement age configured at all" is a page-level guard) — so once this
 *  panel mounts, no CTA is offered: there is nothing to set in the scenario
 *  editor, the retirement date already exists. */
const AlreadyRetired: React.FC = () => (
  <EmptyState bare>
    This scenario&rsquo;s retirement date has already passed, so there&rsquo;s
    no at-retirement portfolio figure to compare against the 4% and 4.5%
    rules — the comparison needs a portfolio total from right at the start of
    retirement.
  </EmptyState>
);

/** No page-level guard catches this either: the representative run itself
 *  has arrived and its tier stays enabled on the Basis select, but the
 *  run's OWN retirement boundary sits inside its own first modeled year (a
 *  household retiring later in the current calendar year), leaving no
 *  earlier accumulation-phase year-end to value the portfolio at under this
 *  basis (`balance-projection-swr-derivation.ts` state 6). Unlike
 *  Historical-unavailable / an unresolved MC run, nothing else on the page
 *  surfaces this — the pinned strip and CBP banner report no error.
 *
 *  A different basis is the ONLY remedy offered: `firstYear` is a property
 *  of the shared `MonteCarloInput`, identical for every path in the summary,
 *  so "Show another likely path" replays a different seed against the same
 *  first year and the state's `primaryRetirementYear <= firstYear` test comes
 *  out the same every time. Never offer the reroll here. */
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

/** Methodology prose for the card's `(i)` popover — the after-tax-draw
 *  quantity the rules are compared against, the resulting deviation from
 *  the published rates (which are themselves stated on the withdrawal
 *  BEFORE tax), and a known exclusion (this card's own portfolio figure is not
 *  the same total the page's summary stats show; fixing that stat is a
 *  separate change). */
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

/** Names the year and instant the portfolio is valued, the year the
 *  rule comparison starts, and why they can be up to a year apart. The
 *  partial retirement-TRANSITION year (when one exists — never on a January
 *  1 retirement) is a SEPARATE year from the valuation year: they coincide
 *  on the deterministic path (the transition year IS the valuation year),
 *  but under a Monte Carlo tier the valuation instant sits a full year
 *  earlier still — the representative run's own last accumulation
 *  year-end, not the transition year (see
 *  `balance-projection-swr-derivation.ts`). Read off the row the resolver already
 *  marks `isPartialYear`, never re-derived from `valuationYear`. */
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
  // The retirement TRANSITION year is a partial year (01's `isPartialYear`
  // flag, carried on the first row whenever it applies — rows always start
  // at the transition year) — a DIFFERENT year from `valuationYear` under an
  // MC tier, where the valuation instant sits a further year earlier still
  // (the representative run's own last full accumulation year-end). Never
  // reuse `valuationYear` for both roles.
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

  // Inherited states: Historical-unavailable already disables that option on
  // the Basis select, and an unresolved/vanished MC tier's own option is
  // disabled the same way — both surface in the pinned strip, not here.
  // `mc-index-out-of-range` is NOT one of these (see the module docblock):
  // the tier stays enabled and nothing else on the page says anything, so it
  // gets its own bare state below instead of an empty panel.
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
