/**
 * Client for the ACCOUNT half of "Export my data":
 * `GET /auth/account-export`, read under the same 5-minute session-bound
 * export-authorization cookie the workspace half's forced bootstrap + pull
 * rides on (`server-data-export.ts` / `use-profile-export.ts`).
 *
 * Deliberately does NOT use `HttpSyncClient` / `apiRequest`'s access-token
 * refresh-and-replay: the export cookie is bound to the CURRENT access
 * token's `jti` (`data-export-authorization.service.ts`), so a token refresh
 * mid-export would invalidate the cookie and turn a transient 401 into a
 * misleading full-export failure. This client sends the access token it was
 * handed once, per call, and never refreshes.
 *
 * Pages behind the server's opaque `history` cursor under the same
 * no-progress and page-ceiling guards `fetchServerAuthoritativeState`
 * (server-data-export.ts) uses for the workspace pull loop, and throws
 * rather than ever returning a short history.
 */
import { retryAfterMs, RETRY_CAP_MS } from './retry-backoff.js';
import { raiseWaitNotice } from './toast-queue.js';

/** Safety ceiling on the page loop — mirrors `MAX_PULL_PAGES` in
 *  `server-data-export.ts`. Far above any realistic page count for a single
 *  account's history at the server's ~1 MB-response-size page limit. */
const MAX_ACCOUNT_EXPORT_PAGES = 10_000;

/** Per-page request timeout, covering the response-body read as well as the
 *  headers. A stalled connection (headers/body never
 *  arrive) would otherwise leave the raw `fetch` promise, or a stalled
 *  `res.text()` read, pending forever — the UI stuck busy with no error
 *  surfaced, and the 5-minute export-authorization cookie's expiry never
 *  visibly explained. 30s comfortably covers a slow real page under the
 *  server's naturally-paged (~1 MB) response while still bounding the wait. */
const PAGE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Bounded retry-with-backoff for a `429` on a single page request.
 * The route throttles at 120 requests/minute; without this, the
 * FIRST page past that per-minute budget aborted the whole export as
 * terminal, even though the export-authorization cookie's 5-minute window
 * has room for several throttle windows. A transient 429 now paces itself
 * with capped exponential backoff instead. Any OTHER non-2xx status is still
 * immediately terminal, unchanged from before.
 *
 * A served `Retry-After` at or under the
 * shared module's cap now wins over this computed backoff (same override
 * rule every other client seam uses); above the cap, or absent, the
 * computed backoff below applies unchanged.
 */
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_RETRY_BASE_MS = 1_000;
const RATE_LIMIT_RETRY_MAX_MS = 8_000;

/**
 * The export-authorization cookie is a 5-minute window (see the module
 * note). Honoring a served `Retry-After` must never push the CUMULATIVE
 * wait across this page's retries past that window without failing
 * visibly — continuing to wait past it would only fail later anyway, once
 * the cookie itself has expired, on a request the user can't see is
 * doomed.
 */
const EXPORT_AUTHORIZATION_WINDOW_MS = 5 * 60_000;

