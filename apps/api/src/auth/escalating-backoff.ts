// Pure escalating-delay derivation shared by the password backoff (`failed-login.service.ts`) and the per-account TOTP lock (`MfaService`),
// kept dependency-free so neither control couples to the other.

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
 * Derives the window state from a running failure count and the latest failure timestamp, never a stored raceable
 * "next attempt after". A missing or unparseable timestamp fails open: the count alone cannot lock an account with no
 * recorded failure.
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
