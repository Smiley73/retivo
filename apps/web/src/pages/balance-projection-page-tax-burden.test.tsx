/**
 * TaxBurdenBand — unit tests.
 *
 * Covers: the gate predicate (non-zero check before rendering the tiles +
 * chart). The BalanceProjectionPage gate `taxBurdenRows.some(r => r.federalTax
 * !== 0 || r.irmaaSurcharge !== 0 || r.acaPtcSubsidy !== 0)` hides the summary
 * tiles, chart, and table when all rows are zero; the section heading +
 * empty-state copy still render (the section keeps its accessible name).
 * Tests here verify the predicate directly via the
 * TaxBurdenChartRow shape so the gate logic is regression-covered without a
 * full page render.
 */
import { describe, expect, it } from 'vitest';
import type { TaxBurdenChartRow } from '../components/TaxBurdenChart';
import { sumTaxBurden } from './balance-projection-page-tax-burden';

// ---------------------------------------------------------------------------
// Pure-logic predicate mirror (mirrors BalanceProjectionPage.tsx line ~1120)
// ---------------------------------------------------------------------------

function hasTaxBurdenData(rows: TaxBurdenChartRow[]): boolean {
  return rows.some(
    (r) => r.federalTax !== 0 || r.irmaaSurcharge !== 0 || r.acaPtcSubsidy !== 0,
  );
}

// ---------------------------------------------------------------------------
// Gate predicate
// ---------------------------------------------------------------------------

describe('TaxBurdenBand — gate predicate', () => {
  it('returns false for empty rows array', () => {
    expect(hasTaxBurdenData([])).toBe(false);
  });

  it('returns false when all rows have zero tax values', () => {
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: 0 },
      { year: 2031, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: 0 },
    ];
    expect(hasTaxBurdenData(rows)).toBe(false);
  });

  it('returns true when any row has non-zero federalTax', () => {
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: 0 },
      { year: 2031, federalTax: 1500, irmaaSurcharge: 0, acaPtcSubsidy: 0 },
    ];
    expect(hasTaxBurdenData(rows)).toBe(true);
  });

  it('returns true when any row has non-zero irmaaSurcharge', () => {
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 0, irmaaSurcharge: 800, acaPtcSubsidy: 0 },
    ];
    expect(hasTaxBurdenData(rows)).toBe(true);
  });

  it('returns true when any row has non-zero acaPtcSubsidy (negative by convention)', () => {
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -1200 },
    ];
    expect(hasTaxBurdenData(rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sumTaxBurden — lifetime-total aggregation for the summary tiles
// ---------------------------------------------------------------------------

describe('sumTaxBurden', () => {
  it('returns all-zero totals for an empty rows array', () => {
    expect(sumTaxBurden([])).toEqual({
      federalTax: 0,
      irmaaSurcharge: 0,
      acaPtcCredit: 0,
    });
  });

  it('sums federalTax and irmaaSurcharge across rows', () => {
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 1000, irmaaSurcharge: 200, acaPtcSubsidy: 0 },
      { year: 2031, federalTax: 1500, irmaaSurcharge: 300, acaPtcSubsidy: 0 },
    ];
    const total = sumTaxBurden(rows);
    expect(total.federalTax).toBe(2500);
    expect(total.irmaaSurcharge).toBe(500);
  });

  it('flips the negative acaPtcSubsidy convention to a positive credit', () => {
    // ACA-PTC is stored negative (renders below zero on the chart); the tile
    // shows the credit received as a positive figure.
    const rows: TaxBurdenChartRow[] = [
      { year: 2030, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -1200 },
      { year: 2031, federalTax: 0, irmaaSurcharge: 0, acaPtcSubsidy: -800 },
    ];
    expect(sumTaxBurden(rows).acaPtcCredit).toBe(2000);
  });
});
