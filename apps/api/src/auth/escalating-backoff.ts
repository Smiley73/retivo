/**
 * Pure escalating-delay-from-a-running-count derivation.
 * `FailedLoginService`'s password backoff (`failed-login.service.ts`) uses this
 * exact growth shape today; the per-account TOTP lock (`MfaService`) reuses it
 * so the two behave alike without importing it OUT of `FailedLoginService`,
 * which would couple the two controls. Lifted here instead as a small,
 * dependency-free module.
 *
 * The first `graceFailures` misses are free (delay 0); from there the wait
 * grows `2^1, 2^2, ...` seconds, held at `2^maxExponent`.
 */

export interface EscalatingBackoffParams {
  /** Free misses before any wait applies. */
  graceFailures: number;
  /** The delay is held at `2^maxExponent` seconds past this many misses. */
  maxExponent: number;
}

/** The delay (seconds) a given running miss count earns under `params`. */
export function escalatingBackoffDelaySec(
  failureCount: number,
  params: EscalatingBackoffParams,
): number {
  const exponent = Math.min(
    Math.max(failureCount - params.graceFailures, 0),
    params.maxExponent,
  );
  return exponent === 0 ? 0 : 2 ** exponent;
}

export interface EscalatingBackoffState {
  /** True if the caller must wait — within the window. */
  blocked: boolean;
  /** Seconds until the next attempt is allowed. Zero when not blocked. */
  retryAfterSec: number;
}

/**
 * Derive the current window state from a running failure count + the ISO
 * timestamp of the latest failure — never a separately stored/raced "next
 * attempt after" value (mirrors `FailedLoginService.checkBackoff`'s
 * reasoning). A missing/unparseable timestamp fails open (not blocked): the
 * count alone can never lock an account with no recorded failure time.
 */
export function escalatingBackoffState(
  failureCount: number,
  lastFailureAtIso: string | undefined,
  params: EscalatingBackoffParams,
): EscalatingBackoffState {
  const delaySec = escalatingBackoffDelaySec(failureCount, params);
  if (delaySec === 0 || !lastFailureAtIso) return { blocked: false, retryAfterSec: 0 };
  const lastMs = Date.parse(lastFailureAtIso);
  if (!Number.isFinite(lastMs)) return { blocked: false, retryAfterSec: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const windowEndSec = Math.floor(lastMs / 1000) + delaySec;
  const retryAfterSec = windowEndSec - nowSec;
  return retryAfterSec > 0
    ? { blocked: true, retryAfterSec }
    : { blocked: false, retryAfterSec: 0 };
}
