// Shared client retry policy: the full-jitter delay curve, the `Retry-After`
// parse and the rule that lets a served wait win. `POST /auth/refresh` keeps its own cooldown.

export const RETRY_BASE_MS = 15_000;

/** Cap on every computed delay, and the cutoff above which a served `Retry-After` is ignored. */
export const RETRY_CAP_MS = 120_000;

const RETRY_AFTER_JITTER_RATIO = 0.2;

// Floors a served `Retry-After: 0` (which `retryAfterMs` parses to a real zero, not
// null) so a fleet does not enter an immediate-retry loop against a server that asked to be left alone.
const RETRY_AFTER_FLOOR_MS = 1_000;

/**
 * Full-jitter delay `random() × min(cap, base × 2^attempt)` for a zero-based
 * attempt. It spreads retries apart, so attempt 0 is often shorter than a flat wait.
 */
export function nextRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
  return Math.random() * ceiling;
}

/**
 * Parses `Retry-After` (delta-seconds or HTTP-date). Absent or unparseable is
 * `null`, distinct from the zero a past date or non-positive delta gives: the
 * busy predicate branches on that difference.
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
 * A served wait at or under the cap wins over the computed delay, plus up to 20%
 * jitter so a fleet served the same value does not re-synchronize. Above the
 * cap, or `null`, the computed delay applies.
 */
export function resolveRetryDelayMs(attempt: number, servedMs: number | null): number {
  const computed = nextRetryDelayMs(attempt);
  if (servedMs === null || servedMs > RETRY_CAP_MS) return computed;
  const honored = Math.max(servedMs, RETRY_AFTER_FLOOR_MS);
  return honored + Math.random() * RETRY_AFTER_JITTER_RATIO * honored;
}
