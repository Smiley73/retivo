import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { BetaFeaturesProvider, useBetaFeatures } from './BetaFeaturesContext';

const Probe: React.FC = () => {
  const ctx = useBetaFeatures();
  return (
    <div>
      <span data-testid="show">{String(ctx.showBetaFeatures)}</span>
      <span data-testid="guardrails-visible">{String(ctx.isBetaFeatureVisible('guardrails'))}</span>
      <span data-testid="guardrails-offered">{String(ctx.isBetaFeatureOffered('guardrails'))}</span>
      <span data-testid="offered">{ctx.offeredBetaFeatures.map((f) => f.id).join(',')}</span>
      <button type="button" onClick={() => ctx.setShowBetaFeatures(!ctx.showBetaFeatures)}>
        toggle
      </button>
    </div>
  );
};

describe('BetaFeaturesContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to hidden and offers every registered feature', () => {
    render(
      <BetaFeaturesProvider userId="u-1">
        <Probe />
      </BetaFeaturesProvider>,
    );
    expect(screen.getByTestId('show')).toHaveTextContent('false');
    expect(screen.getByTestId('guardrails-visible')).toHaveTextContent('false');
    expect(screen.getByTestId('guardrails-offered')).toHaveTextContent('true');
    expect(screen.getByTestId('offered')).toHaveTextContent('projected-withdrawals,guardrails');
  });

  it('toggling persists per user and makes offered features visible', () => {
    render(
      <BetaFeaturesProvider userId="u-1">
        <Probe />
      </BetaFeaturesProvider>,
    );
    act(() => screen.getByRole('button', { name: 'toggle' }).click());
    expect(screen.getByTestId('show')).toHaveTextContent('true');
    expect(screen.getByTestId('guardrails-visible')).toHaveTextContent('true');
    expect(localStorage.getItem('retivo.betaFeatures.u-1')).toBe('on');
  });

  it('reads a stored "on" preference synchronously on mount', () => {
    localStorage.setItem('retivo.betaFeatures.u-2', 'on');
    render(
      <BetaFeaturesProvider userId="u-2">
        <Probe />
      </BetaFeaturesProvider>,
    );
    expect(screen.getByTestId('show')).toHaveTextContent('true');
  });

  it('never shows a feature the build does not offer, even when switched on', () => {
    localStorage.setItem('retivo.betaFeatures.u-3', 'on');
    render(
      <BetaFeaturesProvider userId="u-3" offeredIds={new Set(['projected-withdrawals'])}>
        <Probe />
      </BetaFeaturesProvider>,
    );
    expect(screen.getByTestId('show')).toHaveTextContent('true');
    expect(screen.getByTestId('guardrails-offered')).toHaveTextContent('false');
    expect(screen.getByTestId('guardrails-visible')).toHaveTextContent('false');
    expect(screen.getByTestId('offered')).toHaveTextContent('projected-withdrawals');
  });

  it('re-reads the preference for the new user on the SAME render the userId changes (no stale frame)', () => {
    localStorage.setItem('retivo.betaFeatures.u-9', 'on');
    // Mount anonymous (off) — the pre-login state — then flip to the opted-in
    // user. Every committed render under u-9 must already read "on".
    const seen: string[] = [];
    const Spy: React.FC = () => {
      seen.push(String(useBetaFeatures().showBetaFeatures));
      return null;
    };
    const { rerender } = render(
      <BetaFeaturesProvider userId={null}>
        <Spy />
      </BetaFeaturesProvider>,
    );
    expect(seen).toEqual(['false']);
    rerender(
      <BetaFeaturesProvider userId="u-9">
        <Spy />
      </BetaFeaturesProvider>,
    );
    expect(seen.slice(1)).not.toContain('false');
    expect(seen.at(-1)).toBe('true');
  });

  it('throws when used outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/within a BetaFeaturesProvider/);
  });
});
