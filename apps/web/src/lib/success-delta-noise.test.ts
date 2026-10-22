import { describe, expect, it } from 'vitest';
import { successDeltaGate, successDeltaVerdict } from './success-delta-noise';

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

describe('successDeltaVerdict', () => {
  const at = (probability: number, pathCount = 10_000) => ({ probability, pathCount });

  it('reads 0.900 vs 0.903 at 10,000 paths as noise and 0.90 vs 0.80 as signal', () => {
    expect(successDeltaVerdict(at(0.9), at(0.903))).toMatchObject({ kind: 'same', reason: 'noise' });
    expect(successDeltaVerdict(at(0.9), at(0.8))).toMatchObject({ kind: 'signal', points: 10 });
  });

  it('is strict at the boundary: |delta| equal to se is the same, just above is signal', () => {
    // 0.5 vs 1 at one path each: se = sqrt(0.25) = 0.5 exactly, |delta| = 0.5.
    const boundary = successDeltaGate(0.5, 1, 1, 1);
    expect(Math.abs(boundary.delta)).toBe(boundary.se);
    expect(successDeltaVerdict(at(0.5, 1), at(1, 1))).toEqual({
      kind: 'same',
      reason: 'noise',
      se: 0.5,
    });
    // Moving the first side away from the second raises |delta| past se.
    expect(successDeltaVerdict(at(0.49, 1), at(1, 1))?.kind).toBe('signal');
  });

  it('reads a signal-sized delta that rounds to 0 points as the same, for either sign', () => {
    // A billion paths each: se is about 1e-5, so a 0.4-point gap is signal.
    const big = 1_000_000_000;
    expect(successDeltaGate(0.9, big, 0.896, big).meaningful).toBe(true);
    for (const [a, b] of [
      [0.9, 0.896],
      [0.896, 0.9],
    ]) {
      expect(successDeltaVerdict(at(a!, big), at(b!, big))).toMatchObject({
        kind: 'same',
        reason: 'rounds-to-zero',
      });
    }
  });

  it('carries the sign and the whole-point magnitude of first minus second', () => {
    expect(successDeltaVerdict(at(0.92), at(0.85))).toMatchObject({ kind: 'signal', points: 7 });
    expect(successDeltaVerdict(at(0.85), at(0.92))).toMatchObject({ kind: 'signal', points: -7 });
  });

  it('is null when either side is missing', () => {
    expect(successDeltaVerdict(null, at(0.9))).toBeNull();
    expect(successDeltaVerdict(at(0.9), null)).toBeNull();
  });
});
