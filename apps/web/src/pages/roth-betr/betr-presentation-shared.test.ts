import { describe, it, expect } from 'vitest';
import {
  comparisonLabel,
  BETR_SOURCE_LABELS,
  BETR_SOURCE_SELECT_OPTIONS,
} from './betr-presentation-shared';

describe('comparisonLabel', () => {
  it('maps Convert to the above-break-even statement', () => {
    expect(comparisonLabel('Convert')).toBe('RMD-era rate above break-even');
  });

  it('maps Hold to the at-or-below-break-even statement', () => {
    expect(comparisonLabel('Hold')).toBe('RMD-era rate at or below break-even');
  });
});

describe('BETR source labels', () => {
  it('lists the four sources in order with their neutral labels', () => {
    expect(BETR_SOURCE_LABELS).toEqual([
      { source: 'ira', label: 'Pay tax from the IRA' },
      { source: 'taxEfficient', label: 'Taxable account (lower default tax drag)' },
      { source: 'taxInefficient', label: 'Taxable account (higher default tax drag)' },
      { source: 'cash', label: 'Cash' },
    ]);
  });

  it('derives Select options that mirror the labels one-for-one', () => {
    expect(BETR_SOURCE_SELECT_OPTIONS).toEqual(
      BETR_SOURCE_LABELS.map(({ source, label }) => ({ value: source, label })),
    );
  });
});
