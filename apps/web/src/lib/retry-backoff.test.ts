import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryAfterMs, resolveRetryDelayMs, RETRY_CAP_MS } from './retry-backoff';

const BASE_MS = 15_000;
const computedDelay = (attempt: number): number => resolveRetryDelayMs(attempt, null);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computed retry delay (no served wait)', () => {
  it('is actually random: repeated draws at one attempt spread across the interval', () => {
    // A bounds-only assertion passes against a fixed delay; assert the draws vary and spread over the interval, since de-synchronizing tabs is the point.
    const draws = Array.from({ length: 200 }, () => computedDelay(0));
    const distinctValues = new Set(draws).size;
    expect(distinctValues).toBeGreaterThan(100);
    expect(Math.min(...draws)).toBeLessThan(BASE_MS * 0.25);
    expect(Math.max(...draws)).toBeGreaterThan(BASE_MS * 0.75);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(BASE_MS);
    }
  });

  it('doubles the ceiling per consecutive attempt and stops at the 2-minute cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // pin every draw to its ceiling
    expect(computedDelay(0)).toBe(15_000);
    expect(computedDelay(1)).toBe(30_000);
    expect(computedDelay(2)).toBe(60_000);
    expect(computedDelay(3)).toBe(120_000);
    expect(computedDelay(4)).toBe(RETRY_CAP_MS);
    expect(computedDelay(10)).toBe(RETRY_CAP_MS);
  });

  it('never returns a negative attempt-0 ceiling for a negative attempt number', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(computedDelay(-1)).toBe(BASE_MS);
  });
});

describe('retryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(retryAfterMs({ get: () => '30' })).toBe(30_000);
  });

  it('parses an HTTP-date in the future', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const ms = retryAfterMs({ get: () => future });
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(40_000);
    expect(ms!).toBeLessThanOrEqual(45_100);
  });

  it('a past HTTP-date yields a real zero-length wait, not "no value"', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs({ get: () => past })).toBe(0);
  });

  it('a non-positive delta-seconds value yields a real zero-length wait', () => {
    expect(retryAfterMs({ get: () => '0' })).toBe(0);
  });

  it('a malformed header is distinguishable from a zero-wait: returns null', () => {
    expect(retryAfterMs({ get: () => 'not-a-valid-header' })).toBeNull();
  });

  it('an absent header is distinguishable from a zero-wait: returns null', () => {
    expect(retryAfterMs({ get: () => null })).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe('resolveRetryDelayMs', () => {
  it('a served value under the cap overrides the computed delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // no extra jitter
    expect(resolveRetryDelayMs(0, 5_000)).toBe(5_000);
  });

  it('a served value at exactly the cap overrides the computed delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(resolveRetryDelayMs(0, RETRY_CAP_MS)).toBe(RETRY_CAP_MS);
  });

  it('a served value above the cap is ignored — the computed delay applies', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(resolveRetryDelayMs(1, RETRY_CAP_MS + 1)).toBe(30_000);
  });

  it('adds up to 20% jitter on top of an honored served value', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // maximum jitter
    expect(resolveRetryDelayMs(0, 10_000)).toBe(12_000);
  });

  // A served Retry-After of 0 (or a past HTTP-date) must not resolve to a 0ms delay: that would be an unbounded hot loop against a server that asked for a wait.
  it('floors a served zero-length wait to a real, non-trivial delay instead of 0ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // no extra jitter
    expect(resolveRetryDelayMs(0, 0)).toBeGreaterThan(0);
    expect(resolveRetryDelayMs(0, 0)).toBe(1_000); // the floor, unjittered
  });

  it('still applies jitter on top of the floored zero-length wait', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // maximum jitter
    expect(resolveRetryDelayMs(0, 0)).toBe(1_200); // 1_000 + 1 × 0.2 × 1_000
  });

  it('a served value already at or above the floor is unaffected by it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(resolveRetryDelayMs(0, 1_000)).toBe(1_000);
  });
});
