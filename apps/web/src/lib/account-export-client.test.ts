import { afterEach, describe, expect, it, vi } from 'vitest';

// Mocked: this file proves only when a served Retry-After raises the wait notice.
const raiseWaitNotice = vi.fn();
vi.mock('./toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import { fetchAccountExport } from './account-export-client';

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

const UNAVAILABLE = { code: 'ACCOUNT_EXPORT_UNAVAILABLE' };

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

    await expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
  });

  it('page-ceiling guard: an always-advancing cursor that never resolves to null throws rather than returning a short history', async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      n += 1;
      return jsonResponse({ history: [{ eventId: `e${n}` }], nextCursor: `c${n}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
  }, 20000);

  it('a non-2xx response rejects with the server error message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'Nope' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toThrow('Nope');
  });

  it('a malformed response (no history array) throws rather than returning a partial bundle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
  });

  it('a request that never resolves is aborted and surfaces as an unavailable error, not an unhandled hang', async () => {
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

      const pending = expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('gives up and rejects once the 429 retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ error: { message: 'Too many requests' } }, 429));
      vi.stubGlobal('fetch', fetchMock);

      const pending = expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

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
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.history).toEqual([{ eventId: 'e1' }]);
      expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

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
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.history).toEqual([{ eventId: 'e1' }]);
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

  // The export-authorization cookie lives 5 minutes; a served wait must not push past it.
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

      const pending = expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock.mock.calls.length).toBeLessThan(6);
    } finally {
      vi.useRealTimers();
    }
  });

  // One absolute deadline from the caller, not a per-call budget: an earlier workspace fetch already used wall-clock time.
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

      const deadlineAt = Date.now() + 30_000;
      const pending = expect(
        fetchAccountExport({ ...DEPS, deadlineAt }),
      ).rejects.toMatchObject(UNAVAILABLE);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A per-page counter used to reset on every history page, so waits past the window across pages passed.
  it('carries the same deadline across paginated history requests — waits do not get a fresh budget on each page', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse({ history: [{ eventId: 'a' }], nextCursor: 'c1' });
        }
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '90' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const deadlineAt = Date.now() + 100_000;
      const pending = expect(
        fetchAccountExport({ ...DEPS, deadlineAt }),
      ).rejects.toMatchObject(UNAVAILABLE);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock.mock.calls.length).toBeLessThan(1 + 6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still fails terminally on a non-429 non-2xx status with no retry, exactly as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Server error' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Fails against an implementation that cleared the abort timer once fetch() resolved, before res.text().
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

      const pending = expect(fetchAccountExport(DEPS)).rejects.toMatchObject(UNAVAILABLE);
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
