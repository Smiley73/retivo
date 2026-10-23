import { describe, it, expect } from 'vitest';
import {
  computeAcaPtc,
  type AcaPtcInput,
  type AcaPtcTable,
} from './aca-ptc';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import type { CalibrationSnapshot } from './calibration';

const snap = ACA_PTC_PARAMETERS;

function input(overrides: Partial<AcaPtcInput> = {}): AcaPtcInput {
  return {
    taxYear: 2025,
    filingStatus: 'Single',
    householdSize: 1,
    magiCents: 2_800_000,
    benchmarkAnnualSlcspCents: 600_000,
    ...overrides,
  };
}

describe('computeAcaPtc — band boundary semantics (IRA-expanded 2025)', () => {
  // 2025 single FPL = $15,060. Each boundary in cents = boundary% * 15060 * 100.
  const fpl = 15_060;

  it('exactly 150% FPL: should fall in 100-150 band (floor=0)', () => {
    const magi = Math.round(1.5 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0);
  });

  it('exactly 200% FPL: should fall in 150-200 band at ceiling (=0.02)', () => {
    const magi = Math.round(2.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.02);
  });

  it('exactly 250% FPL: should fall in 200-250 band at ceiling (=0.04)', () => {
    const magi = Math.round(2.5 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.04);
  });

  it('exactly 300% FPL: should fall in 250-300 band at ceiling (=0.06)', () => {
    const magi = Math.round(3.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.06);
  });

  it('exactly 400% FPL: tier=cap-applies (IRA-expanded, ≥400 → cap)', () => {
    const magi = Math.round(4.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: magi }), snap);
    expect(r.tier).toBe('cap-applies');
    expect(r.applicableFigurePct).toBe(0.085);
  });
});

describe('computeAcaPtc — band boundary semantics (pre-ARPA 2026)', () => {
  // 2026 single FPL = $15,650
  const fpl = 15_650;

  it('exactly 133% FPL: should fall in 133-150 band (band 1 floor 3.14%)', () => {
    const magi = Math.round(1.33 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.0314);
  });

  it('exactly 150% FPL: should fall in 133-150 band at ceiling (=0.0419)', () => {
    const magi = Math.round(1.5 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.0419);
  });

  it('exactly 200% FPL: should fall in 150-200 band at ceiling (=0.0660)', () => {
    const magi = Math.round(2.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.0660);
  });

  it('exactly 250% FPL: should fall in 200-250 band at ceiling (=0.0844)', () => {
    const magi = Math.round(2.5 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.0844);
  });

  it('exactly 300% FPL: should fall in 250-300 band at ceiling (=0.0996)', () => {
    const magi = Math.round(3.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    expect(r.applicableFigurePct).toBe(0.0996);
  });

  it('exactly 400% FPL: last band inclusive ceiling → sliding, 0.0996', () => {
    const magi = Math.round(4.0 * fpl * 100);
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: magi }), snap);
    // Last band (300-400) is inclusive on ceiling
    expect(r.tier).toBe('sliding');
    expect(r.applicableFigurePct).toBe(0.0996);
  });
});

describe('computeAcaPtc — cap-applies short-circuit', () => {
  it('uses open-ended band rate directly, not band interpolation', () => {
    // Synthetic snapshot: cap band has 9% flat rate (not 8.5%).
    const syntheticSnap: CalibrationSnapshot<AcaPtcTable> = {
      values: {
        2025: {
          regime: 'ira-expanded',
          fpl: { base: 15_060, increment: 5_380 },
          bands: [
            { fplFloorPct: 100, fplCeilingPct: 150, floorContributionPct: 0, ceilingContributionPct: 0 },
            { fplFloorPct: 150, fplCeilingPct: 200, floorContributionPct: 0, ceilingContributionPct: 0.02 },
            { fplFloorPct: 200, fplCeilingPct: 250, floorContributionPct: 0.02, ceilingContributionPct: 0.04 },
            { fplFloorPct: 250, fplCeilingPct: 300, floorContributionPct: 0.04, ceilingContributionPct: 0.06 },
            { fplFloorPct: 300, fplCeilingPct: 400, floorContributionPct: 0.06, ceilingContributionPct: 0.075 }, // ceiling ≠ cap rate
            { fplFloorPct: 400, fplCeilingPct: Infinity, floorContributionPct: 0.09, ceilingContributionPct: 0.09 }, // cap = 9%
          ],
        },
      },
      metadata: { source: 'synthetic', asOfDate: '2025-01-01', jurisdiction: 'US-federal' },
    };

    const magi = Math.round(4.5 * 15_060 * 100);
    const r = computeAcaPtc(input({ taxYear: 2025, magiCents: magi }), syntheticSnap);
    expect(r.tier).toBe('cap-applies');
    expect(r.applicableFigurePct).toBe(0.09);
  });
});

describe('computeAcaPtc — eligible flag', () => {
  it('below-fpl → eligible = false', () => {
    const r = computeAcaPtc(input({ magiCents: 1_000_000 }), snap);
    expect(r.tier).toBe('below-fpl');
    expect(r.eligible).toBe(false);
  });

  it('sliding → eligible = true', () => {
    const r = computeAcaPtc(input({ magiCents: 2_800_000 }), snap);
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
  });

  it('cap-applies → eligible = true', () => {
    const r = computeAcaPtc(input({ taxYear: 2025, magiCents: 7_530_000 }), snap);
    expect(r.tier).toBe('cap-applies');
    expect(r.eligible).toBe(true);
  });

  it('above-400-cliff → eligible = false', () => {
    const r = computeAcaPtc(input({ taxYear: 2026, magiCents: 6_300_000 }), snap);
    expect(r.tier).toBe('above-400-cliff');
    expect(r.eligible).toBe(false);
  });
});

describe('computeAcaPtc — household size scaling', () => {
  it('larger household has higher FPL → different band for same MAGI', () => {
    // $40,000 MAGI. Size 1: 40000/15060 ≈ 266% → 250-300 band.
    // Size 4: 40000/31200 ≈ 128% → 100-150 band.
    const r1 = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 4_000_000 }),
      snap,
    );
    const r4 = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 4, magiCents: 4_000_000 }),
      snap,
    );
    expect(r1.applicableFigurePct).toBeGreaterThan(r4.applicableFigurePct);
  });

  it('larger household gets larger PTC for same MAGI and SLCSP', () => {
    const r1 = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 4_000_000 }),
      snap,
    );
    const r4 = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 4, magiCents: 4_000_000 }),
      snap,
    );
    expect(r4.annualPtcCents).toBeGreaterThan(r1.annualPtcCents);
  });
});
