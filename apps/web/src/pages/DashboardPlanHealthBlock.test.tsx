// DashboardPlanHealthBlock: freshness gate, resolved Typical/Pessimistic grid and table semantics.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardPlanHealthBlock } from './DashboardPlanHealthBlock';
import { vm } from '../components/__fixtures__/plan-stress-test-vm';
import { expectNoA11yViolations } from '../test/a11y';

describe('DashboardPlanHealthBlock', () => {
  // Freshness gate: a vm can look fully resolved when the Monte Carlo result belongs to a different scenario (the app-wide provider keeps it after another surface ran), so the gate must key on `stressPairSignature`, not `isStale
  // isRunning`.
  it('blanks every simulation-derived figure and marks the section busy when stressPairSignature is null', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({
          isStale: false,
          isRunning: false,
          successPct: 92,
          successTier: 'success',
          endTypical: 1_400_000,
          endPessimistic: 820_000,
          typicalDepletionYear: null,
          pessimisticDepletionYear: 2055,
          stressPairSignature: null,
        })}
      />,
    );
    expect(screen.getByText('calculating plan success…')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(5);
    expect(screen.queryByText('92%')).not.toBeInTheDocument();
    expect(screen.queryByText('$1.4M')).not.toBeInTheDocument();
    expect(screen.queryByText('2055')).not.toBeInTheDocument();

    const section = screen
      .getByText('Retirement readiness')
      .closest('section');
    expect(section).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the resolved success percent, band qualifier and both ending balances', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({
          successPct: 92,
          successTier: 'success',
          endTypical: 1_400_000,
          endPessimistic: 820_000,
          stressPairSignature: 'sig-1',
        })}
      />,
    );
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('At or above 85%')).toBeInTheDocument();
    expect(screen.getByText('$1.4M')).toBeInTheDocument();
    expect(screen.getByText('$820k')).toBeInTheDocument();

    const section = screen
      .getByText('Retirement readiness')
      .closest('section');
    expect(section).toHaveAttribute('aria-busy', 'false');
  });

  it('reads "Never" in both columns when neither path depletes', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({
          typicalDepletionYear: null,
          pessimisticDepletionYear: null,
          stressPairSignature: 'sig-1',
        })}
      />,
    );
    expect(screen.getAllByText('Never')).toHaveLength(2);
  });

  it('renders a bare four-digit depletion year in one column while the other still reads "Never"', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({
          typicalDepletionYear: 2055,
          pessimisticDepletionYear: null,
          stressPairSignature: 'sig-1',
        })}
      />,
    );
    // Bare year, not run through a locale number formatter (which would
    // produce "2,055").
    expect(screen.getByText('2055')).toBeInTheDocument();
    expect(screen.queryByText('2,055')).not.toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('gives the grid real table semantics: column headers and row headers', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({ stressPairSignature: 'sig-1' })}
      />,
    );
    expect(
      screen.getByRole('columnheader', { name: 'Typical' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Pessimistic' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: 'Ending balance' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: 'Money runs out' }),
    ).toBeInTheDocument();
  });

  it('uses no statistics vocabulary anywhere, resolved or pending', () => {
    const { container: resolved } = render(
      <DashboardPlanHealthBlock
        vm={vm({
          successPct: 55,
          successTier: 'danger',
          typicalDepletionYear: 2055,
          pessimisticDepletionYear: 2050,
          stressPairSignature: 'sig-1',
        })}
      />,
    );
    const { container: pending } = render(
      <DashboardPlanHealthBlock vm={vm({ stressPairSignature: null })} />,
    );
    for (const text of [resolved.textContent, pending.textContent]) {
      expect(text).not.toMatch(/P25|P50|median|percentile|25th/i);
    }
  });

  it('keeps the simulation-derived figures inside a polite live region', () => {
    render(
      <DashboardPlanHealthBlock
        vm={vm({ successPct: 92, stressPairSignature: 'sig-1' })}
      />,
    );
    const heroLiveRegion = screen.getByText('92%').closest('[aria-live="polite"]');
    expect(heroLiveRegion).not.toBeNull();
    const gridLiveRegion = screen
      .getByRole('columnheader', { name: 'Typical' })
      .closest('[aria-live="polite"]');
    expect(gridLiveRegion).not.toBeNull();
  });

  it('has no a11y violations, resolved', async () => {
    const { container } = render(
      <DashboardPlanHealthBlock
        vm={vm({ successPct: 92, stressPairSignature: 'sig-1' })}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
