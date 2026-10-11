/**
 * Shared client-side retry/backoff policy.
 * Every piece of arithmetic a client-side retry decision needs — the
 * full-jitter delay curve, the `Retry-After` parse, and the override rule
 * that lets a server-requested wait win over the computed one — lives here
 * and nowhere else. No React, no `fetch`: pure functions, unit-testable
 * without a DOM.
 *
 * Consumers: the sync loop's error-state scheduler (`SyncContext.tsx`), the
 * account-export page-fetch retry (`account-export-client.ts`), and both
 * client error types that carry a parsed `Retry-After`
 * (`ApiRequestError` in `api/client.ts`, `SyncApiError` in
 * `sync/sync-client.ts`).
 *
 * `POST /auth/refresh` is explicitly OUT of scope for all of this:
 * it keeps its own single-attempt, non-retried cooldown, untouched.
 */

/** Base delay for the first consecutive error (attempt 0), in ms. */
export const RETRY_BASE_MS = 15_000;

/** Ceiling every computed delay is capped at, in ms (2 minutes). Also the
 *  cutoff for the `Retry-After` override rule below. */
export const RETRY_CAP_MS = 120_000;

/** Extra jitter (as a fraction of the served value) added on top of an
 *  honored `Retry-After`, so a fleet of tabs all served the identical
 *  wait don't re-synchronize on it. Module-private — `resolveRetryDelayMs`
 *  is the only consumer of the raw ratio; everything else just calls it. */
const RETRY_AFTER_JITTER_RATIO = 0.2;

/**
 * Floor applied to an honored `Retry-After` before jittering it. `retryAfterMs`
 * (below) deliberately parses `Retry-After: 0` and a past HTTP-date to a REAL
 * zero-length wait rather than `null` (callers need that
 * distinction). Honoring a zero verbatim would schedule the next attempt on
 * the very next macrotask — an ordinary client clock a few seconds ahead of
 * the server (or any intermediary that itself emits `Retry-After: 0`) turns
 * an every-poll 429 into an unbounded immediate-retry loop against a server
 * that just asked to be left alone, exactly the load this policy exists
 * to relieve. A small floor keeps the override rule meaningful without
 * masking the true zero-vs-null distinction anywhere it is parsed or stored.
 */
const RETRY_AFTER_FLOOR_MS = 1_000;

/**
 * Full-jitter delay for the given zero-based consecutive-error attempt
 * number: `random() × min(cap, base × 2^attempt)`. This is the
 * AWS-recommended "full jitter" shape for de-synchronizing a fleet of
 * independent clients — not decorrelated jitter, not a fixed multiplier
 * (owner's settled choice). Attempt 0 (the first error) draws from
 * `uniform(0, 15s)` — mean 7.5 s, routinely SHORTER than a flat 30 s
 * retry. That is intentional: the goal is spreading retries apart, not
 * making any one of them slower.
 */
export function nextRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
  return Math.random() * ceiling;
}

/**
 * Parse a `Retry-After` response header: either delta-seconds (`"30"`) or
 * an HTTP-date. Returns `null` for an absent or unparseable header — a
 * distinct "no value" outcome from the zero-length wait a past date or a
 * non-positive delta produces. The "busy" predicate branches
 * on exactly that difference, so the two must never be conflated.
 */
export function retryAfterMs(
  headers: { get(name: string): string | null } | null | undefined,
): number | null {
  const raw = headers?.get('Retry-After');
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number(trimmed)) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - Date.now());
}

/**
 * The override rule: a served `Retry-After` at or under the cap wins over
 * the computed delay (plus up to 20% jitter, so a fleet all served the
 * same value doesn't re-synchronize on it); above the cap it is ignored
 * and the computed delay applies unchanged. Pass `null` for "no served
 * value" (absent or unparseable header) to always get the computed delay.
 */
export function resolveRetryDelayMs(attempt: number, servedMs: number | null): number {
  const computed = nextRetryDelayMs(attempt);
  if (servedMs === null || servedMs > RETRY_CAP_MS) return computed;
  // Floor a real-but-non-positive served wait (see RETRY_AFTER_FLOOR_MS)
  // before jittering — a served value already at/above the floor is
  // honored exactly as before, byte-unchanged.
  const honored = Math.max(servedMs, RETRY_AFTER_FLOOR_MS);
  return honored + Math.random() * RETRY_AFTER_JITTER_RATIO * honored;
}
