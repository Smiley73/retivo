/** The seed-paired with/without-guardrails callout rendered through `BalanceProjectionStats`, across the five `GuardrailComparisonVm` shapes. */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BalanceProjectionStats } from './balance-projection-page-stats';
import type { GuardrailComparisonVm, PlanStressTestVm } from '../components/PlanStressTestSection';

function renderStats(comparison: GuardrailComparisonVm | undefined) {
  const stressVm = {
    hasNoAccounts: false,
    isStale: false,
    isRunning: false,
    guardrailComparison: comparison,
    startTypical: null,
    startPessimistic: null,
    startBadLuck: null,
    endTypical: null,
    endPessimistic: null,
    endBadLuck: null,
    typicalDepletionYear: null,
    pessimisticDepletionYear: null,
    badLuckDepletionYear: null,
  } as unknown as PlanStressTestVm;
  return render(
    <BalanceProjectionStats
      methodOrder={[]}
      methodLabels={{} as never}
      displayedTotals={null}
      enabledCalculatedMethods={new Set()}
      drawdownByMethod={null}
      retirementYear={null}
      cashflowFromYear={null}
      lastDeathYear={null}
      viewDeflator={() => 1}
      stressVm={stressVm}
      primaryBirthYear={null}
    />,
  );
}

const ready = (withPct: number, withoutPct: number, deltaPct: number, se: number): GuardrailComparisonVm => ({
  state: 'ready',
  withPct,
  withoutPct,
  deltaPct,
  se,
});

describe('GuardrailsComparisonCallout', () => {
  it('renders nothing when the comparison is absent', () => {
    renderStats(undefined);
    expect(screen.queryByText(/guardrails/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the pending copy while the sibling run is in flight', () => {
    renderStats({ state: 'pending', withPct: 0.9, withoutPct: null, deltaPct: null, se: null });
    expect(screen.getByRole('status')).toHaveTextContent(/comparing your plan/i);
  });

  it('renders the fallback copy on a sibling-run error', () => {
    renderStats({ state: 'error', withPct: 0.9, withoutPct: null, deltaPct: null, se: null });
    expect(screen.getByText(/couldn't compare your plan/i)).toBeInTheDocument();
  });

  it('renders "raise success" messaging for a delta that clears the SE bound', () => {
    renderStats(ready(0.9, 0.75, 0.15, 0.01));
    expect(screen.getByText(/raise your plan's success/i)).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('renders the "about the same" messaging for a below-SE delta', () => {
    renderStats(ready(0.905, 0.9, 0.005, 0.02));
    expect(screen.getByText(/about the same/i)).toBeInTheDocument();
  });

  it('renders the neutral versus copy for a negative delta that clears the SE bound', () => {
    renderStats(ready(0.7, 0.82, -0.12, 0.01));
    expect(screen.getByText(/your plan's success is/i)).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
  });

  it('renders nothing when a ready comparison is missing a numeric field', () => {
    renderStats({ state: 'ready', withPct: 0.9, withoutPct: null, deltaPct: null, se: null });
    expect(screen.queryByText(/guardrails/i)).not.toBeInTheDocument();
  });
});
