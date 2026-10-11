/**
 * Guardrails page — live advisory surface.
 *
 * Reads TODAY's funded ratio for the sidebar-selected scenario off actual account
 * balances (via `useGuardrailsVm`) and shows where that ratio falls relative to
 * the selected range — below / within / above — with the scenario's real Monte
 * Carlo modeled success rate as on-demand context. Read-only: the range bands are
 * edited in the scenario editor, which this page links to. It describes the
 * current numbers; it is not a direction to change spending.
 *
 * Thin presentation layer — all the math + the "Check now" MC lifecycle live in
 * `use-guardrails-vm.ts`.
 */
import React from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { StatGrid, Stat } from '../components/StatGrid';
import { EmptyState } from '../components/EmptyState';
import { McProgressBar } from '../components/McProgressBar';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { btnPrimaryClass } from './accounts-page-chrome';
import { formatCurrency } from '../lib/format-currency';
import { useBalanceProjectionData } from './use-balance-projection-data';
import {
  useGuardrailsVm,
  type GuardrailVerdict,
  type GuardrailsConfigView,
  type PosRunState,
} from './use-guardrails-vm';

/** Range position → neutral headline + plain-language body + badge tone. The
 *  tone stays `neutral` for every range position: a below/within/above reading
 *  is a factual reference point, not a safe/unsafe judgment. */
const VERDICT_COPY: Record<
  GuardrailVerdict,
  { readonly headline: string; readonly tone: 'success' | 'negative' | 'neutral' }
> = {
  cut: { headline: 'Below the selected funded range', tone: 'neutral' },
  hold: { headline: 'Within the selected funded range', tone: 'neutral' },
  raise: { headline: 'Above the selected funded range', tone: 'neutral' },
  covered: { headline: 'Guaranteed income covers your spending', tone: 'neutral' },
};

