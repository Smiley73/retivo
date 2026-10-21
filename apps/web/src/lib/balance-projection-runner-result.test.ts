/**
 * Result-shaping helper tests for `balance-projection-runner-result.ts`.
 *
 * Covers the RMD-surplus passthrough on `buildDrawdownYearRows`: the
 * `rmdReinvestedCents` / `rmdOverflowToCashCents` engine fields must copy
 * through onto `DrawdownYearRow` AS-IS (including `undefined → undefined`), so a
 * dropped engine value can't be silently masked by a downstream `?? 0`.
 */
import { describe, it, expect } from 'vitest';
import { buildDrawdownYearRows } from './balance-projection-runner-result';
import type { DrawdownYear } from './drawdown-engine';

/** Minimal DrawdownYear with the surplus fields controllable. */
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
    // The field is passed through AS-IS by buildDrawdownYearRows: a missing
    // engine value stays `undefined` here (the tax post-pass default, if any,
    // is a separate step downstream — this shape transform must not coerce).
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

describe('buildDrawdownYearRows — credit applied to premiums passthrough', () => {
  it('copies acaCreditAppliedToPremiumsCents through unchanged, undefined included', () => {
    const rows = buildDrawdownYearRows([
      makeYear({ year: 2030, acaCreditAppliedToPremiumsCents: 513_420 }),
      makeYear({ year: 2031 }),
    ]);
    expect(rows[0].acaCreditAppliedToPremiumsCents).toBe(513_420);
    expect(rows[1].acaCreditAppliedToPremiumsCents).toBeUndefined();
  });
});
