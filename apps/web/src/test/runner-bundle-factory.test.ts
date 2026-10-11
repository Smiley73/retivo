/**
 * Self-test for `buildRunnerBundle` — defaults produce a valid empty
 * bundle; overrides win.
 */
import { describe, it, expect } from 'vitest';
import { buildRunnerBundle } from './runner-bundle-factory';

describe('buildRunnerBundle', () => {
  it('returns a minimal valid bundle by default', () => {
    const b = buildRunnerBundle();
    expect(b.methodAvailable).toBe(true);
    expect(b.atHorizonTodayDollars).toBe(0);
    expect(b.drawdownYears).toEqual([]);
    expect(b.accountYears.size).toBe(0);
    expect(b.todayYear).toBe(2026);
    expect(b.todayMonthIndex).toBe(5);
    expect(b.cbpResolution).toBeNull();
  });

  it('honors top-level overrides', () => {
    const b = buildRunnerBundle({
      methodAvailable: false,
      atHorizonTodayDollars: 1_234_567,
      cbpResolution: { ok: false, unconfigured: [], annuityMissingStream: [], annuityDuplicateStream: [] },
    });
    expect(b.methodAvailable).toBe(false);
    expect(b.atHorizonTodayDollars).toBe(1_234_567);
    expect(b.cbpResolution?.ok).toBe(false);
  });
});
