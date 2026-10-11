/**
 * Tests for `hasRetypeBlockingHistory` (`account-retype-block.ts`). Every case of
 * the retype-block rule lives here, grouped by the rule's terms.
 */
import { describe, expect, it } from 'vitest';

import { hasRetypeBlockingHistory, type RetypeHistoryRow } from './account-retype-block';
import { isReturnBearingRow } from './balance-calc';
import { contributionCentsOf } from './roth-basis-derivation';
import type { AccountBalancePayload } from '../db/types';

/** Full all-zero `AccountBalancePayload`; the four Roth fact keys are omitted
 *  (sparse-optional, absent means "nothing recorded"). A case lists only what
 *  it overrides. */
function payload(overrides: Partial<AccountBalancePayload> = {}): AccountBalancePayload {
  return {
    accountId: 'acc-1',
    year: 2020,
    lastUpdated: '2020-12-31T23:59:59Z',
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

function row(overrides: Partial<AccountBalancePayload> = {}): RetypeHistoryRow {
  return { payload: payload(overrides) };
}

describe('hasRetypeBlockingHistory — term 1 (base term, unscoped and un-year-gated)', () => {
  it('is clear with no rows at all', () => {
    expect(hasRetypeBlockingHistory('acc-1', [])).toBe(false);
  });

  it('is clear for the creation seed — every field $0, no Roth facts', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row()])).toBe(false);
  });

  it('is blocked for endingBalance $10,000', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ endingBalance: 10_000 })])).toBe(true);
  });

  it('is blocked for startingBalance $10,000', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ startingBalance: 10_000 })])).toBe(true);
  });

  it('is blocked for distributions $500 and nothing else', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ distributions: 500 })])).toBe(true);
  });

  it('is blocked for an outbound-only rollover of −$5,000', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ rollover: -5_000 })])).toBe(true);
  });

  it('is blocked for totalContributions $5,000 all of it companyContributions', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ totalContributions: 5_000, companyContributions: 5_000, endingBalance: 5_000 }),
      ]),
    ).toBe(true);
  });

  it('is blocked when companyContributions exceeds totalContributions (personal share $0)', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ totalContributions: 2_000, companyContributions: 5_000 }),
      ]),
    ).toBe(true);
  });

  it('is blocked for endingBalance $10,000 on year 1997 — the year gate is term 2’s only', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ endingBalance: 10_000, year: 1997 })]),
    ).toBe(true);
  });

  it('is blocked for totalContributions: NaN — corrupt never reads as clear', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ totalContributions: NaN })])).toBe(true);
  });
});

describe('hasRetypeBlockingHistory — term 2 (dated Roth facts)', () => {
  it('is blocked for rothConversionTaxableAmount $50,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothConversionTaxableAmount: 50_000 })]),
    ).toBe(true);
  });

  it('is blocked for rothConversionNontaxableAmount $50,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothConversionNontaxableAmount: 50_000 })]),
    ).toBe(true);
  });

  it('is blocked for rothInPlanRolloverTaxableAmount $50,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothInPlanRolloverTaxableAmount: 50_000 })]),
    ).toBe(true);
  });

  it('is blocked for rothInPlanRolloverNontaxableAmount $50,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothInPlanRolloverNontaxableAmount: 50_000 })]),
    ).toBe(true);
  });

  it('is blocked for rothConversionTaxableAmount $0.01', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ rothConversionTaxableAmount: 0.01 })])).toBe(
      true,
    );
  });

  it('is clear when all four fact keys are absent', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row()])).toBe(false);
  });

  it('is clear for an explicit zero rothConversionTaxableAmount', () => {
    expect(hasRetypeBlockingHistory('acc-1', [row({ rothConversionTaxableAmount: 0 })])).toBe(
      false,
    );
  });

  it('is clear for a negative rothConversionTaxableAmount', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothConversionTaxableAmount: -50_000 })]),
    ).toBe(false);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ["'50000'", '50000'],
    ['null', null],
  ])('is clear for rothConversionTaxableAmount %s', (_label, value) => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ rothConversionTaxableAmount: value as unknown as number }),
      ]),
    ).toBe(false);
  });

  it('is clear for rothConversionTaxableAmount past the magnitude bound (1e308)', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [row({ rothConversionTaxableAmount: 1e308 })]),
    ).toBe(false);
  });

  it.each([
    ['1997', 1997],
    ['2201', 2201],
    ['2024.5', 2024.5],
    ['NaN', NaN],
  ])('is clear for rothConversionTaxableAmount $50,000 with year %s', (_label, year) => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ rothConversionTaxableAmount: 50_000, year }),
      ]),
    ).toBe(false);
  });

  it.each([
    ['1998', 1998],
    ['2200', 2200],
  ])('is blocked for rothConversionTaxableAmount $50,000 with year %s (bound edge)', (
    _label,
    year,
  ) => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ rothConversionTaxableAmount: 50_000, year }),
      ]),
    ).toBe(true);
  });

  it('blocks a row whose only recorded activity is a Roth conversion, though isReturnBearingRow says false — the case the block must still catch', () => {
    const p = payload({ rothConversionTaxableAmount: 50_000 });
    expect(isReturnBearingRow(p)).toBe(false);
    expect(hasRetypeBlockingHistory('acc-1', [{ payload: p }])).toBe(true);
  });
});

