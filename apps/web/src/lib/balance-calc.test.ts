/**
 * Tests for the Modified-Dietz + portfolio-summary helpers. Mirrors the
 * scenarios covered by the legacy server-side
 * `apps/api/src/account-balances/portfolio-stats.spec.ts`.
 */
import {
  accountReturns,
  computePortfolioSummary,
  deriveAll,
  deriveTaxTreatmentAllocation,
  gainLoss,
  isPureRothEmployerType,
  isReturnBearingRow,
  returnPct,
  totalContributions,
} from '../lib/balance-calc';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

function payload(overrides: Partial<AccountBalancePayload> = {}): AccountBalancePayload {
  return {
    accountId: 'acc-1',
    year: 2024,
    lastUpdated: '2024-12-31T23:59:59Z',
    startingBalance: 0,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance: 0,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    comment: null,
    ...overrides,
  };
}

function aggregate<T extends Record<string, unknown>>(
  type: 'account' | 'accountBalance',
  id: string,
  body: T,
): Aggregate<T> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2024-12-31T23:59:59Z',
    deviceId: 'dev-1',
    payload: body,
  };
}

function accountAgg(overrides: Partial<AccountPayload> = {}): Aggregate<AccountPayload> {
  return aggregate('account', overrides.name ?? 'acc-1', {
    name: 'Acct',
    type: 'BROKERAGE',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'POST_TAX',
    ownerId: 'hm-1',
    institution: 'Bank',
    notes: '',
    planningReturnPct: 6,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    ...overrides,
  });
}

describe('balance-calc per-row math', () => {
  it('gainLoss = endingBalance − startingBalance − totalContributions − rollover + distributions', () => {
    const p = payload({
      startingBalance: 100_000,
      totalContributions: 10_000,
      rollover: 1_000,
      distributions: 500,
      endingBalance: 115_000,
    });
    expect(gainLoss(p)).toBe(115_000 - 100_000 - 10_000 - 1_000 + 500);
  });

  it('returnPct uses half-weight contributions on existing accounts', () => {
    const p = payload({
      startingBalance: 100_000,
      totalContributions: 10_000,
      endingBalance: 115_000,
    });
    // gainLoss = 5000, avgCapital = 100000 + 0.5*10000 = 105000, return = 4.76%
    expect(returnPct(p)).toBeCloseTo(4.76, 1);
  });

  it('returnPct uses full-weight contributions on new accounts (startingBalance = 0)', () => {
    const p = payload({
      startingBalance: 0,
      totalContributions: 10_000,
      endingBalance: 11_000,
    });
    // gainLoss = 1000, avgCapital = 0 + 1.0*10000 = 10000, return = 10%
    expect(returnPct(p)).toBe(10);
  });

  it('returnPct half-weights distributions in the denominator', () => {
    const p = payload({
      startingBalance: 10_000,
      totalContributions: 0,
      distributions: 600,
      endingBalance: 10_500,
    });
    // gainLoss = 10500 - 10000 - 0 - 0 + 600 = 1100
    // avgCapital = 10000 - 0.5*600 = 9700
    expect(returnPct(p)).toBeCloseTo(11.34, 1);
  });

  it('totalContributions for MIXED sums all four split components', () => {
    const p = payload({
      contributionsPreTax: 1000,
      contributionsPostTax: 2000,
      companyContributionsPreTax: 500,
      companyContributionsPostTax: 0,
    });
    expect(totalContributions(p)).toBe(3500);
  });

  it('deriveAll bundles the three derived fields', () => {
    const p = payload({
      startingBalance: 100_000,
      totalContributions: 10_000,
      endingBalance: 115_000,
    });
    const d = deriveAll(p);
    expect(d.totalContributions).toBe(10_000);
    expect(d.gainLoss).toBe(5_000);
    expect(d.returnPct).toBeCloseTo(4.76, 1);
  });
});

