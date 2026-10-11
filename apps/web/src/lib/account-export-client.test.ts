/**
 * Unit tests for the account-export client: paging
 * to `nextCursor: null`, the no-progress guard, the page-ceiling guard, and
 * transport-failure propagation. `fetch` is stubbed directly — no DOM needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The wait-notice raiser is mocked at the
// module boundary — its own drop/coalesce behaviour is covered by
// `toast-queue.test.ts`; this file proves only that a SERVED Retry-After
// about to be honored on a 429 raises it, and that falling back to the
// computed backoff (no served wait, or one above the shared cap) does not.
const raiseWaitNotice = vi.fn();
vi.mock('./toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import { AccountExportError, fetchAccountExport } from './account-export-client';

const DEPS = { apiBaseUrl: 'https://api.test', accessToken: 'tok-1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  raiseWaitNotice.mockClear();
});

describe('fetchAccountExport', () => {
  it('returns the first page verbatim (minus paging fields) merged with the concatenated history when there is only one page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        user: { userId: 'u-1' },
        history: [{ eventId: 'e1' }, { eventId: 'e2' }],
        nextCursor: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAccountExport(DEPS);
    expect(result.user).toEqual({ userId: 'u-1' });
    expect(result.history).toEqual([{ eventId: 'e1' }, { eventId: 'e2' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/v1/auth/account-export');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(init.credentials).toBe('include');
  });

  it('walks every page and concatenates history in order', async () => {
    const pages = [
      jsonResponse({ user: { userId: 'u-1' }, history: [{ eventId: 'a' }], nextCursor: 'c1' }),
      jsonResponse({ history: [{ eventId: 'b' }], nextCursor: 'c2' }),
      jsonResponse({ history: [{ eventId: 'c' }], nextCursor: null }),
    ];
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => pages[call++]!);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAccountExport(DEPS);
    expect(result.history).toEqual([{ eventId: 'a' }, { eventId: 'b' }, { eventId: 'c' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Second/third calls carry the cursor query param.
    expect(fetchMock.mock.calls[1]![0]).toContain('cursor=c1');
    expect(fetchMock.mock.calls[2]![0]).toContain('cursor=c2');
  });

  it('does NOT trigger an access-token refresh — sends the SAME token on every page request', async () => {
    const pages = [
      jsonResponse({ history: [{ eventId: 'a' }], nextCursor: 'c1' }),
      jsonResponse({ history: [{ eventId: 'b' }], nextCursor: null }),
    ];
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => pages[call++]!);
    vi.stubGlobal('fetch', fetchMock);

    await fetchAccountExport(DEPS);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    }
  });

  it('no-progress guard: a repeated cursor throws instead of looping forever', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ history: [], nextCursor: 'stuck' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(AccountExportError);
  });

  it('page-ceiling guard: an always-advancing cursor that never resolves to null throws rather than returning a short history', async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      n += 1;
      return jsonResponse({ history: [{ eventId: `e${n}` }], nextCursor: `c${n}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(AccountExportError);
  }, 20000);

  it('a non-2xx response throws AccountExportError with the server error message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'Nope' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toThrow('Nope');
  });

  it('a malformed response (no history array) throws rather than returning a partial bundle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(AccountExportError);
  });

  // A stalled connection (fetch never resolves) must
  // not hang the caller forever — the per-page AbortController timeout
  // aborts it and the abort surfaces as an AccountExportError. Fake timers
  // avoid a real 30s wait in the test.
  it('a request that never resolves is aborted and surfaces as AccountExportError, not an unhandled hang', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(
        AccountExportError,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      // A real AbortController.signal was passed through on the stalled call.
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  // A single 429 must not abort the whole export — the client
  // paces back off and retries rather than treating the first throttle hit
  // as terminal.
  it('retries a 429 with backoff and succeeds once the throttle window clears', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: { message: 'Too many requests' } }, 429);
        return jsonResponse({ user: { userId: 'u-1' }, history: [{ eventId: 'e1' }], nextCursor: null });
      });
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchAccountExport(DEPS);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.history).toEqual([{ eventId: 'e1' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up and throws AccountExportError once the 429 retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ error: { message: 'Too many requests' } }, 429));
      vi.stubGlobal('fetch', fetchMock);

      const pending = expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(AccountExportError);
      await vi.runAllTimersAsync();
      await pending;
      // 1 initial attempt + MAX_RATE_LIMIT_RETRIES(5) retries = 6 calls.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  // A served Retry-After on a 429
  // wins over the computed capped-exponential backoff.
  it('honors a served Retry-After on a 429 instead of the computed backoff', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
          });
        }
        return jsonResponse({ history: [{ eventId: 'e1' }], nextCursor: null });
      });
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchAccountExport(DEPS);
      // The computed backoff for attempt 0 is 1s; if the served 3s value
      // were ignored, the retry would already have fired by 2s.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.history).toEqual([{ eventId: 'e1' }]);
      // A served Retry-After about to be
      // honored raises the shared "please wait" notice — the export UI
      // otherwise shows only a spinner while this retries.
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // A served Retry-After above the shared module's 2-minute cap is ignored;
  // the existing computed backoff applies exactly as before.
  it('ignores a served Retry-After above the shared cap and falls back to the computed backoff', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '99999' },
          });
        }
        return jsonResponse({ history: [{ eventId: 'e1' }], nextCursor: null });
      });
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchAccountExport(DEPS);
      await vi.runAllTimersAsync();
      const result = await pending;
      // Only the computed (≤ 1s) backoff elapsed before the retry — the
      // 99999s served value never applied.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.history).toEqual([{ eventId: 'e1' }]);
      // The wait about to be honored here is this client's OWN computed
      // backoff, not a server ask — nothing to raise.
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises nothing on a 429 with no Retry-After — only the computed backoff applies', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ error: { message: 'Too many requests' } }, 429);
        return jsonResponse({ history: [{ eventId: 'e1' }], nextCursor: null });
      });
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchAccountExport(DEPS);
      await vi.runAllTimersAsync();
      await pending;
      expect(raiseWaitNotice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The export-authorization cookie is a 5-minute window: honoring a served
  // wait must never push the cumulative wait past it without failing
  // visibly, rather than silently continuing toward a doomed request.
  it('fails visibly rather than let a served Retry-After push the cumulative wait past the export window', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '120' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(
        AccountExportError,
      );
      await vi.runAllTimersAsync();
      await pending;
      // 5 min / 120s per served wait: the 3rd attempt (after 2 waits totalling
      // 240s) would push the cumulative wait to 360s > the 300s window, so it
      // fails before ever reaching MAX_RATE_LIMIT_RETRIES(5) retries.
      expect(fetchMock.mock.calls.length).toBeLessThan(6);
    } finally {
      vi.useRealTimers();
    }
  });

  // The export window must be measured against ONE
  // absolute deadline the caller supplies (the export-authorization
  // cookie's real expiry), not a fresh per-call duration budget — a slow
  // antecedent workspace fetch (which shares the same cookie) already
  // consumed real wall-clock time before this call ever started.
  it('honors the caller-supplied absolute deadline: a wait that would cross it fails immediately, even on the very first 429', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      // Simulate an antecedent workspace fetch that already consumed 270s of
      // the cookie's 5-minute window — only 30s of real authorization life
      // is left, well under the served 60s wait.
      const deadlineAt = Date.now() + 30_000;
      const pending = expect(
        fetchAccountExport({ ...DEPS, deadlineAt }),
      ).rejects.toBeInstanceOf(AccountExportError);
      await vi.runAllTimersAsync();
      await pending;
      // Failed on the very first attempt — no sleep was ever started.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The old per-page-local counter reset on every paginated `history` page,
  // so waits totaling well past the window across pages could still pass.
  // A single absolute deadline shared across every page call closes that.
  it('carries the same deadline across paginated history requests — waits do not get a fresh budget on each page', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        // First page succeeds and points at a second page.
        if (call === 1) {
          return jsonResponse({ history: [{ eventId: 'a' }], nextCursor: 'c1' });
        }
        // Every subsequent (second-page) request is rate-limited with a
        // served wait that individually fits under 5 minutes, but which
        // would cumulatively blow well past a deadline set close to "now".
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '90' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      // Only 100s of authorization life left — the first page succeeds
      // immediately (no wait), but the second page's first 90s wait would
      // leave only 10s, and a second 90s wait on top of that would blow
      // past the deadline instead of resetting to a fresh per-page budget.
      const deadlineAt = Date.now() + 100_000;
      const pending = expect(
        fetchAccountExport({ ...DEPS, deadlineAt }),
      ).rejects.toBeInstanceOf(AccountExportError);
      await vi.runAllTimersAsync();
      await pending;
      // 1 successful first page + at most 2 second-page attempts (the
      // initial 429 plus one retry) before the deadline check fails it —
      // nowhere near the 6 calls MAX_RATE_LIMIT_RETRIES would otherwise
      // allow on the second page alone.
      expect(fetchMock.mock.calls.length).toBeLessThan(1 + 6);
    } finally {
      vi.useRealTimers();
    }
  });

  // A non-429 non-2xx status still fails terminally on the first attempt,
  // exactly as before — the Retry-After honoring is scoped to the 429 branch.
  it('still fails terminally on a non-429 non-2xx status with no retry, exactly as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Server error' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(AccountExportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Headers resolving promptly is not enough — if the
  // response BODY then stalls, the same per-page timeout must still bound
  // the wait. This fails against an implementation that cleared the abort
  // timer in `finally` right after `fetch()` resolved, before `res.text()`
  // was ever awaited.
  it('a request whose headers resolve but whose body stalls is still aborted within the timeout, not hung on res.text()', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              new Promise<string>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                  const err = new Error('The operation was aborted.');
                  err.name = 'AbortError';
                  reject(err);
                });
              }),
          } as unknown as Response),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = expect(fetchAccountExport(DEPS)).rejects.toBeInstanceOf(
        AccountExportError,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
