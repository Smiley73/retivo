/** Tests for the RMD-surplus passthrough in `buildDrawdownYearRows` (`balance-projection-runner-result.ts`). */
import { describe, it, expect } from 'vitest';
import { buildDrawdownYearRows } from './balance-projection-runner-result';
import type { DrawdownYear } from './drawdown-engine';

function makeYear(overrides: Partial<DrawdownYear> & { year: number }): DrawdownYear {
  return {
    balance: 500_000,
    withdrawn: 40_000,
    netNeed: 40_000,
    growth: 0,
    deposit: 0,
    depleted: false,
    ...overrides,
  };
}

describe('buildDrawdownYearRows — RMD surplus passthrough', () => {
  it('copies rmdReinvestedCents and rmdOverflowToCashCents through unchanged', () => {
    const years: DrawdownYear[] = [
      makeYear({ year: 2030, rmdReinvestedCents: 123_456, rmdOverflowToCashCents: undefined }),
      makeYear({ year: 2031, rmdReinvestedCents: undefined, rmdOverflowToCashCents: 789_012 }),
    ];
    const rows = buildDrawdownYearRows(years);
    expect(rows[0].rmdReinvestedCents).toBe(123_456);
    expect(rows[1].rmdOverflowToCashCents).toBe(789_012);
  });

  it('preserves undefined as undefined — no `?? 0` masking a dropped engine value', () => {
    const years: DrawdownYear[] = [
      makeYear({ year: 2030, rmdReinvestedCents: undefined, rmdOverflowToCashCents: undefined }),
    ];
    const rows = buildDrawdownYearRows(years);
    // Passed through as-is: a missing engine value stays undefined; this shape transform must not coerce.
    expect(rows[0].rmdReinvestedCents).toBeUndefined();
    expect(rows[0].rmdOverflowToCashCents).toBeUndefined();
  });

  it('preserves an explicit zero distinctly from undefined', () => {
    const years: DrawdownYear[] = [
      makeYear({ year: 2030, rmdReinvestedCents: 0, rmdOverflowToCashCents: 0 }),
    ];
    const rows = buildDrawdownYearRows(years);
    expect(rows[0].rmdReinvestedCents).toBe(0);
    expect(rows[0].rmdOverflowToCashCents).toBe(0);
  });
});
