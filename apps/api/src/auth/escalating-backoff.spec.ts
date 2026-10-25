// The pure escalating-delay derivation from a running count, shared by the per-account TOTP lock (MfaService) and, in shape, FailedLoginService's password backoff.
import {
  escalatingBackoffDelaySec,
  escalatingBackoffState,
  type EscalatingBackoffParams,
} from './escalating-backoff.js';

const PARAMS: EscalatingBackoffParams = { graceFailures: 3, maxExponent: 6 };

describe('escalatingBackoffDelaySec', () => {
  it('is free for the grace-window failures', () => {
    expect(escalatingBackoffDelaySec(0, PARAMS)).toBe(0);
    expect(escalatingBackoffDelaySec(3, PARAMS)).toBe(0);
  });

  it('grows 2^1 ... 2^maxExponent past the grace window', () => {
    expect(escalatingBackoffDelaySec(4, PARAMS)).toBe(2);
    expect(escalatingBackoffDelaySec(5, PARAMS)).toBe(4);
    expect(escalatingBackoffDelaySec(9, PARAMS)).toBe(64);
  });

  it('holds at 2^maxExponent past the cap', () => {
    expect(escalatingBackoffDelaySec(100, PARAMS)).toBe(64);
  });
});

describe('escalatingBackoffState', () => {
  it('is not blocked when the delay is free', () => {
    expect(escalatingBackoffState(3, new Date().toISOString(), PARAMS)).toEqual({
      blocked: false,
      retryAfterSec: 0,
    });
  });

  it('is blocked immediately after a failure that earns a delay', () => {
    const state = escalatingBackoffState(4, new Date().toISOString(), PARAMS);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeLessThanOrEqual(2);
  });

  it('is not blocked once the window has elapsed (an aged last-failure timestamp)', () => {
    const longAgo = new Date(Date.now() - 120_000).toISOString();
    expect(escalatingBackoffState(4, longAgo, PARAMS)).toEqual({
      blocked: false,
      retryAfterSec: 0,
    });
  });

  it('fails open (not blocked) on a missing last-failure timestamp', () => {
    expect(escalatingBackoffState(9, undefined, PARAMS)).toEqual({
      blocked: false,
      retryAfterSec: 0,
    });
  });

  it('fails open (not blocked) on an unparseable last-failure timestamp', () => {
    expect(escalatingBackoffState(9, 'not-a-date', PARAMS)).toEqual({
      blocked: false,
      retryAfterSec: 0,
    });
  });
});
