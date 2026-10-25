/** BalanceProjectionHistoricalFallbackNote: name joining for one, two and three or more accounts, and the matching pronouns. */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BalanceProjectionHistoricalFallbackNote } from './BalanceProjectionHistoricalFallbackNote';
import { ThemeWrapper } from '../test/theme-render';

describe('BalanceProjectionHistoricalFallbackNote — joinNames + pronoun branches', () => {
  it('n=1: names bare account, uses singular pronouns', () => {
    render(
      <BalanceProjectionHistoricalFallbackNote
        accounts={[{ id: 'a1', name: 'Roth IRA' }]}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText(/Historical uses your planned return for Roth IRA\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/This account/)).toBeInTheDocument();
    expect(screen.getByText(/projects it at/)).toBeInTheDocument();
    expect(screen.queryByText(/These accounts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/projects them at/)).not.toBeInTheDocument();
  });

  it('n=2: joins with "and", no Oxford comma, uses plural pronouns', () => {
    render(
      <BalanceProjectionHistoricalFallbackNote
        accounts={[
          { id: 'a1', name: '401(k)' },
          { id: 'a2', name: 'Roth IRA' },
        ]}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText(/401\(k\) and Roth IRA\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/401\(k\), Roth IRA/)).not.toBeInTheDocument();
    expect(screen.getByText(/These accounts/)).toBeInTheDocument();
    expect(screen.getByText(/projects them at/)).toBeInTheDocument();
  });

  it('n=3: joins with Oxford comma ("A, B, and C"), uses plural pronouns', () => {
    render(
      <BalanceProjectionHistoricalFallbackNote
        accounts={[
          { id: 'a1', name: '401(k)' },
          { id: 'a2', name: 'Roth IRA' },
          { id: 'a3', name: 'HSA' },
        ]}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText(/401\(k\), Roth IRA, and HSA\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/These accounts/)).toBeInTheDocument();
    expect(screen.getByText(/projects them at/)).toBeInTheDocument();
  });
});
