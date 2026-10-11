/**
 * Tests for `resolveConversionLeg` — the single-home conversion-leg math used
 * by the working-years Roth-conversion runner + burden display.
 */
import { resolveConversionLeg } from './roth-conversion-utils';

describe('resolveConversionLeg', () => {
  it('moves the full gross and computes the burden at the assumed rate', () => {
    // $10,000.00 at 24% → $2,400.00 burden; full gross moves.
    const leg = resolveConversionLeg(1_000_000, 24);
    expect(leg.grossOutCents).toBe(1_000_000);
    expect(leg.taxBurdenCents).toBe(240_000);
  });

  it('rounds the burden to the nearest cent', () => {
    // $100.01 at 33% = 3300.33 cents → rounds to 3300.
    const leg = resolveConversionLeg(10_001, 33);
    expect(leg.taxBurdenCents).toBe(Math.round((10_001 * 33) / 100));
  });

  it('returns a zero burden at a 0% rate (full gross still moves)', () => {
    const leg = resolveConversionLeg(500_000, 0);
    expect(leg.grossOutCents).toBe(500_000);
    expect(leg.taxBurdenCents).toBe(0);
  });

  it('clamps an out-of-range rate to [0, 100]', () => {
    expect(resolveConversionLeg(100_000, 250).taxBurdenCents).toBe(100_000);
    expect(resolveConversionLeg(100_000, -5).taxBurdenCents).toBe(0);
  });

  it('resolves a non-finite / negative gross to a zero leg', () => {
    expect(resolveConversionLeg(Number.NaN, 24)).toEqual({
      grossOutCents: 0,
      taxBurdenCents: 0,
    });
    expect(resolveConversionLeg(-100, 24)).toEqual({
      grossOutCents: 0,
      taxBurdenCents: 0,
    });
  });

  it('treats a non-finite rate as 0 (no burden)', () => {
    expect(resolveConversionLeg(100_000, Number.NaN).taxBurdenCents).toBe(0);
  });
});
