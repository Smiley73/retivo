import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanStressTestSuccessCard, type PlanStressTestVm } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';

function renderCard(guardrailComparison: PlanStressTestVm['guardrailComparison']): void {
  render(
    <PlanStressTestSuccessCard
      vm={vm({ successTier: 'success', successPct: 95, guardrailComparison })}
    />,
  );
}

describe('guardrail delta pill on the success card', () => {
  it('renders nothing when guardrails are off (comparison absent)', () => {
    renderCard(undefined);
    expect(screen.queryByText(/guardrails/)).not.toBeInTheDocument();
  });

  it('renders nothing while the sibling run is pending', () => {
    renderCard({ state: 'pending', withPct: null, withoutPct: null, deltaPct: null, se: null });
    expect(screen.queryByText(/guardrails/)).not.toBeInTheDocument();
  });

  it('shows a positive delta in the success tone under the headline percentage', () => {
    renderCard({ state: 'ready', withPct: 0.95, withoutPct: 0.92, deltaPct: 0.03, se: 0.01 });
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('+3pp with guardrails').className).toContain('text-positive');
  });

  it('shows a negative delta in the negative tone', () => {
    renderCard({ state: 'ready', withPct: 0.8, withoutPct: 0.85, deltaPct: -0.05, se: 0.01 });
    expect(screen.getByText('-5pp with guardrails').className).toContain('text-negative');
  });

  it('shows "no change" in the neutral tone when the delta does not clear the SE bound', () => {
    renderCard({ state: 'ready', withPct: 0.951, withoutPct: 0.95, deltaPct: 0.001, se: 0.01 });
    expect(screen.getByText('≈ no change with guardrails').className).toContain('text-muted');
  });

  it('shows "no change", never "0pp", when a meaningful delta rounds to 0pp', () => {
    renderCard({ state: 'ready', withPct: 0.953, withoutPct: 0.95, deltaPct: 0.003, se: 0.001 });
    expect(screen.getByText('≈ no change with guardrails')).toBeInTheDocument();
    expect(screen.queryByText(/0pp/)).not.toBeInTheDocument();
  });
});
