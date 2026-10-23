import { describe, expect, it } from 'vitest';
import { computeFederalTax } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

// Single 2025: std deduction $15,750; a floor keeps the lower rate (strict >), and gross = floor + std.
// Single floors: 24% $103,350, 32% $197,300, 35% $250,525, 37% $626,350. MFJ 12%→22% floor $96,950 (std $31,500).
// HoH 22%→24% floor $103,350 (std $23,625).

describe('bracket boundaries — floor and floor+$1', () => {
  it.each([
    ['Single', 119100, 0.22, 1765100],
    ['Single', 119101, 0.24, 1765124],
    ['Single', 213050, 0.24, 4019900],
    ['Single', 213051, 0.32, 4019932],
    ['Single', 266275, 0.32, 5723100],
    ['Single', 266276, 0.35, 5723135],
    ['Single', 642100, 0.35, 18876975],
    ['Single', 642101, 0.37, 18877012],
    ['MFJ', 128450, 0.12, undefined],
    ['MFJ', 128451, 0.22, undefined],
    ['HoH', 126975, 0.22, undefined],
    ['HoH', 126976, 0.24, undefined],
  ] as const)(
    '%s 2025 gross %i reports marginal rate %f',
    (filingStatus, ordinaryIncome, marginalRate, ordinaryTax) => {
      const result = computeFederalTax(
        { year: 2025, filingStatus, ordinaryIncome, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      );
      expect(result.marginalOrdinaryRate).toBe(marginalRate);
      if (ordinaryTax !== undefined) expect(result.ordinaryTax).toBe(ordinaryTax);
    },
  );
});
