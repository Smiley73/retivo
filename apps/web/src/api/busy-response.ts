// "The service is busy" predicate and copy for the auth-screen submit paths.
// Needs an `apiRequest` no-envelope sentinel, so an enveloped `429 LOGIN_BACKOFF` keeps its own message.
import { ApiRequestError } from './client';

/** Exact copy — do not reword or vary it per screen. */
export const BUSY_MESSAGE = 'The service is busy right now. Please try again in a moment.';

const NO_ENVELOPE_CODES = new Set(['UNKNOWN_ERROR', 'INVALID_RESPONSE']);

/**
 * True for a no-envelope failure (gateway throttle or timeout): status >= 500, or 429 with no parsed `Retry-After`.
 * Typed `boolean`, not a type predicate: callers already narrow with `instanceof`, and a predicate would narrow the
 * `false` branch to `never`.
 */
export function isBusyResponse(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  if (!NO_ENVELOPE_CODES.has(err.error.code)) return false;
  if (err.status >= 500) return true;
  return err.status === 429 && err.retryAfterMs == null;
}