describe('hasRetypeBlockingHistory — term 3 (personal contribution share)', () => {
  it('is blocked for a MIXED row whose company split is entered negative (the containment hole)', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({
          contributionsPostTax: 5_000,
          companyContributionsPostTax: -5_000,
          contributionsPreTax: 0,
          companyContributionsPreTax: 0,
        }),
      ]),
    ).toBe(true);
  });

  it('is blocked for a MIXED row with contributionsPreTax $3,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({
          contributionsPreTax: 3_000,
          contributionsPostTax: 0,
          companyContributionsPreTax: 0,
          companyContributionsPostTax: 0,
        }),
      ]),
    ).toBe(true);
  });

  it('is blocked for a non-MIXED row with totalContributions $8,000, companyContributions $2,000', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ totalContributions: 8_000, companyContributions: 2_000, endingBalance: 8_000 }),
      ]),
    ).toBe(true);
  });

  it('is clear for a MIXED row with all four split fields $0 (non-null)', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({
          contributionsPreTax: 0,
          contributionsPostTax: 0,
          companyContributionsPreTax: 0,
          companyContributionsPostTax: 0,
        }),
      ]),
    ).toBe(false);
  });

  it('contains every row shape the retired hasRecordedPersonalContributions fired on: personalCents > 0n implies blocked', () => {
    // The retired predicate's own trigger table (roth-pool-warnings.test.ts)
    // — reproduced here as plain payloads, never through the retired
    // predicate itself.
    const shapes: ReadonlyArray<AccountBalancePayload> = [
      payload({ totalContributions: 6_000, endingBalance: 6_000 }),
      payload({
        contributionsPreTax: 4_000,
        contributionsPostTax: 2_000,
        companyContributionsPreTax: 3_000,
        companyContributionsPostTax: 0,
        totalContributions: 9_000,
        endingBalance: 9_000,
      }),
      payload({
        contributionsPreTax: 6_000,
        contributionsPostTax: 0,
        companyContributionsPreTax: 3_000,
        companyContributionsPostTax: 0,
        totalContributions: 9_000,
        endingBalance: 9_000,
      }),
    ];
    for (const p of shapes) {
      expect(contributionCentsOf(p).personalCents > 0n).toBe(true);
      expect(hasRetypeBlockingHistory('acc-1', [{ payload: p }])).toBe(true);
    }
  });
});

describe('hasRetypeBlockingHistory — scoping, tombstones, duplicates, order', () => {
  it('is clear when the only qualifying row has accountId acc-2', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        row({ accountId: 'acc-2', endingBalance: 10_000 }),
      ]),
    ).toBe(false);
  });

  it('is clear when the only qualifying row carries a deletedAt', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        { payload: payload({ endingBalance: 10_000 }), deletedAt: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe(false);
  });

  it('is clear for a deleted qualifying row plus a live seed row', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        { payload: payload({ endingBalance: 10_000 }), deletedAt: '2026-01-01T00:00:00Z' },
        row(),
      ]),
    ).toBe(false);
  });

  it('is blocked for a deleted qualifying row plus a live qualifying row', () => {
    expect(
      hasRetypeBlockingHistory('acc-1', [
        { payload: payload({ endingBalance: 10_000 }), deletedAt: '2026-01-01T00:00:00Z' },
        row({ endingBalance: 20_000 }),
      ]),
    ).toBe(true);
  });

  it('is blocked for duplicate (acc-1, 2020) rows — no first-row-wins tie-break', () => {
    const rows = [row(), row({ rothConversionTaxableAmount: 50_000 })];
    expect(hasRetypeBlockingHistory('acc-1', rows)).toBe(true);
  });

  it('is clear for acc-3 against a non-empty array with no acc-3 row', () => {
    expect(
      hasRetypeBlockingHistory('acc-3', [row({ endingBalance: 10_000 })]),
    ).toBe(false);
  });

  it("is clear for hasRetypeBlockingHistory('', [])", () => {
    expect(hasRetypeBlockingHistory('', [])).toBe(false);
  });

  it('returns the identical verdict for every multi-row case above with the rows array shuffled', () => {
    const cases: ReadonlyArray<{ rows: RetypeHistoryRow[]; verdict: boolean }> = [
      {
        rows: [
          { payload: payload({ endingBalance: 10_000 }), deletedAt: '2026-01-01T00:00:00Z' },
          row(),
        ],
        verdict: false,
      },
      {
        rows: [
          { payload: payload({ endingBalance: 10_000 }), deletedAt: '2026-01-01T00:00:00Z' },
          row({ endingBalance: 20_000 }),
        ],
        verdict: true,
      },
      {
        rows: [row(), row({ rothConversionTaxableAmount: 50_000 })],
        verdict: true,
      },
    ];
    for (const { rows, verdict } of cases) {
      expect(hasRetypeBlockingHistory('acc-1', [...rows].reverse())).toBe(verdict);
    }
  });
});