function rateLimitBackoffMs(attempt: number): number {
  return Math.min(RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt, RATE_LIMIT_RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AccountExportErrorCode = 'ACCOUNT_EXPORT_UNAVAILABLE';

/**
 * Thrown when the account export cannot be completed honestly: a transport
 * failure (non-2xx response), or a page loop that stalls without ever
 * reporting `nextCursor: null`. Never swallowed — the caller must not fall
 * back to a partial account section.
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
  /** The access token to send on every page request — read ONCE by the
   *  caller and never refreshed mid-export (see the module note). */
  accessToken: string;
  /**
   * Absolute epoch-ms deadline the export-authorization cookie (and the
   * access token bound to it) expires at. A served
   * `Retry-After` is only honored when `Date.now() + waitMs` stays under
   * THIS value — a single fixed point in time, not a per-call duration
   * budget — so it correctly reflects wall-clock time already spent on an
   * antecedent workspace fetch (`fetchServerAuthoritativeState`, which rides
   * the same cookie) and never resets across this function's own paginated
   * `history` requests. Defaults to `Date.now() + EXPORT_AUTHORIZATION_WINDOW_MS`
   * from THIS call for a caller with no better reference (existing tests,
   * a bare/local invocation); a real export must pass the true deadline —
   * derived once, at verification time, from the access token's own `exp`
   * claim (the cookie's TTL is designed to match it) — so the whole
   * workspace-then-account round trip shares one authoritative clock.
   */
  deadlineAt?: number;
}

/** One page of `GET /auth/account-export`, as served (untyped beyond the
 *  paging envelope — every section is opaque to this client, which only
 *  merges history pages and hands the rest through verbatim). */
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
    // Bounded timeout: a stalled
    // connection must not leave this pending forever, whether it stalls
    // before headers arrive (fetch() itself) or after (the response body
    // read). The timer is kept alive across both awaits so an abort during
    // `res.text()` still fires; the abort/any other transport failure both
    // surface as an AccountExportError rather than an unhandled hang or an
    // indefinitely-busy UI.
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

    // Bounded retry-with-backoff for a throttle hit — pace back
    // off and retry rather than treating the FIRST 429 as terminal. Any
    // other non-2xx status falls through to the immediate-throw path below,
    // unchanged. Honor a served `Retry-After` under the shared cap;
    // otherwise fall back to the existing capped-exponential computation.
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const served = retryAfterMs(res.headers);
      const waitMs =
        served !== null && served <= RETRY_CAP_MS ? served : rateLimitBackoffMs(attempt);
      // Honoring a served wait must never push PAST the absolute
      // authorization deadline — waiting further would only fail later, on
      // a request the user can't see was already doomed. Checking against
      // one fixed point in time (rather than a duration counter reset per
      // call) correctly reflects wall-clock time an antecedent workspace
      // fetch already spent, and accumulates correctly across this
      // function's own paginated calls too.
      if (Date.now() + waitMs > deadlineAt) {
        throw new AccountExportError(
          'ACCOUNT_EXPORT_UNAVAILABLE',
          'Account export was rate-limited long enough that honoring the wait would ' +
            'outlast the export session window; export aborted rather than risk a ' +
            'request against an expired authorization.',
        );
      }
      // Raise the shared "please wait" notice exactly when a SERVED
      // Retry-After is the wait about to be honored — not when this branch
      // fell back to the computed backoff, which is this client's own
      // decision, not a server ask. The export UI otherwise shows only a
      // spinner while this retries.
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
 * Fetch the complete account export: the first page's non-paging sections
 * plus every `history` page, concatenated in order. Mirrors
 * `fetchServerAuthoritativeState`'s no-progress + page-ceiling guards so a
 * misbehaving/never-`nextCursor:null` server can never spin forever or hand
 * back a silently short history.
 */
export async function fetchAccountExport(
  deps: AccountExportClientDeps,
): Promise<Record<string, unknown>> {
  // One deadline for the whole call, computed ONCE — never re-derived per
  // page (see `AccountExportClientDeps.deadlineAt`).
  const deadlineAt = deps.deadlineAt ?? Date.now() + EXPORT_AUTHORIZATION_WINDOW_MS;
  const first = await fetchPage(deps, null, deadlineAt);
  const { history: firstHistory, nextCursor: firstCursor, ...rest } = first;
  const history: unknown[] = [...firstHistory];
  let cursor = firstCursor;
  for (let page = 0; page < MAX_ACCOUNT_EXPORT_PAGES; page += 1) {
    if (cursor === null) break;
    const next = await fetchPage(deps, cursor, deadlineAt);
    // No-progress guard: a server that echoes the same cursor forever would
    // otherwise loop indefinitely. The account section is provably
    // incomplete here — fail visibly rather than build from it.
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
