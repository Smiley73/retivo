/**
 * Unit tests for BalanceProjectionHistoricalFallbackNote.
 *
 * The component's `joinNames` helper has three branches:
 *   n=1 → bare name ("A")
 *   n=2 → "A and B" (no Oxford comma)
 *   n≥3 → "A, B, and C" (Oxford comma)
 * and a pronoun toggle (isSingle → "This account" / "it"; else "These accounts" / "them").
 * These are the primary behavioural cases this file covers.
 */
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
    // Strong lead text names the single account directly, no conjunction.
    expect(
      screen.getByText(/Historical uses your planned return for Roth IRA\./i),
    ).toBeInTheDocument();
    // Singular pronoun forms ("This account" / "it").
    expect(screen.getByText(/This account/)).toBeInTheDocument();
    expect(screen.getByText(/projects it at/)).toBeInTheDocument();
    // Plural forms must be absent.
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
    // "A and B" — no comma before "and".
    expect(
      screen.getByText(/401\(k\) and Roth IRA\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/401\(k\), Roth IRA/)).not.toBeInTheDocument();
    // Plural pronoun forms.
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
    // "A, B, and C" — comma before final "and".
    expect(
      screen.getByText(/401\(k\), Roth IRA, and HSA\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/These accounts/)).toBeInTheDocument();
    expect(screen.getByText(/projects them at/)).toBeInTheDocument();
  });
});
