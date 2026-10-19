import { describe, expect, it } from 'vitest';
import { successDeltaGate } from './success-delta-noise';

describe('successDeltaGate', () => {
  it('is about 0.0047 for 0.90 vs 0.85 at 10,000 paths', () => {
    const gate = successDeltaGate(0.9, 10_000, 0.85, 10_000);
    expect(gate.se).toBeCloseTo(0.0047, 4);
    expect(gate.delta).toBeCloseTo(0.05, 10);
    expect(gate.meaningful).toBe(true);
  });

  it('treats a 0.3-point delta as noise at that standard error', () => {
    expect(successDeltaGate(0.903, 10_000, 0.9, 10_000).meaningful).toBe(false);
  });

  it('enters each side path count into its own variance term', () => {
    const p1 = 0.9;
    const p2 = 0.5;
    const se = successDeltaGate(p1, 1_000, p2, 4_000).se;
    expect(se).toBeCloseTo(Math.sqrt((p1 * (1 - p1)) / 1_000 + (p2 * (1 - p2)) / 4_000), 12);
    // Swapping the counts must change the value (a transposed n would not).
    expect(successDeltaGate(p1, 4_000, p2, 1_000).se).not.toBeCloseTo(se, 6);
  });

  it('has no noise when both sides sit at 0 or 1: any delta is signal, zero is not', () => {
    const same = successDeltaGate(1, 10_000, 1, 10_000);
    expect(same.se).toBe(0);
    expect(same.meaningful).toBe(false);
    const apart = successDeltaGate(1, 10_000, 0, 10_000);
    expect(apart.se).toBe(0);
    expect(apart.meaningful).toBe(true);
  });
});
