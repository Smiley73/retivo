/**
 * RetirementYearsTable — the under-59½ penalty marker suite.
 *
 * Rows at/before the IRA owner's 59½ boundary (the crossing year inclusive)
 * show the penalized from-IRA break-even + a `†` marker under `source='ira'`;
 * later rows and every non-IRA source stay clean. The Comparison column reads the
 * SAME penalized break-even as the Break-even column, so a penalized row can flip
 * from an above-break-even to an at-or-below-break-even reading.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withTheme } from '../../test/theme-render';
import { RetirementYearsTable } from './RetirementYearsTable';
import type { RetirementYearBETRRow } from '../../lib/betr-calculator';
import type { DrawdownYear } from '../../lib/drawdown-engine-types';

function drawdownYear(year: number): DrawdownYear {
  return {
    year,
    balance: 0,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    magiCents: 100_000_00,
    taxableSsCents: 0,
  };
}

/** A retirement row with a fixed T_now/T_future so the penalty math is
 *  hand-checkable: from-IRA BETR = T_now (0.22), penalized = 0.242. */
function row(year: number, tNow = 0.22, tFuture = 0.23): RetirementYearBETRRow {
  return {
    drawdownYear: drawdownYear(year),
    T_now: tNow,
    T_future: tFuture,
    n: 10,
    tranches: [],
    allInRate: 0.3,
  };
}

function rowEl(year: number): HTMLElement {
  const cell = screen.getByText(String(year));
  const el = cell.closest('[role="row"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function renderTable(
  props: Partial<React.ComponentProps<typeof RetirementYearsTable>> = {},
): void {
  render(
    withTheme(
      'light',
      <RetirementYearsTable
        rows={[row(2028), row(2030), row(2032)]}
        source="ira"
        dragPct={10}
        {...props}
      />,
    ),
  );
}

describe('RetirementYearsTable — under-59½ penalty markers', () => {
  it('marks IRA rows at/before the boundary (inclusive) and leaves later rows clean', () => {
    renderTable({ iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    // 2028 and the 2030 boundary row itself are penalized → carry the † marker.
    expect(rowEl(2028).textContent).toMatch(/†/);
    expect(rowEl(2030).textContent).toMatch(/†/);
    // 2032 is past the boundary → no marker.
    expect(rowEl(2032).textContent).not.toMatch(/†/);
    // Footnote names the owner + the cutoff year.
    expect(screen.getByText(/including Robin/)).toBeInTheDocument();
  });

  it('exposes an sr-only penalty note on penalized rows and none on clean rows', () => {
    renderTable({ iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    // The `†` is aria-hidden, so a screen reader needs a text equivalent on the
    // penalized rows (2028 + the 2030 boundary) but not on the clean 2032 row.
    expect(rowEl(2028).textContent).toMatch(/before 59½ penalty applies/);
    expect(rowEl(2030).textContent).toMatch(/before 59½ penalty applies/);
    expect(rowEl(2032).textContent).not.toMatch(/before 59½ penalty applies/);
  });

  it('flips a penalized boundary row above→at-or-below break-even via the rowVerdict path', () => {
    // T_now 0.22, T_future 0.23. Unpenalized (year > boundary): 0.23 > 0.22 →
    // above break-even. Penalized (year <= boundary): 0.23 > 0.242 is false →
    // at or below break-even.
    renderTable({
      rows: [row(2030), row(2032)],
      iraOwnerBoundary: { year: 2030, firstName: 'Robin' },
    });
    expect(rowEl(2030).textContent).toMatch(/at or below break-even/);
    expect(rowEl(2030).textContent).toMatch(/†/);
    expect(rowEl(2032).textContent).toMatch(/above break-even/);
    expect(rowEl(2032).textContent).not.toMatch(/†/);
  });

  it('shows no markers or footnote for a non-IRA source regardless of the boundary', () => {
    renderTable({ source: 'cash', iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    expect(rowEl(2028).textContent).not.toMatch(/†/);
    expect(rowEl(2030).textContent).not.toMatch(/†/);
    expect(screen.queryByText(/including Robin/)).not.toBeInTheDocument();
  });

  it('shows no markers when no boundary is provided (today’s behavior)', () => {
    renderTable({ iraOwnerBoundary: undefined });
    expect(rowEl(2028).textContent).not.toMatch(/†/);
    expect(screen.queryByText(/early-withdrawal penalty/)).not.toBeInTheDocument();
  });
});
