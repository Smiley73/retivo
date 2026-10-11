/**
 * Calibration snapshot integrity tests for ACA_PTC_PARAMETERS.
 *
 * Structural checks only; the table constants are not retyped here.
 */

import { describe, it, expect } from 'vitest';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';

const snap = ACA_PTC_PARAMETERS;

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------
describe('ACA_PTC_PARAMETERS — snapshot structure', () => {
  it('has values for 2024, 2025, 2026', () => {
    expect(snap.values[2024]).toBeDefined();
    expect(snap.values[2025]).toBeDefined();
    expect(snap.values[2026]).toBeDefined();
  });

  it('has metadata with source URLs, asOfDate, jurisdiction', () => {
    // 2024 applicable percentages: Rev Proc 2023-29
    expect(snap.metadata.source).toContain('rp-23-29.pdf');
    // 2025 applicable percentages: Rev Proc 2024-35
    expect(snap.metadata.source).toContain('rp-24-35.pdf');
    // 2026 applicable percentages: Rev Proc 2025-25
    expect(snap.metadata.source).toContain('rp-25-25.pdf');
    expect(snap.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // IRB 2025-32 (Rev Proc 2025-25) published 2025-08-04 — most-recent source
    expect(snap.metadata.asOfDate).toBe('2025-08-04');
    expect(snap.metadata.jurisdiction).toBe('US-federal');
  });

  it('source URLs are in strict chronological order (HHS/IRS interleaved by publish date)', () => {
    // Required order: composite snapshots list sources
    // chronologically — HHS 2023 (Jan 2023) → IRS rp-23-29 (Aug 2023) →
    // HHS 2024 (Jan 2024) → IRS rp-24-35 (Aug 2024) →
    // HHS 2025 (Jan 2025) → IRS rp-25-25 (Aug 2025)
    const src = snap.metadata.source;
    const hhs2023 = src.indexOf('2023-hhs-poverty-guidelines');
    const rp2329  = src.indexOf('rp-23-29.pdf');
    const hhs2024 = src.indexOf('2024-hhs-poverty-guidelines');
    const rp2435  = src.indexOf('rp-24-35.pdf');
    const hhs2025 = src.indexOf('2025-hhs-poverty-guidelines');
    const rp2525  = src.indexOf('rp-25-25.pdf');
    expect(hhs2023).toBeLessThan(rp2329);
    expect(rp2329).toBeLessThan(hhs2024);
    expect(hhs2024).toBeLessThan(rp2435);
    expect(rp2435).toBeLessThan(hhs2025);
    expect(hhs2025).toBeLessThan(rp2525);
  });
});

// ---------------------------------------------------------------------------
// 2024 — regime + FPL
// ---------------------------------------------------------------------------
describe('ACA_PTC_PARAMETERS — 2024 regime + FPL', () => {
  const t = snap.values[2024];

  it('regime is ira-expanded', () => {
    expect(t.regime).toBe('ira-expanded');
  });

  it('has 6 bands', () => {
    expect(t.bands.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 2025 — regime + FPL
// ---------------------------------------------------------------------------
describe('ACA_PTC_PARAMETERS — 2025 regime + FPL', () => {
  const t = snap.values[2025];

  it('regime is ira-expanded', () => {
    expect(t.regime).toBe('ira-expanded');
  });

  it('has 6 bands', () => {
    expect(t.bands.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 2026 — regime + FPL
// ---------------------------------------------------------------------------
describe('ACA_PTC_PARAMETERS — 2026 regime + FPL', () => {
  const t = snap.values[2026];

  it('regime is pre-arpa', () => {
    expect(t.regime).toBe('pre-arpa');
  });

  it('has 6 bands (no open-ended cap band)', () => {
    expect(t.bands.length).toBe(6);
  });

  it('last band ceiling is 400 (not Infinity — cliff reinstated)', () => {
    expect(t.bands[t.bands.length - 1].fplCeilingPct).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Band ordering invariant
// ---------------------------------------------------------------------------
describe('ACA_PTC_PARAMETERS — band ordering', () => {
  for (const year of [2024, 2025, 2026] as const) {
    it(`${year}: bands ordered by ascending fplFloorPct`, () => {
      const { bands } = snap.values[year];
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].fplFloorPct).toBeGreaterThanOrEqual(bands[i - 1].fplCeilingPct);
      }
    });

    it(`${year}: each band has floor <= ceiling contribution`, () => {
      const { bands } = snap.values[year];
      for (const band of bands) {
        expect(band.floorContributionPct).toBeLessThanOrEqual(band.ceilingContributionPct);
      }
    });

    it(`${year}: bands start at 100% FPL`, () => {
      expect(snap.values[year].bands[0].fplFloorPct).toBe(100);
    });
  }
});

describe('ACA_PTC_PARAMETERS — Alaska / Hawaii regional FPL schedules', () => {
  it.each([
    [2024, 'alaska', 18_210, 6_430],
    [2024, 'hawaii', 16_770, 5_910],
    [2025, 'alaska', 18_810, 6_730],
    [2025, 'hawaii', 17_310, 6_190],
  ] as const)('%i %s base/increment', (year, region, base, increment) => {
    expect(snap.values[year].fpl[region]).toEqual({ base, increment });
  });
});
