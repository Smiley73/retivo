/**
 * Calibration seed config tests — schema validation.
 */

import { describe, expect, it } from 'vitest';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';

describe('SS_TAX_THRESHOLDS schema', () => {
  const entry = SS_TAX_THRESHOLDS.values[2024];

  it('2024 entry exists', () => {
    expect(entry).toBeDefined();
  });

  it('all tier values are positive integers', () => {
    const fields = [
      entry.tier1.Single,
      entry.tier1.MFJ,
      entry.tier1.HoH,
      entry.tier2.Single,
      entry.tier2.MFJ,
      entry.tier2.HoH,
    ];
    for (const v of fields) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('tier1 < tier2 for every filing status', () => {
    expect(entry.tier1.Single).toBeLessThan(entry.tier2.Single);
    expect(entry.tier1.MFJ).toBeLessThan(entry.tier2.MFJ);
    expect(entry.tier1.HoH).toBeLessThan(entry.tier2.HoH);
  });

  it('all three filing statuses present in tier1 and tier2', () => {
    expect(entry.tier1).toHaveProperty('Single');
    expect(entry.tier1).toHaveProperty('MFJ');
    expect(entry.tier1).toHaveProperty('HoH');
    expect(entry.tier2).toHaveProperty('Single');
    expect(entry.tier2).toHaveProperty('MFJ');
    expect(entry.tier2).toHaveProperty('HoH');
  });

  it('metadata.source is non-empty', () => {
    expect(SS_TAX_THRESHOLDS.metadata.source.length).toBeGreaterThan(0);
  });

  it('metadata.asOfDate parses as valid ISO date', () => {
    const d = new Date(SS_TAX_THRESHOLDS.metadata.asOfDate);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
