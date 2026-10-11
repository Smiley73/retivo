/**
 * Schema validation tests for IRMAA_TIERS.
 * Verifies structural integrity of the published CMS values.
 */

import { describe, it, expect } from 'vitest';
import { IRMAA_TIERS } from './irmaa-tiers';
import type { IrmaaTable, IrmaaTableEntry } from './irmaa-tiers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateEntries(entries: readonly IrmaaTableEntry[], label: string): void {
  it(`${label}: has 5 entries (tier1–tier5)`, () => {
    expect(entries).toHaveLength(5);
  });

  it(`${label}: thresholdDollars values are strictly ascending positive integers`, () => {
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i].thresholdDollars).toBeGreaterThan(0);
      if (i > 0) {
        expect(entries[i].thresholdDollars).toBeGreaterThan(entries[i - 1].thresholdDollars);
      }
      expect(Number.isInteger(entries[i].thresholdDollars)).toBe(true);
    }
  });

  it(`${label}: all entries have positive Part B surcharges`, () => {
    for (const entry of entries) {
      expect(entry.partBMonthly).toBeGreaterThan(0);
    }
  });

  it(`${label}: all entries have positive Part D surcharges`, () => {
    for (const entry of entries) {
      expect(entry.partDMonthly).toBeGreaterThan(0);
    }
  });

  it(`${label}: Part B surcharges are strictly ascending`, () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].partBMonthly).toBeGreaterThan(entries[i - 1].partBMonthly);
    }
  });

  it(`${label}: Part D surcharges are strictly ascending`, () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].partDMonthly).toBeGreaterThan(entries[i - 1].partDMonthly);
    }
  });
}

function validateYearTable(table: IrmaaTable, year: number): void {
  describe(`${year} bySingle`, () => {
    validateEntries(table.bySingle, `${year}/Single`);
  });

  describe(`${year} byMfj`, () => {
    validateEntries(table.byMfj, `${year}/MFJ`);
  });

  it(`${year}: MFJ thresholds are higher than Single at each position`, () => {
    for (let i = 0; i < 4; i++) {
      // Standard positions 0–3 (position 4 = top bracket, both use $500k/$750k)
      expect(table.byMfj[i].thresholdDollars).toBeGreaterThan(table.bySingle[i].thresholdDollars);
    }
  });

  it(`${year}: both filing groups use same surcharge amounts per tier`, () => {
    for (let i = 0; i < 5; i++) {
      expect(table.byMfj[i].partBMonthly).toBe(table.bySingle[i].partBMonthly);
      expect(table.byMfj[i].partDMonthly).toBe(table.bySingle[i].partDMonthly);
    }
  });
}

// ---------------------------------------------------------------------------
// Snapshot-level tests
// ---------------------------------------------------------------------------

describe('IRMAA_TIERS snapshot', () => {
  it('has values for 2024, 2025, and 2026', () => {
    expect(Object.keys(IRMAA_TIERS.values).map(Number).sort()).toEqual([2024, 2025, 2026]);
  });

  it('has non-empty metadata.source', () => {
    expect(IRMAA_TIERS.metadata.source.length).toBeGreaterThan(0);
  });

  it('has valid asOfDate (YYYY-MM-DD)', () => {
    expect(IRMAA_TIERS.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has jurisdiction US-federal', () => {
    expect(IRMAA_TIERS.metadata.jurisdiction).toBe('US-federal');
  });
});

// ---------------------------------------------------------------------------
// Per-year structural tests
// ---------------------------------------------------------------------------

describe('IRMAA_TIERS 2024', () => {
  validateYearTable(IRMAA_TIERS.values[2024]!, 2024);
});

describe('IRMAA_TIERS 2025', () => {
  validateYearTable(IRMAA_TIERS.values[2025]!, 2025);
});

describe('IRMAA_TIERS 2026', () => {
  validateYearTable(IRMAA_TIERS.values[2026]!, 2026);
});

// ---------------------------------------------------------------------------
// byMfs two-band structure — NOT strictly-ascending by design.
// ---------------------------------------------------------------------------

describe('IRMAA_TIERS byMfs (MFS lived-with-spouse)', () => {
  for (const year of [2024, 2025, 2026] as const) {
    const table = IRMAA_TIERS.values[year]!;
    const { byMfs, bySingle } = table;

    it(`${year}: byMfs has 5 entries`, () => {
      expect(byMfs).toHaveLength(5);
    });

    it(`${year}: entry threshold = Single tier1 threshold`, () => {
      expect(byMfs[0].thresholdDollars).toBe(bySingle[0].thresholdDollars);
    });

    it(`${year}: middle-band surcharge = Single tier4 amounts`, () => {
      expect(byMfs[0].partBMonthly).toBe(bySingle[3].partBMonthly);
      expect(byMfs[0].partDMonthly).toBe(bySingle[3].partDMonthly);
    });

    it(`${year}: top band (slots 1–4) = the high MFS threshold + Single tier5 surcharge`, () => {
      for (let i = 1; i < 5; i++) {
        expect(byMfs[i].thresholdDollars).toBe(byMfs[1].thresholdDollars);
        expect(byMfs[i].partBMonthly).toBe(bySingle[4].partBMonthly);
        expect(byMfs[i].partDMonthly).toBe(bySingle[4].partDMonthly);
      }
      expect(byMfs[1].thresholdDollars).toBeGreaterThan(byMfs[0].thresholdDollars);
    });
  }

  // The published CMS MFS lived-with-spouse top thresholds.
  it('2026 MFS top threshold = $391,000 (CMS; corrected from $397,000)', () => {
    expect(IRMAA_TIERS.values[2026]!.byMfs[1].thresholdDollars).toBe(391_000);
  });
});

// ---------------------------------------------------------------------------
// Source URL assertions
// ---------------------------------------------------------------------------

describe('IRMAA_TIERS metadata.source URLs', () => {
  it('contains corrected 2024 CMS source URL', () => {
    expect(IRMAA_TIERS.metadata.source).toContain(
      'https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles',
    );
  });

  it('contains corrected 2025 CMS source URL', () => {
    expect(IRMAA_TIERS.metadata.source).toContain(
      'https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles',
    );
  });

  it('contains 2026 CMS source URL', () => {
    expect(IRMAA_TIERS.metadata.source).toContain(
      'https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
    );
  });
});

describe('IRMAA_TIERS published threshold pins', () => {
  it.each([
    [2026, 'bySingle', 0, 109_000],
    [2026, 'byMfj', 0, 218_000],
    [2024, 'byMfj', 0, 206_000],
    [2024, 'byMfs', 1, 397_000],
    [2025, 'byMfs', 1, 394_000],
  ] as const)('%i %s[%i] threshold', (year, group, index, threshold) => {
    expect(IRMAA_TIERS.values[year]![group][index].thresholdDollars).toBe(threshold);
  });
});
