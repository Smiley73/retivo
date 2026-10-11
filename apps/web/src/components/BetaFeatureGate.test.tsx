import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import type { BetaFeatureId } from '../lib/feature-flags';
import { expectNoA11yViolations } from '../test/a11y';
import { BetaFeatureGate } from './BetaFeatureGate';

function renderGate(opts: { on: boolean; offered?: ReadonlySet<BetaFeatureId> }) {
  if (opts.on) localStorage.setItem('retivo.betaFeatures.u-1', 'on');
  return render(
    <MemoryRouter>
      <BetaFeaturesProvider userId="u-1" offeredIds={opts.offered}>
        <BetaFeatureGate feature="guardrails">
          <p>the real page</p>
        </BetaFeatureGate>
      </BetaFeaturesProvider>
    </MemoryRouter>,
  );
}

describe('BetaFeatureGate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the page when the feature is visible', () => {
    renderGate({ on: true });
    expect(screen.getByText('the real page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Guardrails today' })).not.toBeInTheDocument();
  });

  it('points to Preferences when the build offers the feature but the user has it off', async () => {
    const { container } = renderGate({ on: false });
    expect(screen.queryByText('the real page')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Guardrails today' })).toBeInTheDocument();
    expect(screen.getByText(/This is a beta feature/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Preferences' })).toHaveAttribute(
      'href',
      '/profile',
    );
    await expectNoA11yViolations(container);
  });

  it('says the feature is unavailable when the build does not offer it, even with the switch on', () => {
    renderGate({ on: true, offered: new Set<BetaFeatureId>(['projected-withdrawals']) });
    expect(screen.queryByText('the real page')).not.toBeInTheDocument();
    expect(screen.getByText(/not available in this version/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });
});
