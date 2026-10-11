/** PDF account-table contracts: ordering, history metrics, tax buckets, and totals. */
import { describe, expect, it } from 'vitest';
import type { ReportAccount } from '../report-data';
import {
  buildAccountBreakdownTableSpec,
  buildReportAccountsTableSpec,
  formatDollars,
} from './pdf-tables';

function account(overrides: Partial<ReportAccount> = {}): ReportAccount {
  return {
    id: 'acct-default',
    name: 'Default account',
    ownerDisplayName: 'Alex',
    type: 'RETIREMENT_401K',
    taxTreatment: 'PRE_TAX',
    assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
    currentBalance: 100,
    currentBalancePreTax: 100,
    currentBalancePostTax: null,
    currentBalanceTaxFree: null,
    totalContributions: 30,
    totalGains: 10,
    historicalReturnPct: 5.5,
    plannedContributionPreTax: 12,
    plannedContributionPostTax: 8,
    configuredReturnPct: 6.5,
    balanceAsOfYear: 2025,
    balanceAsOfDate: '2025-12-31',
    ...overrides,
  };
}

describe('PDF account inventory', () => {
  it('sorts case-insensitively by account name, owner, then account id without mutation', () => {
    const input = [
      account({ id: 'id-z', name: 'beta', ownerDisplayName: 'Amy' }),
      account({ id: 'id-c', name: 'alpha', ownerDisplayName: 'Zed' }),
      account({ id: 'id-b', name: 'Alpha', ownerDisplayName: 'amy' }),
      account({ id: 'id-a', name: 'ALPHA', ownerDisplayName: 'Amy' }),
    ];
    const before = structuredClone(input);

    const inventory = buildReportAccountsTableSpec(input);
    const breakdown = buildAccountBreakdownTableSpec(input);

    expect(inventory.body.map((row) => row[0])).toEqual([
      'ALPHA',
      'Alpha',
      'alpha',
      'beta',
    ]);
    expect(breakdown.body.map((row) => row[0])).toEqual([
      'ALPHA',
      'Alpha',
      'alpha',
      'beta',
    ]);
    expect(input).toEqual(before);
  });

  it('shows historical return directly beside planned return', () => {
    const spec = buildReportAccountsTableSpec([
      account({ name: 'Has history' }),
      account({ id: 'none', name: 'No history', historicalReturnPct: null }),
    ]);

    expect(spec.head[0]).toEqual([
      'Account',
      'Type',
      'Tax',
      'Balance',
      'Planned Return',
      'Historical Return',
      'Annual contributions',
    ]);
    expect(spec.body[0].slice(4, 7)).toEqual(['6.5%', '5.5%', '$20']);
    expect(spec.body[1][5]).toBe('—');
  });

  it('handles empty input', () => {
    expect(buildReportAccountsTableSpec([]).body).toEqual([]);
  });
});

describe('PDF per-account breakdown', () => {
  it('emits the exact history, balance-bucket, and totals columns', () => {
    const spec = buildAccountBreakdownTableSpec([
      account({
        id: 'pre',
        name: 'Pre-tax',
        currentBalance: 100,
        currentBalancePreTax: 100,
        totalContributions: 30,
        totalGains: -10,
      }),
      account({
        id: 'split',
        name: 'Split',
        taxTreatment: 'MIXED',
        type: 'OTHER',
        currentBalance: 200,
        currentBalancePreTax: null,
        currentBalancePostTax: 50,
        currentBalanceTaxFree: 150,
        totalContributions: 20,
        totalGains: 40,
      }),
    ]);

    expect(spec.head[0]).toEqual([
      'Account',
      'As of',
      'Total contributions',
      'Total gains',
      'Total balance',
      'Pre-tax',
      'Post-tax',
      'Tax-free',
    ]);
    expect(spec.body[0][1]).toBe('2025-12-31');
    expect(spec.foot).toEqual([
      [
        'Total',
        '—',
        '$50',
        '$30',
        '$300',
        '$100',
        '$50',
        '$150',
      ],
    ]);
  });

  it('renders no-history values safely and falls back from date to year', () => {
    const spec = buildAccountBreakdownTableSpec([
      account({
        name: 'No history',
        historicalReturnPct: null,
        balanceAsOfDate: null,
        balanceAsOfYear: null,
        currentBalance: 0,
        currentBalancePreTax: 0,
        totalContributions: 0,
        totalGains: 0,
      }),
      account({ id: 'year', name: 'Year only', balanceAsOfDate: null }),
    ]);

    expect(spec.body[0]).toEqual([
      'No history',
      '—',
      '$0',
      '$0',
      '$0',
      '$0',
      '—',
      '—',
    ]);
    expect(spec.body[1][1]).toBe('2025');
  });

  it('renders each supported tax classification in the correct bucket columns', () => {
    const taxFreeTypes: ReportAccount['type'][] = [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ];
    const rows = [
      account({ id: 'pre', name: 'Pre', currentBalancePreTax: 100 }),
      account({
        id: 'post',
        name: 'Post',
        type: 'BROKERAGE',
        taxTreatment: 'POST_TAX',
        currentBalancePreTax: null,
        currentBalancePostTax: 100,
      }),
      account({
        id: 'tsp',
        name: 'Roth TSP',
        type: 'RETIREMENT_TSP',
        taxTreatment: 'POST_TAX',
        currentBalancePreTax: null,
        currentBalanceTaxFree: 100,
      }),
      account({
        id: 'hsa',
        name: 'HSA',
        type: 'HSA',
        taxTreatment: 'HSA',
        currentBalancePreTax: null,
        currentBalanceTaxFree: 100,
      }),
      account({
        id: 'roth-ira',
        name: 'Roth IRA',
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'ROTH',
        currentBalancePreTax: null,
        currentBalanceTaxFree: 100,
      }),
      ...taxFreeTypes.map((type) =>
        account({
          id: type,
          name: type,
          type,
          taxTreatment: 'ROTH',
          currentBalancePreTax: null,
          currentBalanceTaxFree: 100,
        }),
      ),
      account({
        id: 'mixed-roth',
        name: 'Mixed Roth',
        taxTreatment: 'MIXED',
        currentBalancePreTax: 60,
        currentBalanceTaxFree: 40,
      }),
      account({
        id: 'mixed-other',
        name: 'Mixed other',
        type: 'OTHER',
        taxTreatment: 'MIXED',
        currentBalancePreTax: 60,
        currentBalancePostTax: 40,
      }),
    ];

    const byName = new Map(
      buildAccountBreakdownTableSpec(rows).body.map((row) => [row[0], row]),
    );
    expect(byName.get('Pre')?.slice(5)).toEqual(['$100', '—', '—']);
    expect(byName.get('Post')?.slice(5)).toEqual(['—', '$100', '—']);
    expect(byName.get('Mixed Roth')?.slice(5)).toEqual(['$60', '—', '$40']);
    expect(byName.get('Mixed other')?.slice(5)).toEqual(['$60', '$40', '—']);
    for (const name of ['Roth TSP', 'HSA', 'Roth IRA', ...taxFreeTypes]) {
      expect(byName.get(name)?.slice(5)).toEqual(['—', '—', '$100']);
    }
  });

  it('returns a zero totals footer for empty input', () => {
    expect(buildAccountBreakdownTableSpec([]).foot).toEqual([
      ['Total', '—', ...Array.from({ length: 6 }, () => formatDollars(0))],
    ]);
  });
});
