/**
 * AccountBalanceStackBand — unit tests.
 *
 * Covers: group-by toggle label reflects strategy; Show-excluded toggle render
 * + suppression (accounts surface); per-account groupBy renders account radio;
 * Type-grouping sub-bucket split; conditional title (method suffix vs bare);
 * dashed boundary marker at the last actual year; per-zone `data-zone`
 * (actual / carried / projected) DOM contract; continuous span; stale-balance
 * gap; a11y smoke for both surfaces.
 *
 * Chart and zoom hooks mocked at module boundary; the mocked inner chart
 * records the rows + series + boundary so zone + aggregation assertions read
 * them directly.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';

// Capture what the band hands the (mocked) inner chart.
const chartSpy = vi.hoisted(() => ({
  rows: null as unknown,
  series: null as unknown,
  boundary: null as unknown,
}));

vi.mock('../components/AccountBalanceStackChart', () => ({
  AccountBalanceStackChart: (props: {
    rows: unknown;
    series: unknown;
    boundary: unknown;
  }) => {
    chartSpy.rows = props.rows;
    chartSpy.series = props.series;
    chartSpy.boundary = props.boundary;
    return <div data-testid="account-balance-stack-chart" />;
  },
}));

vi.mock('../lib/use-chart-zoom', () => ({
  useChartZoom: () => ({
    xDomain: undefined,
    yDomain: null,
    isZoomed: false,
    isDragging: false,
    dragSelection: null,
    mouseHandlers: {},
    reset: vi.fn(),
  }),
}));

vi.mock('../lib/use-chart-tokens', () => ({
  useChartColors: () => ({
    acctPreTax: '#3b82f6',
    acctRoth: '#10b981',
    acctTaxable: '#f59e0b',
    acctHsa: '#8b5cf6',
    acctCash: '#64748b',
    acctExcluded: '#94a3b8',
  }),
}));

import {
  AccountBalanceStackBand,
  type StackBandYear,
} from './balance-projection-page-account-balance-stack';
import type { SeriesZone } from '../components/charts';
import type { AccountTaxTreatment, AccountType } from '../db/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface SimpleMeta {
  id: string;
  name: string;
  type: AccountType;
  taxTreatment?: AccountTaxTreatment;
}

/** Build a unified band year: per-account trio + zone. `carried` ids are
 *  flagged carried-forward. */
function bandYear(
  year: number,
  zone: 'actual' | 'projected',
  balances: Record<string, number>,
  carried: ReadonlySet<string> = new Set(),
): StackBandYear {
  const map = new Map(
    Object.entries(balances).map(([id, bal]) => [
      id,
      {
        balance: bal,
        preEnd: bal,
        postEnd: 0,
        carriedForward: carried.has(id),
      },
    ]),
  );
  return { year, zone, accountBalances: map };
}

function bandYearSplit(
  year: number,
  zone: 'actual' | 'projected',
  buckets: Record<string, { preEnd: number; postEnd: number }>,
): StackBandYear {
  const map = new Map(
    Object.entries(buckets).map(([id, { preEnd, postEnd }]) => [
      id,
      { balance: preEnd + postEnd, preEnd, postEnd, carriedForward: false },
    ]),
  );
  return { year, zone, accountBalances: map };
}

const BASE_ACCOUNTS: SimpleMeta[] = [
  { id: 'acct-ira', name: 'My IRA', type: 'RETIREMENT_IRA' },
  { id: 'acct-roth', name: 'My Roth', type: 'RETIREMENT_ROTH_IRA' },
];

const BASE_ROWS: StackBandYear[] = [
  bandYear(2030, 'actual', { 'acct-ira': 100_000, 'acct-roth': 50_000 }),
  bandYear(2031, 'projected', { 'acct-ira': 90_000, 'acct-roth': 45_000 }),
];

function zonesFor(name: string): SeriesZone[] {
  const series = chartSpy.series as Array<{ name: string; zones?: SeriesZone[] }>;
  return series.find((s) => s.name === name)?.zones ?? [];
}

// ---------------------------------------------------------------------------
// Render basics + title
// ---------------------------------------------------------------------------