function ratioPctLabel(ratio: number | null): string {
  if (ratio === null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** The funded-ratio range-position body copy — states the current number and
 *  where it falls relative to the scenario's own range edges. Neutral and
 *  descriptive: no instruction to change spending. */
function verdictBody(
  verdict: GuardrailVerdict,
  ratio: number | null,
  config: GuardrailsConfigView,
): string {
  const pct = ratioPctLabel(ratio);
  switch (verdict) {
    case 'cut':
      return `Your funded ratio is ${pct} — at or below the lower edge of your selected range (${config.lowerBandPct}%).`;
    case 'raise':
      return `Your funded ratio is ${pct} — at or above the upper edge of your selected range (${config.upperBandPct}%).`;
    case 'covered':
      return 'Your guaranteed income (Social Security, pensions) already covers all of your remaining planned spending, so your portfolio has nothing left to fund right now.';
    case 'hold':
    default:
      return `Your funded ratio is ${pct} — between the lower (${config.lowerBandPct}%) and upper (${config.upperBandPct}%) edges of your selected range.`;
  }
}

/** Config summary — all 5 tunables + the enabled flag. */
const ConfigSummary: React.FC<{ config: GuardrailsConfigView }> = ({ config }) => (
  <Card className="mb-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="m-0 text-lg font-semibold text-ink">Your spending range thresholds</h2>
      <Badge tone={config.enabled ? 'success' : 'muted'}>
        {config.enabled ? 'On in projections' : 'Off in projections'}
      </Badge>
    </div>
    {config.usingDefaults && (
      <Muted as="p" className="mb-3 text-sm">
        This scenario hasn&rsquo;t set its own range thresholds, so we&rsquo;re
        using the default thresholds below. Configure them in the scenario editor
        to customize.
      </Muted>
    )}
    <StatGrid cols="three">
      <Stat label="Lower range" value={`${config.lowerBandPct}%`} />
      <Stat label="Upper range" value={`${config.upperBandPct}%`} />
      <Stat label="Step size" value={`${config.stepPct}%`} />
      <Stat label="Increase cap" value={`${config.maxRaisePct}%`} />
      <Stat
        label="Discretionary floor"
        value={`${config.discretionaryFloorPct}%`}
      />
    </StatGrid>
  </Card>
);

/** The probability-of-success context block for the settled "Check now" run. */
const PosContext: React.FC<{
  readonly pos: PosRunState;
  readonly progressDone: number;
  readonly progressTotal: number;
}> = ({ pos, progressDone, progressTotal }) => {
  switch (pos.kind) {
    case 'pending':
      return (
        <div role="status" aria-live="polite" className="mt-3">
          <McProgressBar
            done={progressDone}
            total={progressTotal}
            label="Checking your plan's success probability"
          />
        </div>
      );
    case 'ready':
      return (
        <p className="mt-3 text-sm text-ink">
          Your plan&rsquo;s success probability right now is{' '}
          <strong className="tabular-nums">
            {Math.round(pos.successProbabilityPct)}%
          </strong>
          .
        </p>
      );
    case 'timed-out':
      return (
        <Alert tone="warning" className="mt-3">
          The check took too long and was stopped. Try again.
        </Alert>
      );
    case 'error':
      return (
        <Alert tone="error" className="mt-3">
          Something went wrong running the check. Try again.
        </Alert>
      );
    case 'idle':
    default:
      return null;
  }
};

export const GuardrailsPage: React.FC = () => {
  const data = useBalanceProjectionData();
  const vm = useGuardrailsVm();

  const scenarioName =
    data.scenarios.find((s) => s.id === data.selectedScenarioId)?.payload.name ??
    null;

  const header = (
    <PageHeader
      title="Guardrails today"
      subtitle={
        scenarioName
          ? `Where your spending stands today — scenario: ${scenarioName}.`
          : 'Where your spending stands today.'
      }
    />
  );

  if (vm.status === 'loading') {
    return (
      <section>
        {header}
        <Card>
          <Muted>Loading your guardrails&hellip;</Muted>
        </Card>
      </section>
    );
  }

  if (vm.status === 'not-yet-retired') {
    return (
      <section>
        {header}
        <EmptyState>
          Guardrails apply once you begin drawing down your portfolio. This
          scenario retires in {vm.retirementYear}, so check back after
          retirement.
        </EmptyState>
      </section>
    );
  }

  if (vm.status === 'no-accounts') {
    return (
      <section>
        {header}
        <EmptyState
          action={
            <Link to="/account-balances" className="underline">
              Go to Account Balances
            </Link>
          }
        >
          Add an active account with a balance to see today&rsquo;s spending
          range.
        </EmptyState>
      </section>
    );
  }

  if (vm.status === 'scenario-not-configured') {
    return (
      <section>
        {header}
        <EmptyState
          action={
            <Link
              to={
                data.selectedScenarioId
                  ? `/scenarios/${data.selectedScenarioId}`
                  : '/scenarios'
              }
              className="underline"
            >
              Open the scenario editor
            </Link>
          }
        >
          We can&rsquo;t compute a live funded ratio for this scenario yet. Set a
          retirement age (and make sure your accounts and income are configured),
          then come back here.
        </EmptyState>
      </section>
    );
  }

  const { config, ratio, verdict, temperedVerdict, pos } = vm;
  // Range position (below/within/above) is an objective fact of the ratio vs.
  // the configured edges — it is driven by the RAW verdict and never changes
  // based on Monte Carlo odds. Only the `tempered` Alert below reflects the
  // MC-odds context.
  const copy = VERDICT_COPY[verdict];
  const tempered = temperedVerdict !== verdict; // raise → hold on a thin PoS.

  return (
    <section>
      {header}

      <InlineDisclaimerCard
        ariaLabel="Guardrails disclaimer"
        className="mb-4"
      >
        Your range thresholds are model settings — yours, or the defaults until
        you set your own — and the Monte Carlo
        success rate is a statistical, hypothetical estimate. Where the funded
        ratio falls in the range is a reference point, not a direction to change
        your spending or investments.
      </InlineDisclaimerCard>

      <ConfigSummary config={config} />

      <Card className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold text-ink">Current modeled range</h2>
          <Badge tone={copy.tone}>{copy.headline}</Badge>
        </div>
        <StatGrid className="mb-3">
          <Stat label="Funded ratio" value={ratioPctLabel(ratio)} />
          <Stat
            label="Current portfolio"
            value={formatCurrency(vm.portfolioNominal)}
          />
        </StatGrid>
        <p className="m-0 text-sm text-ink">
          {verdictBody(verdict, ratio, config)}
        </p>
        {tempered && (
          <Alert tone="info" className="mt-3">
            Your funded ratio is above the selected range, but the overall modeled
            success rate is only{' '}
            {pos.kind === 'ready' ? `${Math.round(pos.successProbabilityPct)}%` : 'thin'}
            {' '}— below the 80% mark this page uses to flag thin odds.
          </Alert>
        )}
        <Muted as="p" className="mt-3 text-sm">
          The funded ratio measures how well your savings cover the spending your
          guaranteed income doesn&rsquo;t.
        </Muted>
      </Card>

      <Card className="mb-4">
        <h2 className="m-0 mb-2 text-lg font-semibold text-ink">
          Check your odds now
        </h2>
        <p className="m-0 text-sm text-ink">
          Run a fresh Monte Carlo simulation from your current balances to see your
          plan&rsquo;s modeled success rate as context for the range above.
        </p>
        <button
          type="button"
          className={`${btnPrimaryClass} mt-3`}
          onClick={vm.checkNow}
          disabled={pos.kind === 'pending'}
        >
          {pos.kind === 'pending' ? 'Checking…' : 'Check now'}
        </button>
        <PosContext
          pos={pos}
          progressDone={vm.posProgressDone}
          progressTotal={vm.posProgressTotal}
        />
      </Card>

      <Muted as="p" className="text-sm">
        Change your range thresholds in the{' '}
        <Link to={`/scenarios/${vm.scenarioId}`} className="underline">
          scenario editor
        </Link>
        .
      </Muted>
    </section>
  );
};
