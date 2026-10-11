/**
 * Render tests for `GuardrailsComparisonCallout` — the
 * seed-paired with/without-guardrails callout on the Balance Projection stats
 * surface. Covers all five `GuardrailComparisonVm` shapes: absent (renders
 * nothing), pending, error, meaningful raise, and "about the same"/no-signal.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GuardrailsComparisonCallout } from './balance-projection-page-stats';
import type { GuardrailComparisonVm } from '../components/PlanStressTestSection';

describe('GuardrailsComparisonCallout', () => {
  it('renders nothing when the comparison is absent (undefined)', () => {
    const { container } = render(<GuardrailsComparisonCallout comparison={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the pending copy while the sibling run is in flight', () => {
    const comparison: GuardrailComparisonVm = {
      state: 'pending',
      withPct: 0.9,
      withoutPct: null,
      deltaPct: null,
      se: null,
    };
    render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(screen.getByRole('status')).toHaveTextContent(/comparing your plan/i);
  });

  it('renders the fallback copy on a sibling-run error', () => {
    const comparison: GuardrailComparisonVm = {
      state: 'error',
      withPct: 0.9,
      withoutPct: null,
      deltaPct: null,
      se: null,
    };
    render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(screen.getByText(/couldn't compare your plan/i)).toBeInTheDocument();
  });

  it('renders "raise success" messaging for a meaningful positive delta', () => {
    // Delta 0.15 clears the SE bound (0.01) → meaningful raise.
    const comparison: GuardrailComparisonVm = {
      state: 'ready',
      withPct: 0.9,
      withoutPct: 0.75,
      deltaPct: 0.15,
      se: 0.01,
    };
    render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(screen.getByText(/raise your plan's success/i)).toBeInTheDocument();
    // From 75% to 90%.
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('renders the "about the same" messaging for a below-SE delta', () => {
    // Delta 0.005 is below the SE bound (0.02) → no signal.
    const comparison: GuardrailComparisonVm = {
      state: 'ready',
      withPct: 0.905,
      withoutPct: 0.9,
      deltaPct: 0.005,
      se: 0.02,
    };
    render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(screen.getByText(/about the same/i)).toBeInTheDocument();
  });

  it('renders the neutral versus copy for a meaningful negative delta', () => {
    // Delta -0.12 clears the SE bound → guardrails lower success this sample.
    const comparison: GuardrailComparisonVm = {
      state: 'ready',
      withPct: 0.7,
      withoutPct: 0.82,
      deltaPct: -0.12,
      se: 0.01,
    };
    render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(screen.getByText(/your plan's success is/i)).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
  });

  it('renders nothing when a ready comparison is missing a numeric field', () => {
    const comparison: GuardrailComparisonVm = {
      state: 'ready',
      withPct: 0.9,
      withoutPct: null,
      deltaPct: null,
      se: null,
    };
    const { container } = render(<GuardrailsComparisonCallout comparison={comparison} />);
    expect(container).toBeEmptyDOMElement();
  });
});