describe('AccountBalanceStackBand', () => {
  it('renders_chart_and_method_suffixed_heading', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
      />,
    );
    expect(
      screen.getByText('Account balances over time (Historical)'),
    ).toBeTruthy();
    expect(screen.getByTestId('account-balance-stack-chart')).toBeTruthy();
  });

  it('renders_a_bare_heading_when_methodLabel_omitted (accounts surface)', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={[
          bandYear(2030, 'actual', { 'acct-ira': 100_000 }),
          bandYear(2031, 'actual', { 'acct-ira': 110_000 }),
        ]}
        showExcludedToggle={false}
      />,
    );
    expect(screen.getByText('Account balances over time')).toBeTruthy();
  });

  it('group_by_label_shows_Type_when_no_custom_tiers', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
      />,
    );
    const group = screen.getByRole('radiogroup', {
      name: /Group by: Type \| Account/i,
    });
    expect(group).toBeTruthy();
  });

  it('group_by_label_shows_Tier_when_custom_tiers_provided', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
        customTiers={[['acct-ira'], ['acct-roth']]}
        excludedAccountIds={[]}
      />,
    );
    const group = screen.getByRole('radiogroup', {
      name: /Group by: Tier \| Account/i,
    });
    expect(group).toBeTruthy();
  });

  it('show_excluded_toggle_renders_by_default', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
        excludedAccountIds={['acct-roth']}
      />,
    );
    expect(
      screen.getByRole('switch', { name: /Show excluded accounts/i }),
    ).toBeTruthy();
  });

  it('show_excluded_toggle_suppressed_when_showExcludedToggle_false (accounts surface)', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        showExcludedToggle={false}
      />,
    );
    expect(
      screen.queryByRole('switch', { name: /Show excluded accounts/i }),
    ).toBeNull();
  });

  it('switching_to_account_view_renders_account_radio_selected', async () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
      />,
    );
    const accountRadio = screen.getByRole('radio', { name: /Account/i });
    await userEvent.click(accountRadio);
    expect(accountRadio).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// "Type" grouping aggregation — MIXED Roth-designated sub-bucket split
// ---------------------------------------------------------------------------

