// Shared client retry policy: full-jitter delay, `Retry-After` parsing and the rule that a served wait wins. `POST /auth/refresh` keeps its own cooldown.

const RETRY_BASE_MS = 15_000;

/** Cap on every computed delay, and the cutoff above which a served `Retry-After` is ignored. */
export const RETRY_CAP_MS = 120_000;

const RETRY_AFTER_JITTER_RATIO = 0.2;

// Floors a served `Retry-After: 0` (a real zero, not null) so a fleet does not enter an immediate-retry loop against a server that asked to be left alone.
const RETRY_AFTER_FLOOR_MS = 1_000;

/** Full-jitter delay `random() × min(cap, base × 2^attempt)` for a zero-based attempt. */
function nextRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
  return Math.random() * ceiling;
}

/** Parses `Retry-After` (delta-seconds or HTTP-date); absent or unparseable is `null`, distinct from the zero a past date gives, which the busy predicate branches on. */
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

/** A served wait at or under the cap wins, plus up to 20% jitter so a fleet served the same value does not re-synchronize; above the cap or `null`, the computed delay applies. */
export function resolveRetryDelayMs(attempt: number, servedMs: number | null): number {
  const computed = nextRetryDelayMs(attempt);
  if (servedMs === null || servedMs > RETRY_CAP_MS) return computed;
  const honored = Math.max(servedMs, RETRY_AFTER_FLOOR_MS);
  return honored + Math.random() * RETRY_AFTER_JITTER_RATIO * honored;
}
