/**
 * Single entry point for talking to the API.
 *
 * Responsibilities:
 * - Attach the access token automatically for authenticated calls.
 * - Transparent refresh-and-retry once on 401 - pairs with the rotating
 *   refresh flow ("Sessions" in docs/security.md).
 * - Normalize responses: 204 -> undefined, non-2xx -> ApiRequestError with
 *   the server's envelope.
 * - Enforce request timeouts so hung servers don't leave requests pending.
 *
 * Tokens live in the AuthContext (in-memory). This module holds thin
 * getter/refresher function references so React can own state while this
 * plain module stays framework-free.
 */
import { API_BASE_URL } from '../lib/api-base-url';
import { recordServerBuildId } from '../lib/build-id';
import { retryAfterMs } from '../lib/retry-backoff';
import { raiseWaitNotice } from '../lib/toast-queue';

const REQUEST_TIMEOUT_MS = 10_000;

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public error: ApiError,
    /** Parsed `Retry-After` from the response, in ms — `null`/undefined
     *  when the header was absent or unparseable, distinct from a real zero-length wait (see
     *  `retryAfterMs` in `lib/retry-backoff.ts`). */
    public retryAfterMs?: number | null,
  ) {
    super(error.message);
  }
}

export type TokenGetter = () => string | null;
export type TokenRefresher = () => Promise<string | null>;

let getAccessToken: TokenGetter = () => null;
let refreshAccessToken: TokenRefresher = async () => null;

export function configureApi(opts: {
  getAccessToken: TokenGetter;
  refreshAccessToken: TokenRefresher;
}) {
  getAccessToken = opts.getAccessToken;
  refreshAccessToken = opts.refreshAccessToken;
}

/** Exposed for SyncProvider so the sync transport attaches the bearer. */
export function getCurrentAccessToken(): string | null {
  return getAccessToken();
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  /** Set to `false` for public endpoints (login/refresh/logout). Defaults to `true`. */
  auth?: boolean;
  signal?: AbortSignal;
  /**
   * Set to `false` to skip the automatic refresh-and-retry on a 401 for this
   * call. For callers (e.g. `signOutForDeviceClear`)
   * that need to drive their own refresh classification (definitive vs.
   * transient) instead of having this module silently refresh out from under
   * them — refreshing here would both duplicate the caller's own refresh call
   * and let a non-definitive verdict from the hidden refresh mask a definitive
   * one the caller determines afterward. Defaults to `true`.
   */
  retryOn401?: boolean;
  /**
   * Set to `false` to suppress the shared "Please wait N seconds before
   * trying again." notice even when the
   * response carries a `Retry-After` this call would otherwise raise it
   * for. The ONLY caller that sets this is `POST /auth/refresh`
   * (`AuthContext.tsx`) — this is absolute: no backoff, wait, or busy
   * surface added at this shared seam applies to the refresh call. Defaults
   * to `true`.
   */
  raiseWaitNotice?: boolean;
}

const CSRF_STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Read the non-HttpOnly csrf-token cookie set by the API on login/refresh. */
function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|; )csrf-token=([^;]*)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Peek a 401 response (via a clone, so the body stays readable for the caller)
 * and report whether it is a deliberate `INVALID_CREDENTIALS` failure rather
 * than an expired access token. Used to suppress the refresh-and-retry for
 * credential-validation endpoints (e.g. verify-password). Any parse failure is
 * treated as "not invalid-credentials" so the normal retry path is preserved.
 */
async function isInvalidCredentials(res: Response): Promise<boolean> {
  try {
    const json = (await res.clone().json()) as { error?: { code?: unknown } };
    return json?.error?.code === 'INVALID_CREDENTIALS';
  } catch {
    return false;
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  {
    method = 'GET',
    body,
    auth = true,
    signal: externalSignal,
    retryOn401 = true,
    raiseWaitNotice: shouldRaiseWaitNotice = true,
  }: RequestOpts = {},
): Promise<T> {
  const doFetch = async (token: string | null, signal: AbortSignal): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    // Echo the CSRF token on state-changing requests so the server middleware
    // can verify it (double-submit cookie pattern).
    if (CSRF_STATE_METHODS.has(method.toUpperCase())) {
      const csrfToken = readCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    return fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'include',
    });
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // If an external signal is provided, forward its abort to our controller.
  externalSignal?.addEventListener('abort', () => controller.abort());

  try {
    let res = await doFetch(auth ? getAccessToken() : null, controller.signal);

    // Retry once on 401: the access token may have expired. But a 401 carrying
    // `code: 'INVALID_CREDENTIALS'` is a deliberate credential-validation
    // failure (e.g. verify-password), NOT an expired access token — refreshing
    // and retrying would re-run the endpoint, double-recording its audit event
    // and consuming a second throttle slot. Peek a clone's body and skip the
    // retry in that case.
    if (res.status === 401 && auth && retryOn401 && !(await isInvalidCredentials(res))) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        res = await doFetch(newToken, controller.signal);
      }
    }

    // Surface the server's build id to the version detector. Cheap
    // header read; lets us notice a fresh deploy without polling.
    recordServerBuildId(res.headers.get('X-Build-Id'));
    // Parse `Retry-After` right beside it —
    // both throw sites below carry it on the error they already throw.
    const parsedRetryAfterMs = retryAfterMs(res.headers);
    // Raise the shared "please wait" notice right where the header is
    // read — this is the one seam every screen group funnels through, so
    // "no screen group dropped" is structural rather than a per-page
    // checklist. Only a throttling `429` raises it: an enveloped `5xx`
    // raises nothing, and a `503` CAN carry `Retry-After` (the S3-bootstrap
    // path, "429 or 503 + Retry-After" backpressure) — that is a failed
    // request, not a wait, and the inline busy copy owns it.
    // `raiseWaitNotice` itself drops a non-positive wait; the only opt-out
    // is `POST /auth/refresh`.
    if (shouldRaiseWaitNotice && res.status === 429 && parsedRetryAfterMs !== null) {
      raiseWaitNotice(parsedRetryAfterMs);
    }

    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get('content-type');
    const bodyText = await res.text();

    // Any 2xx with empty body: 200 → null, everything else (202, etc.) → undefined.
    if (res.ok && bodyText.length === 0) return (res.status === 200 ? null : undefined) as T;

    if (!contentType?.includes('application/json')) {
      throw new ApiRequestError(
        res.status,
        {
          code: 'INVALID_RESPONSE',
          message: `Expected JSON response but received ${contentType ?? 'unknown'}`,
        },
        parsedRetryAfterMs,
      );
    }

    const json = JSON.parse(bodyText);

    if (!res.ok) {
      const err = (json?.error as ApiError) ?? {
        code: 'UNKNOWN_ERROR',
        message: res.statusText,
      };
      throw new ApiRequestError(res.status, err, parsedRetryAfterMs);
    }
    return json as T;
  } finally {
    clearTimeout(timeoutId);
  }
}