describe('AccountBalanceStackBand — "Type" grouping sub-bucket split', () => {
  function rowsFor(
    accounts: SimpleMeta[],
    rows: StackBandYear[],
  ): Array<Record<string, number>> {
    chartSpy.rows = null;
    render(
      <AccountBalanceStackBand
        accounts={accounts}
        rows={rows}
        boundaryYear={2030}
        methodLabel="Historical"
      />,
    );
    return chartSpy.rows as Array<Record<string, number>>;
  }

  it('splits a MIXED TSP: preEnd to Pre-tax band, postEnd to Roth band', () => {
    const accounts: SimpleMeta[] = [
      { id: 'acct-tsp', name: 'My TSP', type: 'RETIREMENT_TSP', taxTreatment: 'MIXED' },
    ];
    const rows = [
      bandYearSplit(2030, 'actual', {
        'acct-tsp': { preEnd: 600_000, postEnd: 400_000 },
      }),
    ];
    const out = rowsFor(accounts, rows);
    expect(out[0]['acct_preTax']).toBe(600_000);
    expect(out[0]['acct_roth']).toBe(400_000);
  });

  it('routes a pure POST_TAX TSP (100% Roth) full balance to the Roth band', () => {
    const accounts: SimpleMeta[] = [
      { id: 'acct-tsp', name: 'My Roth TSP', type: 'RETIREMENT_TSP', taxTreatment: 'POST_TAX' },
    ];
    const rows = [bandYear(2030, 'actual', { 'acct-tsp': 500_000 })];
    const out = rowsFor(accounts, rows);
    expect(out[0]['acct_roth']).toBe(500_000);
    expect(out[0]['acct_preTax']).toBe(0);
  });

  it.each([
    ['RETIREMENT_ROTH_401K' as const, 'Roth 401(k)'],
    ['RETIREMENT_ROTH_403B' as const, 'Roth 403(b)'],
    ['RETIREMENT_ROTH_457B' as const, 'Roth 457(b)'],
    ['RETIREMENT_ROTH_TSP' as const, 'Roth TSP'],
  ])(
    'routes dedicated Roth employer-plan type %s full balance to Roth band',
    (type, name) => {
      const accounts: SimpleMeta[] = [
        { id: 'acct-roth-emp', name, type, taxTreatment: 'ROTH' },
      ];
      const rows = [bandYear(2030, 'actual', { 'acct-roth-emp': 750_000 })];
      const out = rowsFor(accounts, rows);
      expect(out[0]['acct_roth']).toBe(750_000);
      expect(out[0]['acct_preTax']).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Boundary marker + zone DOM contract
// ---------------------------------------------------------------------------

describe('AccountBalanceStackBand — boundary + zones', () => {
  it('passes a dashed boundary marker at the last actual year', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={[
          bandYear(2030, 'actual', { 'acct-ira': 100_000 }),
          bandYear(2031, 'projected', { 'acct-ira': 90_000 }),
        ]}
        boundaryYear={2030}
        methodLabel="Planned"
      />,
    );
    expect(chartSpy.boundary).toMatchObject({ year: 2030 });
  });

  it('omits the boundary on the historical-only accounts surface', () => {
    render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={[
          bandYear(2030, 'actual', { 'acct-ira': 100_000 }),
          bandYear(2031, 'actual', { 'acct-ira': 110_000 }),
        ]}
        showExcludedToggle={false}
      />,
    );
    expect(chartSpy.boundary).toBeNull();
  });

  it('marks actual / carried / projected zones on a series', () => {
    render(
      <AccountBalanceStackBand
        accounts={[
          { id: 'acct-ira', name: 'My IRA', type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ]}
        rows={[
          bandYear(2030, 'actual', { 'acct-ira': 100_000 }),
          // carried-forward historical year (held flat from 2030).
          bandYear(2031, 'actual', { 'acct-ira': 100_000 }, new Set(['acct-ira'])),
          bandYear(2032, 'projected', { 'acct-ira': 95_000 }),
        ]}
        boundaryYear={2031}
        methodLabel="Planned"
      />,
    );
    const kinds = zonesFor('Tax-deferred').map((z) => z.kind);
    expect(kinds).toContain('actual');
    expect(kinds).toContain('carried');
    expect(kinds).toContain('projected');
    // The carried zone dashes its top edge; projected is lower opacity.
    const carried = zonesFor('Tax-deferred').find((z) => z.kind === 'carried');
    expect(carried?.strokeDasharray).toBeTruthy();
    const projected = zonesFor('Tax-deferred').find((z) => z.kind === 'projected');
    const actual = zonesFor('Tax-deferred').find((z) => z.kind === 'actual');
    expect((projected?.fillOpacity ?? 1)).toBeLessThan(actual?.fillOpacity ?? 1);
  });

  it('spans continuous rows from the earliest year through the horizon', () => {
    render(
      <AccountBalanceStackBand
        accounts={[
          { id: 'acct-ira', name: 'My IRA', type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ]}
        rows={[
          bandYear(2018, 'actual', { 'acct-ira': 50_000 }),
          bandYear(2030, 'projected', { 'acct-ira': 120_000 }),
          bandYear(2055, 'projected', { 'acct-ira': 200_000 }),
        ]}
        boundaryYear={2018}
        methodLabel="Planned"
      />,
    );
    const rows = chartSpy.rows as Array<{ year: number }>;
    expect(rows[0].year).toBe(2018);
    expect(rows[rows.length - 1].year).toBe(2055);
  });

  it('stale-balance gap: rows connect across the gap and the boundary stays at the last actual year', () => {
    render(
      <AccountBalanceStackBand
        accounts={[
          { id: 'acct-ira', name: 'My IRA', type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
        ]}
        rows={[
          bandYear(2015, 'actual', { 'acct-ira': 40_000 }),
          // firstProjectionYear (2030) is many years past lastActualYear (2015).
          bandYear(2030, 'projected', { 'acct-ira': 120_000 }),
        ]}
        boundaryYear={2015}
        methodLabel="Planned"
      />,
    );
    const rows = chartSpy.rows as Array<{ year: number; [k: string]: number }>;
    // Single connected area: every x is finite, no NaN injected for the gap.
    expect(rows.every((r) => Number.isFinite(r.year))).toBe(true);
    expect(chartSpy.boundary).toMatchObject({ year: 2015 });
  });
});

// ---------------------------------------------------------------------------
// A11y smoke
// ---------------------------------------------------------------------------

describe('AccountBalanceStackBand — a11y smoke', () => {
  it('passes expectNoA11yViolations (Projections surface)', async () => {
    const { container } = render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={BASE_ROWS}
        boundaryYear={2030}
        methodLabel="Historical"
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('passes expectNoA11yViolations (accounts surface, no method/toggle)', async () => {
    const { container } = render(
      <AccountBalanceStackBand
        accounts={BASE_ACCOUNTS}
        rows={[
          bandYear(2030, 'actual', { 'acct-ira': 100_000 }),
          bandYear(2031, 'actual', { 'acct-ira': 110_000 }),
        ]}
        showExcludedToggle={false}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
