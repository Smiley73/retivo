/**
 * Tests for the headline success-probability delta pill (and its wiring into the success card).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanStressTestSuccessCard } from './PlanStressTestSection';
import { GuardrailDeltaBadge } from './PlanStressTestCards';
import { vm } from './__fixtures__/plan-stress-test-vm';


describe('GuardrailDeltaBadge — headline success-probability delta pill', () => {
  it('renders nothing when guardrails are off (comparison absent)', () => {
    const { container } = render(
      <GuardrailDeltaBadge comparison={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the sibling run is pending', () => {
    const { container } = render(
      <GuardrailDeltaBadge
        comparison={{ state: 'pending', withPct: null, withoutPct: null, deltaPct: null, se: null }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a sibling-run error', () => {
    const { container } = render(
      <GuardrailDeltaBadge
        comparison={{ state: 'error', withPct: null, withoutPct: null, deltaPct: null, se: null }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a positive delta in the success tone (+Npp with guardrails)', () => {
    render(
      <GuardrailDeltaBadge
        comparison={{ state: 'ready', withPct: 0.95, withoutPct: 0.92, deltaPct: 0.03, se: 0.01 }}
      />,
    );
    const badge = screen.getByText('+3pp with guardrails');
    expect(badge.className).toContain('text-positive');
  });

  it('shows a negative delta in the negative tone (-Npp with guardrails)', () => {
    render(
      <GuardrailDeltaBadge
        comparison={{ state: 'ready', withPct: 0.80, withoutPct: 0.85, deltaPct: -0.05, se: 0.01 }}
      />,
    );
    const badge = screen.getByText('-5pp with guardrails');
    expect(badge.className).toContain('text-negative');
  });

  it('shows "about the same" (neutral tone) when the delta does not clear the SE bound', () => {
    render(
      <GuardrailDeltaBadge
        comparison={{ state: 'ready', withPct: 0.951, withoutPct: 0.95, deltaPct: 0.001, se: 0.01 }}
      />,
    );
    const badge = screen.getByText('≈ no change with guardrails');
    expect(badge.className).toContain('text-muted');
  });

  it('shows "about the same" when a meaningful delta still rounds to 0pp (never renders "0pp")', () => {
    // deltaPct (0.003) clears se (0.001) — statistically meaningful — but
    // rounds to 0 at whole-point display precision. Must not render "0pp".
    render(
      <GuardrailDeltaBadge
        comparison={{ state: 'ready', withPct: 0.953, withoutPct: 0.95, deltaPct: 0.003, se: 0.001 }}
      />,
    );
    expect(screen.getByText('≈ no change with guardrails')).toBeInTheDocument();
    expect(screen.queryByText(/0pp/)).not.toBeInTheDocument();
  });

  it('is wired into the headline success card and appears under the big percentage', () => {
    render(
      <PlanStressTestSuccessCard
        vm={vm({
          successTier: 'success',
          successPct: 95,
          guardrailComparison: { state: 'ready', withPct: 0.95, withoutPct: 0.92, deltaPct: 0.03, se: 0.01 },
        })}
      />,
    );
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('+3pp with guardrails')).toBeInTheDocument();
  });
});
