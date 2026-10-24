// Single entry point for API calls: bearer token, one refresh-and-retry on 401, normalised responses, timeouts.
// Tokens live in AuthContext; this module holds getter/refresher references so it stays framework-free.
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
    /** Parsed `Retry-After` in ms; `null`/undefined when absent or unparseable, distinct from a zero-length wait. */
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

/** Current bearer token, for the sync transport. */
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
   * `false` skips the 401 refresh-and-retry, for callers that classify their own refresh (e.g.
   * `signOutForDeviceClear`). Defaults to `true`.
   */
  retryOn401?: boolean;
  /** `false` suppresses the shared wait notice; only `POST /auth/refresh` sets it. Defaults to `true`. */
  raiseWaitNotice?: boolean;
}

const CSRF_STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|; )csrf-token=([^;]*)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

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
    // Echo the CSRF cookie (AGENTS.md "Project-specific security").
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

  externalSignal?.addEventListener('abort', () => controller.abort());

  try {
    let res = await doFetch(auth ? getAccessToken() : null, controller.signal);

    // A 401 `INVALID_CREDENTIALS` is a deliberate failure (e.g. verify-password), not an expired token:
    // retrying would re-run the endpoint, double-recording its audit event and spending a second throttle slot.
    if (res.status === 401 && auth && retryOn401 && !(await isInvalidCredentials(res))) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        res = await doFetch(newToken, controller.signal);
      }
    }

    recordServerBuildId(res.headers.get('X-Build-Id'));
    const parsedRetryAfterMs = retryAfterMs(res.headers);
    // Only a throttling 429 raises the wait notice; a 503 `Retry-After` is a failed request the inline busy copy owns.
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
