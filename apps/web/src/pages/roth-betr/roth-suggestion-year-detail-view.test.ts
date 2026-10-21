import { describe, expect, it } from 'vitest';
import type { YearDetailRow } from '../../lib/roth-suggestion/year-detail-types';
import { toYearDetailView } from './roth-suggestion-year-detail-view';

function detailRow(overrides: Partial<YearDetailRow> = {}): YearDetailRow {
  return {
    year: 2043,
    inWindow: true,
    filingStatus: 'MFJ',
    limitKind: 'irmaa',
    amountDollars: 237_806.07,
    lines: null,
    limitDollars: 382_264,
    incomeBeforeDollars: 144_455.21,
    incomeAfterDollars: 382_261.28,
    extraTaxableSsDollars: 0,
    taxPaymentIncomeDollars: 4_379.49,
    keptUnderDollars: 2.72,
    reroutedDollars: 0,
    breachedDollars: 0,
    incomeTaxDollars: 53_704,
    taxableSsDollars: 40_000,
    ssTier: 'eighty-five',
    irmaaPaidDollars: 0,
    irmaaSetDollars: 0,
    acaCreditDollars: 0,
    marketplaceMonths: 0,
    acaTier: 'below-fpl',
    preTaxEndDollars: 500_000,
    crossingNote: null,
    ...overrides,
  };
}

describe('the premium credit column', () => {
  it('says there was no Marketplace coverage, not that income was below the poverty line, in a year without it', () => {
    expect(toYearDetailView(detailRow()).credit).toBe('$0 (No Marketplace coverage)');
  });

  it('names the income tier in a year with Marketplace months', () => {
    const view = toYearDetailView(detailRow({ marketplaceMonths: 5, acaTier: 'sliding', acaCreditDollars: 6_000 }));
    expect(view.credit).toBe('$6,000 (Credit on a sliding scale)');
  });

  it('shows the credit alone in a year whose coverage is not worked out', () => {
    expect(toYearDetailView(detailRow({ marketplaceMonths: null, inWindow: false })).credit).toBe('$0');
  });
});
