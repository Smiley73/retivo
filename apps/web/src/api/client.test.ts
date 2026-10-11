/**
 * Tests for the wait-notice raiser at the shared `apiRequest` seam:
 * every non-sync `Retry-After` this
 * client observes funnels through here, right beside the header
 * parse. `raiseWaitNotice` itself is mocked at the module boundary — its
 * own drop/coalesce behaviour is covered by `lib/toast-queue.test.ts`; this
 * file proves only that `apiRequest` calls it (or doesn't) at the right
 * times.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const raiseWaitNotice = vi.fn();
vi.mock('../lib/toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import { apiRequest, ApiRequestError } from './client';

function throttled(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(
    JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
    { status: 429, headers },
  );
}

function serverError(status = 500, retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(
    JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something broke' } }),
    { status, headers },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('apiRequest — wait-notice raiser', () => {
  it('raises the shared notice with the parsed Retry-After when a request is throttled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(throttled('5')));
    await expect(apiRequest('/api/v1/whatever', { auth: false })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(raiseWaitNotice).toHaveBeenCalledExactlyOnceWith(5_000);
  });

  it('a 429 with no Retry-After raises nothing (the inline copy covers this case)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(throttled()));
    await expect(apiRequest('/api/v1/whatever', { auth: false })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(raiseWaitNotice).not.toHaveBeenCalled();
  });

  it('a genuine enveloped 5xx with no Retry-After raises nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError()));
    await expect(apiRequest('/api/v1/whatever', { auth: false })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(raiseWaitNotice).not.toHaveBeenCalled();
  });

  // The raise is gated on a throttling 429, not on the header
  // alone. A 503 CAN carry Retry-After (the S3-bootstrap path; "429 or 503 +
  // Retry-After" backpressure) — but the rule is "a genuine enveloped 5xx
  // raises nothing", and the
  // request has failed outright, so "please wait" would be misleading.
  it('a genuine enveloped 503 that DOES carry Retry-After still raises nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError(503, '30')));
    await expect(apiRequest('/api/v1/whatever', { auth: false })).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 30_000,
    });
    expect(raiseWaitNotice).not.toHaveBeenCalled();
  });

  it('honors the opt-out: raiseWaitNotice: false suppresses the raise even with a Retry-After present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(throttled('5')));
    await expect(
      apiRequest('/api/v1/whatever', { auth: false, raiseWaitNotice: false }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(raiseWaitNotice).not.toHaveBeenCalled();
  });
});
