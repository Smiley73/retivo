// Account half of "Export my data" (`GET /auth/account-export`). It sends the access token
// once and never refreshes or replays: the export cookie is bound to that token's `jti`.

import { retryAfterMs, RETRY_CAP_MS } from './retry-backoff.js';
import { raiseWaitNotice } from './toast-queue.js';

const MAX_ACCOUNT_EXPORT_PAGES = 10_000;

// Covers the body read too: a stalled connection would otherwise leave the UI busy forever.
const PAGE_FETCH_TIMEOUT_MS = 30_000;

// A 429 retries with capped exponential backoff (the route throttles at 120
// requests/minute); a served `Retry-After` at or under the shared cap wins.
// Any other non-2xx status is terminal.
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_RETRY_BASE_MS = 1_000;
const RATE_LIMIT_RETRY_MAX_MS = 8_000;

// The export-authorization cookie lasts 5 minutes; a wait that would outlast it
// fails visibly instead of hitting an expired cookie.
const EXPORT_AUTHORIZATION_WINDOW_MS = 5 * 60_000;

function rateLimitBackoffMs(attempt: number): number {
  return Math.min(RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt, RATE_LIMIT_RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AccountExportErrorCode = 'ACCOUNT_EXPORT_UNAVAILABLE';

/**
 * Thrown when the export cannot complete honestly (non-2xx, or a page loop that
 * never reports `nextCursor: null`); callers must not fall back to a partial
 * account section.
 */
export class AccountExportError extends Error {
  constructor(
    public readonly code: AccountExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountExportError';
  }
}

export interface AccountExportClientDeps {
  apiBaseUrl: string;
  /** Read once by the caller; never refreshed mid-export. */
  accessToken: string;
  /**
     * Absolute epoch-ms expiry of the export cookie, shared with the preceding
     * workspace fetch so a served `Retry-After` counts wall-clock time already
     * spent. Defaults to now plus the window; a real export passes the deadline
     * derived from the access token's `exp`.
     */
  deadlineAt?: number;
}

interface AccountExportPageResponse {
  history: unknown[];
  nextCursor: string | null;
  [section: string]: unknown;
}

async function fetchPage(
  deps: AccountExportClientDeps,
  cursor: string | null,
  deadlineAt: number,
): Promise<AccountExportPageResponse> {
  const url = cursor
    ? `${deps.apiBaseUrl}/api/v1/auth/account-export?cursor=${encodeURIComponent(cursor)}`
    : `${deps.apiBaseUrl}/api/v1/auth/account-export`;

  for (let attempt = 0; ; attempt += 1) {
    // The timer spans fetch() and the body read, so a stall in either aborts.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${deps.accessToken}` },
        credentials: 'include',
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      throw new AccountExportError(
        'ACCOUNT_EXPORT_UNAVAILABLE',
        err instanceof Error && err.name === 'AbortError'
          ? 'Account export request timed out.'
          : `Account export request failed: ${err instanceof Error ? err.message : 'network error'}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const served = retryAfterMs(res.headers);
      const waitMs =
        served !== null && served <= RETRY_CAP_MS ? served : rateLimitBackoffMs(attempt);
      // Waiting past the deadline would only fail later, on an expired cookie.
      if (Date.now() + waitMs > deadlineAt) {
        throw new AccountExportError(
          'ACCOUNT_EXPORT_UNAVAILABLE',
          'Account export was rate-limited long enough that honoring the wait would ' +
            'outlast the export session window; export aborted rather than risk a ' +
            'request against an expired authorization.',
        );
      }
      // Notice only for a served `Retry-After`, not this client's own computed backoff.
      if (served !== null && served <= RETRY_CAP_MS) {
        raiseWaitNotice(served);
      }
      await sleep(waitMs);
      continue;
    }

    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: { message?: string } } | null)?.error?.message ??
        `Account export request failed: ${res.status}`;
      throw new AccountExportError('ACCOUNT_EXPORT_UNAVAILABLE', message);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { history?: unknown }).history)) {
      throw new AccountExportError(
        'ACCOUNT_EXPORT_UNAVAILABLE',
        'Account export response was malformed; export aborted to avoid a partial account section.',
      );
    }
    return parsed as AccountExportPageResponse;
  }
}

/**
 * Fetches the first page's non-paging sections plus every `history` page in
 * order; throws rather than return a short history.
 */
export async function fetchAccountExport(
  deps: AccountExportClientDeps,
): Promise<Record<string, unknown>> {
  const deadlineAt = deps.deadlineAt ?? Date.now() + EXPORT_AUTHORIZATION_WINDOW_MS;
  const first = await fetchPage(deps, null, deadlineAt);
  const { history: firstHistory, nextCursor: firstCursor, ...rest } = first;
  const history: unknown[] = [...firstHistory];
  let cursor = firstCursor;
  for (let page = 0; page < MAX_ACCOUNT_EXPORT_PAGES; page += 1) {
    if (cursor === null) break;
    const next = await fetchPage(deps, cursor, deadlineAt);
    // A repeated cursor would loop forever; the account section is incomplete.
    if (next.nextCursor === cursor) {
      throw new AccountExportError(
        'ACCOUNT_EXPORT_UNAVAILABLE',
        'Account export history stopped advancing its cursor while still reporting more pages; export aborted to avoid a partial history.',
      );
    }
    history.push(...next.history);
    cursor = next.nextCursor;
  }
  if (cursor !== null) {
    throw new AccountExportError(
      'ACCOUNT_EXPORT_UNAVAILABLE',
      `Account export history exceeded the ${MAX_ACCOUNT_EXPORT_PAGES}-page ceiling while still reporting more pages; export aborted to avoid a partial history.`,
    );
  }
  return { ...rest, history };
}
