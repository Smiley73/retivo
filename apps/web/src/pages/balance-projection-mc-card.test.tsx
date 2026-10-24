// BalanceProjectionMcCard: scope and tier header, formatted balance, the em-dash null path and the funded/depleted status line (age, year fallback, bare "Depletes").
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BalanceProjectionMcCard } from './balance-projection-mc-card';
import { expectNoA11yViolations } from '../test/a11y';

describe('BalanceProjectionMcCard', () => {
  it('renders the scope, tier label, and balance value', () => {
    render(
      <BalanceProjectionMcCard scope="At retirement" tier="typical" value={3_571_000} />,
    );
    expect(screen.getByText('At retirement · Typical')).toBeInTheDocument();
    expect(screen.getByText('$3.6M')).toBeInTheDocument();
  });

  it('renders the tier label for each tier', () => {
    const { rerender } = render(
      <BalanceProjectionMcCard scope="At horizon" tier="pessimistic" value={1} />,
    );
    expect(screen.getByText('At horizon · Pessimistic')).toBeInTheDocument();
    rerender(
      <BalanceProjectionMcCard scope="At horizon" tier="badluck" value={1} />,
    );
    expect(screen.getByText('At horizon · Bad-luck')).toBeInTheDocument();
  });

  it('renders an em dash for a null value and no status line', () => {
    render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="typical"
        value={null}
        status={{ funded: true }}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(
      screen.queryByText(/Funds the full horizon/),
    ).not.toBeInTheDocument();
  });

  it('renders the funded status line', () => {
    render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="typical"
        value={3_000_000}
        status={{ funded: true }}
      />,
    );
    expect(screen.getByText('Funds the full horizon')).toBeInTheDocument();
  });

  it('renders a depletion AGE when known', () => {
    render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="badluck"
        value={905_200}
        status={{ funded: false, depletionAge: 91, depletionYear: 2076 }}
      />,
    );
    expect(screen.getByText('Depletes at age 91')).toBeInTheDocument();
  });

  it('falls back to the depletion YEAR when the age is not derivable', () => {
    render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="badluck"
        value={905_200}
        status={{ funded: false, depletionAge: null, depletionYear: 2076 }}
      />,
    );
    expect(screen.getByText('Depletes in 2076')).toBeInTheDocument();
  });

  it('falls back to a bare "Depletes" when neither age nor year is known', () => {
    render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="badluck"
        value={905_200}
        status={{ funded: false }}
      />,
    );
    expect(screen.getByText('Depletes')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <BalanceProjectionMcCard
        scope="At horizon"
        tier="pessimistic"
        value={1_910_400}
        status={{ funded: true }}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
