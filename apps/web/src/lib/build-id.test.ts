/**
 * Unit tests for the build-id detector that powers the version banner.
 * Pure module — no React, no fetch — so we can drive it directly and
 * assert the listener semantics + verification gate + sessionStorage
 * interaction. The bundle-live verifier is stubbed via
 * `__setVerifierForTest`; the real `defaultVerifier` is exercised via
 * the existing fetch-based integration in api/client.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBuildIdState,
  __resetVerifyThrottleForTest,
  __setClientBuildIdForTest,
  __setVerifierForTest,
  type BundleVerifier,
  dismissCurrentMismatch,
  getCurrentMismatch,
  isMismatch,
  recordSchemaAhead,
  recordServerBuildId,
  subscribeToVersionMismatch,
} from './build-id';

/** Flush microtasks so the verifier promise + its `.then`/`finally`
 *  callbacks resolve before assertions run. Two ticks because the
 *  result handling sits inside the async function after `await`. */
async function flushVerification(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function liveVerifier(): BundleVerifier {
  return vi.fn(async () => 'live' as const);
}

function oldVerifier(): BundleVerifier {
  return vi.fn(async () => 'old' as const);
}

function unknownVerifier(): BundleVerifier {
  return vi.fn(async () => 'unknown' as const);
}

describe('isMismatch', () => {
  it('returns false when ids match', () => {
    expect(isMismatch('abc', 'abc')).toBe(false);
  });

  it('returns false when the server id is missing', () => {
    expect(isMismatch('abc', null)).toBe(false);
    expect(isMismatch('abc', undefined)).toBe(false);
    expect(isMismatch('abc', '')).toBe(false);
  });

  it('returns false when either side is the dev sentinel', () => {
    expect(isMismatch('dev', 'abc')).toBe(false);
    expect(isMismatch('abc', 'dev')).toBe(false);
  });

  it('returns true on a real mismatch', () => {
    expect(isMismatch('abc', 'def')).toBe(true);
  });
});

describe('recordServerBuildId', () => {
  beforeEach(() => {
    __resetBuildIdState();
    __setClientBuildIdForTest('client-build-1');
  });

  it('keeps the detector idle while the server id matches', async () => {
    const verifier = liveVerifier();
    __setVerifierForTest(verifier);
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('client-build-1');
    await flushVerification();
    expect(verifier).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('does not raise a mismatch under the dev sentinel', async () => {
    __setClientBuildIdForTest('dev');
    const verifier = liveVerifier();
    __setVerifierForTest(verifier);
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('some-real-build-id');
    await flushVerification();
    expect(verifier).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('notifies subscribers once verification confirms the bundle is live', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    // Verification is async — listener has not fired yet.
    expect(listener).not.toHaveBeenCalled();
    await flushVerification();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-2',
      reason: 'build-mismatch',
    });
    expect(getCurrentMismatch()).toEqual({
      buildId: 'server-build-2',
      reason: 'build-mismatch',
    });
  });

  it('stays quiet when the deployed bundle is still the client build', async () => {
    __setVerifierForTest(oldVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('stays quiet when verification fails or returns an unexpected id', async () => {
    __setVerifierForTest(unknownVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('emits on a later record once CF catches up', async () => {
    let phase: 'old' | 'live' = 'old';
    const verifier: BundleVerifier = vi.fn(async () => phase);
    __setVerifierForTest(verifier);
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);

    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();

    phase = 'live';
    __resetVerifyThrottleForTest();
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-2',
      reason: 'build-mismatch',
    });
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it('does not re-notify for the same mismatched id', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    recordServerBuildId('server-build-2');
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('throttles back-to-back verifications within the cooldown window', async () => {
    const verifier = oldVerifier();
    __setVerifierForTest(verifier);
    recordServerBuildId('server-build-2');
    await flushVerification();
    recordServerBuildId('server-build-2');
    await flushVerification();
    recordServerBuildId('server-build-3');
    await flushVerification();
    // Verifier ran once for the first record; the duplicate call and
    // the newer-id call both arrive inside the throttle window so
    // `runVerification` returns before invoking the stub.
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(getCurrentMismatch()).toBeNull();
  });

  it('notifies again when a newer server build is verified live', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    __resetVerifyThrottleForTest();
    recordServerBuildId('server-build-3');
    await flushVerification();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getCurrentMismatch()).toEqual({
      buildId: 'server-build-3',
      reason: 'build-mismatch',
    });
  });

  it('skips a build the user already dismissed in this session', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    dismissCurrentMismatch();
    listener.mockClear();
    __resetVerifyThrottleForTest();
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('still surfaces a brand new build after a prior dismiss', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    dismissCurrentMismatch();
    listener.mockClear();
    __resetVerifyThrottleForTest();
    recordServerBuildId('server-build-3');
    await flushVerification();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-3',
      reason: 'build-mismatch',
    });
  });
});

describe('dismissCurrentMismatch', () => {
  beforeEach(() => {
    __resetBuildIdState();
    __setClientBuildIdForTest('client-build-1');
  });

  it('clears state and notifies listeners with null', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    listener.mockClear();
    dismissCurrentMismatch();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
    expect(getCurrentMismatch()).toBeNull();
  });

  it('is a no-op when no mismatch is active', () => {
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    dismissCurrentMismatch();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('recordSchemaAhead', () => {
  beforeEach(() => {
    __resetBuildIdState();
    __setClientBuildIdForTest('client-build-1');
  });

  it('surfaces the banner using the most recent server build id', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    // Capture a server id without raising the banner (matches client).
    recordServerBuildId('client-build-1');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
    // Then a different id arrives via the same channel — captured but
    // banner stays quiet because verification path reaches via mismatch.
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-2',
      reason: 'build-mismatch',
    });
    listener.mockClear();
    // Schema-ahead while already-prompted should be a no-op.
    __resetVerifyThrottleForTest();
    recordSchemaAhead();
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
  });

  it('forces the banner past a prior user-dismissal, tagged with reason "schema-ahead"', async () => {
    __setVerifierForTest(liveVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-2');
    await flushVerification();
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-2',
      reason: 'build-mismatch',
    });
    dismissCurrentMismatch();
    listener.mockClear();
    // Without recordSchemaAhead, the dismissed id stays suppressed even
    // if the same id is observed again. Schema-ahead is a stronger signal
    // (the bundle truly cannot read the data) so dismissal must be cleared
    // — and the re-armed mismatch is tagged with the stronger reason.
    __resetVerifyThrottleForTest();
    recordSchemaAhead();
    await flushVerification();
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-2',
      reason: 'schema-ahead',
    });
  });

  it('tags a fresh schema-ahead mismatch with reason "schema-ahead" (no prior verified build-mismatch banner)', async () => {
    // The initial build-mismatch verification never resolves 'live' (CF
    // hasn't caught up), so no banner has surfaced yet for this id.
    __setVerifierForTest(oldVerifier());
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordServerBuildId('server-build-9');
    await flushVerification();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
    // Schema-ahead re-triggers verification for the same id; this time it
    // verifies live, and the surfaced mismatch is tagged 'schema-ahead'.
    __setVerifierForTest(liveVerifier());
    __resetVerifyThrottleForTest();
    recordSchemaAhead();
    await flushVerification();
    expect(listener).toHaveBeenCalledWith({
      buildId: 'server-build-9',
      reason: 'schema-ahead',
    });
    expect(getCurrentMismatch()).toEqual({
      buildId: 'server-build-9',
      reason: 'schema-ahead',
    });
  });

  it('logs and bails when no server build id has been observed yet', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn();
    subscribeToVersionMismatch(listener);
    recordSchemaAhead();
    await flushVerification();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
