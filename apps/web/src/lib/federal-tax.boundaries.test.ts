/**
 * Bracket-boundary matrix for Single 2025 — exact cent values at each
 * 22%/24%/32%/35%/37% transition point. Verifies the floor-exclusive
 * (taxableIncome > floor) marginal-rate convention and per-cent rounding.
 */

import { describe, expect, it } from 'vitest';
import { computeFederalTax } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

// Single 2025: std deduction $15,750 (OBBBA-raised)
// Brackets: 10%@0, 12%@11925, 22%@48475, 24%@103350, 32%@197300, 35%@250525, 37%@626350

// Each pair is the floor (strict-gt convention: still the lower rate) and one
// dollar above the floor (the higher rate).
// Single: 22%->24% taxable floor $103,350 (gross $119,100); 24%->32% floor
// $197,300 (gross $213,050); 32%->35% floor $250,525 (gross $266,275);
// 35%->37% floor $626,350 (gross $642,100).
// MFJ 2025 brackets: 10%@0, 12%@23850, 22%@96950, 24%@206700, 32%@394600, 35%@501050, 37%@751600
// Standard deduction MFJ 2025: $31,500 (OBBBA-raised); 12%->22% taxable floor $96,950 (gross $128,450).
// HoH 2025 brackets: 10%@0, 12%@17000, 22%@64850, 24%@103350, 32%@197300, 35%@250500, 37%@626350
// Standard deduction HoH 2025: $23,625 (OBBBA-raised); 22%->24% taxable floor $103,350 (gross $126,975).

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
