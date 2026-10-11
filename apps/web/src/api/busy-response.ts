/**
 * Shared "the service is busy" predicate + copy for the seven auth-screen
 * submit paths: sign-in (password,
 * passkey), the MFA challenge step (code, passkey), sign-up account
 * creation, and both password-reset requests.
 *
 * `apps/api/src`'s `HttpErrorFilter` is the only writer of a real error
 * envelope (`{ error: { code, message, traceId } }`), so a response with no
 * envelope — a gateway-level throttle or timeout answered by API Gateway or
 * CloudFront in front of the app — is identifiable without re-parsing the
 * body: `apiRequest` (`./client.ts`) already classifies exactly those two
 * shapes into two sentinel codes, `INVALID_RESPONSE` for a non-JSON
 * content-type and `UNKNOWN_ERROR` for JSON with no `error` key. Both
 * branches below require one of those sentinels — including the `429`
 * branch, which is what keeps `login.service.ts`'s enveloped
 * `429 LOGIN_BACKOFF` (its own "Try again in N seconds…"
 * sentence, served with no `Retry-After` header) from being silently
 * replaced by this generic copy.
 */
import { ApiRequestError } from './client';

/** Exact copy — do not reword or vary it per screen. */
export const BUSY_MESSAGE = 'The service is busy right now. Please try again in a moment.';

/** The two no-envelope sentinels `apiRequest` produces (see module docs). */
const NO_ENVELOPE_CODES = new Set(['UNKNOWN_ERROR', 'INVALID_RESPONSE']);

/**
 * True when `err` is the shape a Lambda-throttle failure actually produces:
 * an `ApiRequestError` with no error envelope, and either a `status >= 500`
 * or a `status === 429` with no `retryAfterMs` parsed onto it (the header
 * parse on `ApiRequestError`).
 * Every enveloped error — including `LOGIN_BACKOFF`, every other
 * code-specific branch, and a `429` that DID carry a parsed `Retry-After`
 * (that wait belongs to the shared notice, not here) — and every
 * non-`ApiRequestError` throw returns `false`.
 *
 * Deliberately typed as a plain `boolean`, not a `err is ApiRequestError`
 * type predicate: every call site first narrows with its own
 * `err instanceof ApiRequestError` (the code-specific branches beside it need
 * that narrowing regardless), and a predicate re-asserting the SAME type
 * narrows the `false` branch to `never` there — TS has nothing left to
 * exclude.
 */
export function isBusyResponse(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  if (!NO_ENVELOPE_CODES.has(err.error.code)) return false;
  if (err.status >= 500) return true;
  return err.status === 429 && err.retryAfterMs == null;
}