describe('computePortfolioSummary', () => {
  it('returns zeros / nulls for an empty workspace', () => {
    const r = computePortfolioSummary([], []);
    expect(r.accounts).toEqual([]);
    expect(r.summary.totalCurrentBalance).toBe(0);
    expect(r.summary.twr).toBeNull();
    expect(r.summary.yearsCovered).toBe(0);
  });

  it('latest year drives currentBalance per account', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: acc.id, year: 2023, endingBalance: 50_000, lastUpdated: '2023-12-31T23:59:59Z' })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, endingBalance: 60_000, lastUpdated: '2024-11-15T10:00:00Z' })),
    ];
    const r = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0].currentBalance).toBe(60_000);
    expect(r.accounts[0].currentBalanceYear).toBe(2024);
    // "As of" tracks the latest-year entry's lastUpdated, not the prior year's.
    expect(r.accounts[0].currentBalanceAsOf).toBe('2024-11-15T10:00:00Z');
    expect(r.summary.totalCurrentBalance).toBe(60_000);
  });

  it('totalGainLoss sums per-account first/last endpoints minus contributions', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: acc.id, year: 2023, startingBalance: 100_000, endingBalance: 110_000, totalContributions: 5_000 })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, startingBalance: 110_000, endingBalance: 130_000, totalContributions: 5_000 })),
    ];
    const r = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    // last 130k - first 100k - sumContrib 10k - rollover 0 + distrib 0 = 20k
    expect(r.summary.totalGainLoss).toBe(20_000);
  });

  it('TWR computes over yearly portfolio returns', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: acc.id, year: 2023, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, startingBalance: 115_000, totalContributions: 10_000, endingBalance: 130_000 })),
    ];
    const r = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(r.summary.twr).not.toBeNull();
    expect(r.summary.yearsCovered).toBe(2);
  });

  it('per-account twr is populated for multi-year accounts and null when no rows', () => {
    const withRows = accountAgg({ name: 'A' });
    const noRows = accountAgg({ name: 'B' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: withRows.id, year: 2023, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: withRows.id, year: 2024, startingBalance: 115_000, totalContributions: 10_000, endingBalance: 130_000 })),
    ];
    const r = computePortfolioSummary(
      [
        { account: withRows, ownerDisplayName: 'X' },
        { account: noRows, ownerDisplayName: 'Y' },
      ],
      balances,
    );
    const a = r.accounts.find((x) => x.name === 'A')!;
    const b = r.accounts.find((x) => x.name === 'B')!;
    expect(a.twr).not.toBeNull();
    expect(b.twr).toBeNull();
  });

  it('buckets a POST_TAX account entirely into the post-tax totals', () => {
    const acc = accountAgg({ name: 'A', taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2025', payload({ accountId: acc.id, year: 2025, startingBalance: 0, totalContributions: 12_000, endingBalance: 50_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalPostTaxBalance).toBe(50_000);
    expect(summary.totalPreTaxBalance).toBe(0);
    expect(summary.postTaxPct).toBe(100);
    expect(summary.preTaxPct).toBe(0);
    expect(summary.totalPostTaxContributions).toBe(12_000);
    expect(summary.totalPreTaxContributions).toBe(0);
  });

  it('buckets a PRE_TAX account entirely into the pre-tax totals', () => {
    const acc = accountAgg({ name: 'A', taxTreatment: 'PRE_TAX' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2025', payload({ accountId: acc.id, year: 2025, startingBalance: 0, totalContributions: 8_000, endingBalance: 40_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalPreTaxBalance).toBe(40_000);
    expect(summary.totalPostTaxBalance).toBe(0);
    expect(summary.preTaxPct).toBe(100);
    expect(summary.totalPreTaxContributions).toBe(8_000);
  });

  it('splits a MIXED account using its stored pre/post fields', () => {
    const acc = accountAgg({ name: 'A', taxTreatment: 'MIXED' });
    const balances = [
      aggregate(
        'accountBalance',
        'bal-A-2025',
        payload({
          accountId: acc.id,
          year: 2025,
          startingBalance: 0,
          endingBalance: 30_000,
          endingBalancePreTax: 20_000,
          endingBalancePostTax: 10_000,
          contributionsPreTax: 6_000,
          contributionsPostTax: 3_000,
          companyContributionsPreTax: 1_000,
          companyContributionsPostTax: 0,
        }),
      ),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalPreTaxBalance).toBe(20_000);
    expect(summary.totalPostTaxBalance).toBe(10_000);
    expect(summary.preTaxPct).toBeCloseTo((20_000 / 30_000) * 100, 5);
    expect(summary.postTaxPct).toBeCloseTo((10_000 / 30_000) * 100, 5);
    expect(summary.totalPreTaxContributions).toBe(7_000);
    expect(summary.totalPostTaxContributions).toBe(3_000);
  });

  it('pre/post-tax buckets are 0 (not NaN) for an empty workspace', () => {
    const { summary } = computePortfolioSummary([], []);
    expect(summary.totalPreTaxBalance).toBe(0);
    expect(summary.totalPostTaxBalance).toBe(0);
    expect(summary.preTaxPct).toBe(0);
    expect(summary.postTaxPct).toBe(0);
    expect(summary.totalPreTaxContributions).toBe(0);
    expect(summary.totalPostTaxContributions).toBe(0);
  });

  it('a legacy PRE_TAX-stored HSA is classified by treatment, not type', () => {
    // The tax-free accumulator is treatment-based
    // (`taxTreatment === 'ROTH' || 'HSA'`). A pre-migration HSA still stored as
    // PRE_TAX therefore lands in the pre-tax bucket by its treatment, not in
    // tax-free. The v1→v2 migration carries real HSAs to the 'HSA' treatment.
    const acc = accountAgg({ name: 'H', type: 'HSA', taxTreatment: 'PRE_TAX' });
    const balances = [
      aggregate('accountBalance', 'bal-H-2025', payload({ accountId: acc.id, year: 2025, endingBalance: 30_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalTaxFreeBalance).toBe(0);
    expect(summary.totalPreTaxBalance).toBe(30_000);
  });

  it('a legacy POST_TAX-stored HSA is classified by treatment, not type', () => {
    // The tax-free accumulator is treatment-based
    // (`taxTreatment === 'ROTH' || 'HSA'`), not type-based. A pre-migration
    // HSA still stored as POST_TAX therefore lands in the post-tax bucket by
    // its treatment — the v1→v2 migration is what carries real HSAs to the
    // 'HSA' treatment (covered by the next test).
    const acc = accountAgg({ name: 'H', type: 'HSA', taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('accountBalance', 'bal-H-2025', payload({ accountId: acc.id, year: 2025, endingBalance: 20_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalTaxFreeBalance).toBe(0);
    expect(summary.totalPostTaxBalance).toBe(20_000);
  });

  it('an HSA-treatment account lands in tax-free ONLY, not pre/post balance', () => {
    const acc = accountAgg({ name: 'H', type: 'HSA', taxTreatment: 'HSA' });
    const balances = [
      aggregate('accountBalance', 'bal-H-2025', payload({ accountId: acc.id, year: 2025, startingBalance: 0, totalContributions: 4_150, endingBalance: 29_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalTaxFreeBalance).toBe(29_000);
    expect(summary.taxFreePct).toBe(100);
    // The 'HSA' treatment balance arm is a no-op — HSA must NOT double-count
    // into pre-tax or post-tax (so pre + post + tax-free reconstitutes total).
    expect(summary.totalPreTaxBalance).toBe(0);
    expect(summary.totalPostTaxBalance).toBe(0);
  });

  it('routes HSA-treatment contributions into totalPreTaxContributions', () => {
    const acc = accountAgg({ name: 'H', type: 'HSA', taxTreatment: 'HSA' });
    const balances = [
      aggregate('accountBalance', 'bal-H-2025', payload({ accountId: acc.id, year: 2025, startingBalance: 0, totalContributions: 4_150, endingBalance: 29_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    // HSA contributions are pre-tax deductible; PortfolioSummary has no
    // tax-free contributions bucket, so they route to pre-tax contributions.
    expect(summary.totalPreTaxContributions).toBe(4_150);
    expect(summary.totalPostTaxContributions).toBe(0);
  });

  it('counts a Roth account into totalTaxFreeBalance', () => {
    const acc = accountAgg({ name: 'R', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    const balances = [
      aggregate('accountBalance', 'bal-R-2025', payload({ accountId: acc.id, year: 2025, endingBalance: 50_000 })),
    ];
    const { summary } = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    expect(summary.totalTaxFreeBalance).toBe(50_000);
  });

  it('totalTaxFreeBalance is 0 (not NaN) for an empty workspace', () => {
    const { summary } = computePortfolioSummary([], []);
    expect(summary.totalTaxFreeBalance).toBe(0);
    expect(summary.taxFreePct).toBe(0);
  });

  it('a MIXED Roth-designated 401(k) keeps the three percentages summing to 100', () => {
    // Regression for the Roth-designated double-count: the Roth sub-bucket of a
    // MIXED 401(k) used to land in BOTH totalPostTaxBalance and
    // totalTaxFreeBalance, pushing preTaxPct + postTaxPct + taxFreePct past 100.
    // A PRE_TAX 401(k) is included so the pre-tax bucket is non-trivial.
    const mixed = accountAgg({ name: 'M', type: 'RETIREMENT_401K', taxTreatment: 'MIXED' });
    const pre = accountAgg({ name: 'K', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' });
    const balances = [
      aggregate('accountBalance', 'bal-M-2025', payload({
        accountId: mixed.id,
        year: 2025,
        endingBalance: 100_000,
        endingBalancePreTax: 75_000,
        endingBalancePostTax: 25_000,
      })),
      aggregate('accountBalance', 'bal-K-2025', payload({
        accountId: pre.id,
        year: 2025,
        endingBalance: 50_000,
      })),
    ];
    const { summary } = computePortfolioSummary(
      [
        { account: mixed, ownerDisplayName: 'X' },
        { account: pre, ownerDisplayName: 'X' },
      ],
      balances,
    );
    // The Roth-designated post-tax sub-bucket is tax-free ONLY.
    expect(summary.totalPreTaxBalance).toBe(125_000);
    expect(summary.totalPostTaxBalance).toBe(0);
    expect(summary.totalTaxFreeBalance).toBe(25_000);
    // Balances reconstitute the current balance.
    expect(
      summary.totalPreTaxBalance +
        summary.totalPostTaxBalance +
        summary.totalTaxFreeBalance,
    ).toBe(summary.totalCurrentBalance);
    // Percentages sum to 100 (within rounding) — the bug pushed this past 100.
    expect(summary.preTaxPct + summary.postTaxPct + summary.taxFreePct).toBeCloseTo(100, 5);
  });

  it('a MIXED OTHER post-tax sub-bucket lands in Taxable, not Tax-Free', () => {
    // Guard against over-correction: only Roth-designated retirement types
    // (401k/403b/457b/TSP) route their post-tax sub-bucket to tax-free. A MIXED
    // OTHER account's post-tax sub-bucket is plain taxable money.
    const other = accountAgg({ name: 'O', type: 'OTHER', taxTreatment: 'MIXED' });
    const balances = [
      aggregate('accountBalance', 'bal-O-2025', payload({
        accountId: other.id,
        year: 2025,
        endingBalance: 40_000,
        endingBalancePreTax: 30_000,
        endingBalancePostTax: 10_000,
      })),
    ];
    const { summary } = computePortfolioSummary([{ account: other, ownerDisplayName: 'X' }], balances);
    expect(summary.totalPreTaxBalance).toBe(30_000);
    expect(summary.totalPostTaxBalance).toBe(10_000);
    expect(summary.totalTaxFreeBalance).toBe(0);
    expect(summary.preTaxPct + summary.postTaxPct + summary.taxFreePct).toBeCloseTo(100, 5);
  });
});

describe('deriveTaxTreatmentAllocation', () => {
  /** Build the summary + flat account rows the helper consumes. */
  function build(
    specs: ReadonlyArray<{
      name: string;
      type: AccountPayload['type'];
      taxTreatment: AccountPayload['taxTreatment'];
      ending: number;
      preTax?: number;
      postTax?: number;
    }>,
  ) {
    const accounts = specs.map((s) => accountAgg({ name: s.name, type: s.type, taxTreatment: s.taxTreatment }));
    const balances = specs.map((s, i) =>
      aggregate('accountBalance', `bal-${s.name}-2025`, payload({
        accountId: accounts[i].id,
        year: 2025,
        endingBalance: s.ending,
        endingBalancePreTax: s.preTax ?? null,
        endingBalancePostTax: s.postTax ?? null,
      })),
    );
    const result = computePortfolioSummary(
      accounts.map((account) => ({ account, ownerDisplayName: 'X' })),
      balances,
    );
    return deriveTaxTreatmentAllocation(result.summary, result.accounts);
  }

  it('returns all-zero when total balance is 0', () => {
    const split = deriveTaxTreatmentAllocation(
      computePortfolioSummary([], []).summary,
      [],
    );
    expect(split).toEqual({
      pretaxBalance: 0,
      taxableBalance: 0,
      taxFreeBalance: 0,
      taxFreeRoth: 0,
      taxFreeHsa: 0,
      pretaxPct: 0,
      taxablePct: 0,
      taxFreePct: 0,
    });
  });

  it('places an HSA-treatment account in tax-free and does NOT inflate pre-tax (no double-count)', () => {
    // PRE_TAX 401(k) 100k + HSA 20k ('HSA' treatment, the post-migration value).
    // Tax-free is treatment-based, so the HSA is identified by its 'HSA'
    // treatment and the HSA balance arm is a no-op in the pre/post split.
    const split = build([
      { name: 'K', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ending: 100_000 },
      { name: 'H', type: 'HSA', taxTreatment: 'HSA', ending: 20_000 },
    ]);
    expect(split.taxFreeBalance).toBe(20_000);
    // Tax-free splits Roth vs HSA: this is all HSA, no Roth.
    expect(split.taxFreeHsa).toBe(20_000);
    expect(split.taxFreeRoth).toBe(0);
    expect(split.taxFreeRoth + split.taxFreeHsa).toBe(split.taxFreeBalance);
    // Pre-tax is the 401(k) only — the HSA is NOT double-counted.
    expect(split.pretaxBalance).toBe(100_000);
    expect(split.taxableBalance).toBe(0);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(120_000);
  });

  it('places an HSA-treatment account in tax-free, not taxable', () => {
    // Brokerage 60k (POST_TAX) + HSA 20k ('HSA' treatment). Tax-free is
    // treatment-based, so the HSA is identified by its 'HSA' treatment (the
    // value real HSAs carry post-migration), not by account type.
    const split = build([
      { name: 'B', type: 'BROKERAGE', taxTreatment: 'POST_TAX', ending: 60_000 },
      { name: 'H', type: 'HSA', taxTreatment: 'HSA', ending: 20_000 },
    ]);
    expect(split.taxFreeBalance).toBe(20_000);
    // Tax-free is all HSA here.
    expect(split.taxFreeHsa).toBe(20_000);
    expect(split.taxFreeRoth).toBe(0);
    // Taxable excludes the HSA — it belongs to tax-free.
    expect(split.taxableBalance).toBe(60_000);
    expect(split.pretaxBalance).toBe(0);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(80_000);
  });

  it('places a Roth in tax-free, not taxable', () => {
    const split = build([
      { name: 'B', type: 'BROKERAGE', taxTreatment: 'POST_TAX', ending: 40_000 },
      { name: 'R', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ending: 10_000 },
    ]);
    expect(split.taxFreeBalance).toBe(10_000);
    // Tax-free is all Roth here, no HSA.
    expect(split.taxFreeRoth).toBe(10_000);
    expect(split.taxFreeHsa).toBe(0);
    expect(split.taxableBalance).toBe(40_000);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(50_000);
  });

  it('splits a mixed portfolio of Roth + HSA into separate tax-free slices', () => {
    // Roth IRA 30k + HSA 20k → tax-free total 50k, split 30k Roth / 20k HSA.
    const split = build([
      { name: 'R', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ending: 30_000 },
      { name: 'H', type: 'HSA', taxTreatment: 'HSA', ending: 20_000 },
    ]);
    expect(split.taxFreeBalance).toBe(50_000);
    expect(split.taxFreeRoth).toBe(30_000);
    expect(split.taxFreeHsa).toBe(20_000);
    expect(split.taxFreeRoth + split.taxFreeHsa).toBe(split.taxFreeBalance);
  });

  it('splits a MIXED 401(k): pre-tax slice → pretax, Roth-designated slice → tax-free', () => {
    // $100k total, 75% pre-tax → $75k pre-tax, $25k Roth-designated.
    const split = build([
      {
        name: 'M',
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
        ending: 100_000,
        preTax: 75_000,
        postTax: 25_000,
      },
    ]);
    expect(split.pretaxBalance).toBe(75_000);
    // No POST_TAX brokerage → nothing taxable.
    expect(split.taxableBalance).toBe(0);
    // The Roth-designated sub-bucket is tax-free, and it lands in the Roth
    // slice (there is no HSA here).
    expect(split.taxFreeBalance).toBe(25_000);
    expect(split.taxFreeRoth).toBe(25_000);
    expect(split.taxFreeHsa).toBe(0);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(100_000);
  });

  it('keeps a MIXED OTHER account post-tax sub-bucket in taxable, NOT tax-free', () => {
    // OTHER is MIXED-capable per TAX_TREATMENT_RULES, but its post-tax
    // sub-bucket is plain taxable money — NOT Roth-designated — so it must
    // not be reclassified as tax-free. $30k pre-tax + $10k post-tax.
    const split = build([
      {
        name: 'O',
        type: 'OTHER',
        taxTreatment: 'MIXED',
        ending: 40_000,
        preTax: 30_000,
        postTax: 10_000,
      },
    ]);
    // Pre-tax slice → pretax.
    expect(split.pretaxBalance).toBe(30_000);
    // Post-tax sub-bucket stays taxable, not zeroed into tax-free.
    expect(split.taxableBalance).toBe(10_000);
    expect(split.taxFreeBalance).toBe(0);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(40_000);
  });

  it('does NOT increment totalTaxFreeBalance for a MIXED OTHER account', () => {
    const acc = accountAgg({ name: 'O', type: 'OTHER', taxTreatment: 'MIXED' });
    const balances = [
      aggregate('accountBalance', 'bal-O-2025', payload({
        accountId: acc.id,
        year: 2025,
        endingBalance: 40_000,
        endingBalancePreTax: 30_000,
        endingBalancePostTax: 10_000,
      })),
    ];
    const result = computePortfolioSummary(
      [{ account: acc, ownerDisplayName: 'X' }],
      balances,
    );
    // The post-tax sub-bucket of a MIXED OTHER account is NOT tax-free.
    expect(result.summary.totalTaxFreeBalance).toBe(0);
    // By taxTreatment the splits are unchanged.
    expect(result.summary.totalPreTaxBalance).toBe(30_000);
    expect(result.summary.totalPostTaxBalance).toBe(10_000);
  });

  it('populates currentBalancePostTax + totalTaxFreeBalance for a MIXED 401(k)', () => {
    const acc = accountAgg({ name: 'M', type: 'RETIREMENT_401K', taxTreatment: 'MIXED' });
    const balances = [
      aggregate('accountBalance', 'bal-M-2025', payload({
        accountId: acc.id,
        year: 2025,
        endingBalance: 100_000,
        endingBalancePreTax: 75_000,
        endingBalancePostTax: 25_000,
      })),
    ];
    const result = computePortfolioSummary(
      [{ account: acc, ownerDisplayName: 'X' }],
      balances,
    );
    expect(result.accounts[0].currentBalancePostTax).toBe(25_000);
    // The Roth-designated portion folds into the tax-free total.
    expect(result.summary.totalTaxFreeBalance).toBe(25_000);
    // The pre-tax sub-bucket goes to pre-tax; the Roth-designated post-tax
    // sub-bucket is tax-free ONLY, so it must NOT land in totalPostTaxBalance
    // (counting it in both buckets would double-count it).
    expect(result.summary.totalPreTaxBalance).toBe(75_000);
    expect(result.summary.totalPostTaxBalance).toBe(0);
    // Invariant: the three balance buckets reconstitute the current balance,
    // and the three percentages sum to 100 (within rounding).
    expect(
      result.summary.totalPreTaxBalance +
        result.summary.totalPostTaxBalance +
        result.summary.totalTaxFreeBalance,
    ).toBe(result.summary.totalCurrentBalance);
    expect(
      result.summary.preTaxPct +
        result.summary.postTaxPct +
        result.summary.taxFreePct,
    ).toBeCloseTo(100, 5);
  });

  it('classifies a MIXED 401(k) + Roth IRA + brokerage into all three slices', () => {
    // MIXED 401(k) $100k (70% pre-tax → $70k pre, $30k Roth-designated),
    // Roth IRA $40k, brokerage $60k (POST_TAX).
    const split = build([
      {
        name: 'M',
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
        ending: 100_000,
        preTax: 70_000,
        postTax: 30_000,
      },
      { name: 'R', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ending: 40_000 },
      { name: 'B', type: 'BROKERAGE', taxTreatment: 'POST_TAX', ending: 60_000 },
    ]);
    const total = 200_000;
    // pretax = MIXED pre-tax slice only.
    expect(split.pretaxBalance).toBe(70_000);
    // taxable = brokerage only (Roth + MIXED Roth-designated removed).
    expect(split.taxableBalance).toBe(60_000);
    // tax-free = Roth IRA $40k + MIXED Roth-designated $30k.
    expect(split.taxFreeBalance).toBe(70_000);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(total);
    expect(split.pretaxPct).toBeCloseTo((70_000 / total) * 100, 5);
    expect(split.taxablePct).toBeCloseTo((60_000 / total) * 100, 5);
    expect(split.taxFreePct).toBeCloseTo((70_000 / total) * 100, 5);
    expect(split.pretaxPct + split.taxablePct + split.taxFreePct).toBeCloseTo(100, 5);
  });

  it('computes all four slices for a MIXED 401(k) + brokerage + Roth + HSA mix after workaround removal', () => {
    // MIXED 401(k) $100k (70% pre → $70k pre, $30k Roth-designated),
    // brokerage $60k (POST_TAX → taxable), Roth IRA $40k (tax-free Roth),
    // HSA $20k (tax-free HSA). Total $220k. With the taxFreePostTax workaround
    // removed, taxableBalance is just summary.totalPostTaxBalance.
    const split = build([
      {
        name: 'M',
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
        ending: 100_000,
        preTax: 70_000,
        postTax: 30_000,
      },
      { name: 'B', type: 'BROKERAGE', taxTreatment: 'POST_TAX', ending: 60_000 },
      { name: 'R', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ending: 40_000 },
      { name: 'H', type: 'HSA', taxTreatment: 'HSA', ending: 20_000 },
    ]);
    const total = 220_000;
    // pretax = MIXED pre-tax slice only.
    expect(split.pretaxBalance).toBe(70_000);
    // taxable = brokerage only (MIXED Roth-designated stays tax-free; the
    // workaround that used to subtract it is gone, and the summary no longer
    // counts it as post-tax, so the slice is correct without subtraction).
    expect(split.taxableBalance).toBe(60_000);
    // tax-free total = Roth IRA $40k + MIXED Roth-designated $30k + HSA $20k.
    expect(split.taxFreeBalance).toBe(90_000);
    // tax-free-roth = Roth IRA $40k + MIXED Roth-designated $30k.
    expect(split.taxFreeRoth).toBe(70_000);
    // tax-free-hsa = HSA $20k.
    expect(split.taxFreeHsa).toBe(20_000);
    expect(split.taxFreeRoth + split.taxFreeHsa).toBe(split.taxFreeBalance);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(total);
    expect(split.pretaxPct + split.taxablePct + split.taxFreePct).toBeCloseTo(100, 5);
  });

  it('holds the invariant pretax + taxable + taxFree === totalCurrentBalance on a mixed portfolio', () => {
    const specs = [
      { name: 'K', type: 'RETIREMENT_401K' as const, taxTreatment: 'PRE_TAX' as const, ending: 100_000 },
      { name: 'B', type: 'BROKERAGE' as const, taxTreatment: 'POST_TAX' as const, ending: 60_000 },
      { name: 'R', type: 'RETIREMENT_ROTH_IRA' as const, taxTreatment: 'ROTH' as const, ending: 40_000 },
      { name: 'H', type: 'HSA' as const, taxTreatment: 'HSA' as const, ending: 20_000 },
      { name: 'M', type: 'RETIREMENT_401K' as const, taxTreatment: 'MIXED' as const, ending: 30_000, preTax: 18_000, postTax: 12_000 },
    ];
    const split = build(specs);
    const total = specs.reduce((s, x) => s + x.ending, 0);
    expect(split.pretaxBalance + split.taxableBalance + split.taxFreeBalance).toBe(total);
    expect(split.pretaxPct + split.taxablePct + split.taxFreePct).toBeCloseTo(100, 5);
  });
});

describe('accountReturns', () => {
  it('should_return_null_account_returns_when_under_two_years for empty input', () => {
    expect(accountReturns([])).toEqual({ twr: null });
  });

  it('should_return_null_account_returns_when_under_two_years for single row', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 })),
    ];
    expect(accountReturns(balances)).toEqual({ twr: null });
  });

  it('should_compute_per_account_twr_when_two_or_more_years_present', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: acc.id, year: 2023, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, startingBalance: 115_000, totalContributions: 10_000, endingBalance: 130_000 })),
    ];
    const r = accountReturns(balances);
    // 2023 returnPct: gainLoss=5000, avgCapital=105000 -> 4.76 (rounded by returnPct to 2dp)
    // 2024 returnPct: gainLoss=5000, avgCapital=120000 -> 4.17
    // Match the same rounding the per-row helper applies.
    expect(r.twr).toBeCloseTo((Math.sqrt((1 + 4.76 / 100) * (1 + 4.17 / 100)) - 1) * 100, 1);
  });

  it('should_match_portfolio_algorithm_when_only_one_account_exists', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate('accountBalance', 'bal-A-2023', payload({ accountId: acc.id, year: 2023, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 })),
      aggregate('accountBalance', 'bal-A-2024', payload({ accountId: acc.id, year: 2024, startingBalance: 115_000, totalContributions: 10_000, endingBalance: 132_000 })),
      aggregate('accountBalance', 'bal-A-2025', payload({ accountId: acc.id, year: 2025, startingBalance: 132_000, totalContributions: 10_000, endingBalance: 145_000 })),
    ];
    const portfolio = computePortfolioSummary([{ account: acc, ownerDisplayName: 'X' }], balances);
    const single = accountReturns(balances);
    // The portfolio aggregator computes capital + gain unrounded per year then divides;
    // accountReturns starts from `returnPct` which rounds to 2 decimals. Tolerate ~0.01% difference.
    expect(single.twr).toBeCloseTo(portfolio.summary.twr ?? 0, 1);
  });
});

describe('seed-$0 row exclusion across all three TWR surfaces', () => {
  // A narrow seed shape: all of startingBalance / endingBalance /
  // totalContributions / rollover / distributions are 0.
  const SEED = (accountId: string, year: number) =>
    aggregate(
      'accountBalance',
      `bal-${accountId}-${year}`,
      payload({ accountId, year }),
    );

  it('accountReturns: seed + one real year stays null (not NaN, not diluted)', () => {
    const acc = accountAgg({ name: 'A' });
    const balances = [
      SEED(acc.id, 2023),
      aggregate(
        'accountBalance',
        'bal-A-2025',
        payload({
          accountId: acc.id,
          year: 2025,
          startingBalance: 100_000,
          totalContributions: 10_000,
          endingBalance: 120_000,
        }),
      ),
    ];
    // Only one return-bearing row → null (the seed must not make it a 2-row
    // diluted geometric mean flipping the account to "has empirical history").
    expect(accountReturns(balances)).toEqual({ twr: null });
  });

  it('accountReturns: a single $0 seed row is null', () => {
    const acc = accountAgg({ name: 'A' });
    expect(accountReturns([SEED(acc.id, 2025)])).toEqual({ twr: null });
  });

  it('accountReturns: seed + TWO real rows = geo mean of the two real rows only', () => {
    const acc = accountAgg({ name: 'A' });
    const real = [
      aggregate(
        'accountBalance',
        'bal-A-2023',
        payload({ accountId: acc.id, year: 2023, startingBalance: 100_000, totalContributions: 10_000, endingBalance: 115_000 }),
      ),
      aggregate(
        'accountBalance',
        'bal-A-2024',
        payload({ accountId: acc.id, year: 2024, startingBalance: 115_000, totalContributions: 10_000, endingBalance: 130_000 }),
      ),
    ];
    const withSeed = accountReturns([SEED(acc.id, 2022), ...real]);
    const withoutSeed = accountReturns(real);
    expect(withSeed.twr).not.toBeNull();
    expect(withSeed.twr).toBeCloseTo(withoutSeed.twr ?? NaN, 6);
  });

  it('list-page TWR column shows null (—) for a seed-only account', () => {
    const acc = accountAgg({ name: 'A' });
    const r = computePortfolioSummary(
      [{ account: acc, ownerDisplayName: 'X' }],
      [SEED(acc.id, 2025)],
    );
    expect(r.accounts[0].twr).toBeNull();
  });

  it('portfolio TWR is null (—) for a seed-only portfolio (not diluted to 0%)', () => {
    const acc = accountAgg({ name: 'A' });
    const r = computePortfolioSummary(
      [{ account: acc, ownerDisplayName: 'X' }],
      [SEED(acc.id, 2025)],
    );
    expect(r.summary.twr).toBeNull();
  });

  it('isReturnBearingRow: a distributions-only row is return-bearing (not a seed)', () => {
    // Only distributions > 0, every other field 0 — a withdrawal happened, so
    // the row carries activity and must NOT be dropped as a no-flow seed.
    expect(
      isReturnBearingRow(payload({ distributions: 100 })),
    ).toBe(true);
  });

  it('a real rollover-funded zero-capital row is NOT excluded as degenerate', () => {
    // startingBalance==0, rollover>0, endingBalance>0 → carries return info.
    // Two such rows must produce a finite TWR (narrow predicate keeps them).
    const acc = accountAgg({ name: 'A' });
    const balances = [
      aggregate(
        'accountBalance',
        'bal-A-2023',
        payload({ accountId: acc.id, year: 2023, startingBalance: 0, rollover: 50_000, endingBalance: 55_000 }),
      ),
      aggregate(
        'accountBalance',
        'bal-A-2024',
        payload({ accountId: acc.id, year: 2024, startingBalance: 55_000, rollover: 0, endingBalance: 60_000 }),
      ),
    ];
    const r = accountReturns(balances);
    expect(r.twr).not.toBeNull();
    expect(Number.isFinite(r.twr)).toBe(true);
    // The list column also keeps the rollover-funded account (not demoted to —).
    const portfolio = computePortfolioSummary(
      [{ account: acc, ownerDisplayName: 'X' }],
      balances,
    );
    expect(portfolio.accounts[0].twr).not.toBeNull();
  });
});

describe('isPureRothEmployerType', () => {
  it('returns true for the four designated-Roth employer types', () => {
    for (const t of [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      expect(isPureRothEmployerType(t)).toBe(true);
    }
  });

  it('returns false for RETIREMENT_ROTH_IRA (individual Roth, not employer plan)', () => {
    expect(isPureRothEmployerType('RETIREMENT_ROTH_IRA')).toBe(false);
  });

  it('returns false for all non-Roth types', () => {
    for (const t of [
      'RETIREMENT_401K',
      'RETIREMENT_IRA',
      'RETIREMENT_403B',
      'RETIREMENT_457B',
      'RETIREMENT_TSP',
      'RETIREMENT_CASH_BALANCE',
      'BROKERAGE',
      'SAVINGS',
      'HSA',
      'OTHER',
    ] as const) {
      expect(isPureRothEmployerType(t)).toBe(false);
    }
  });
});
