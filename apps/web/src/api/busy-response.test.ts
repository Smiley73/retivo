/**
 * Tests for the shared "service is busy" predicate. Both branches true, each guard false in isolation,
 * a non-error value, and — the seam a per-screen test cannot cover — that
 * `client.ts`'s classifier actually produces a value this predicate accepts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, ApiRequestError } from './client';
import { BUSY_MESSAGE, isBusyResponse } from './busy-response';

describe('isBusyResponse', () => {
  it('is true for a no-envelope 5xx (INVALID_RESPONSE)', () => {
    const err = new ApiRequestError(502, {
      code: 'INVALID_RESPONSE',
      message: 'Expected JSON response but received text/html',
    });
    expect(isBusyResponse(err)).toBe(true);
  });

  it('is true for a no-envelope 5xx (UNKNOWN_ERROR)', () => {
    const err = new ApiRequestError(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' });
    expect(isBusyResponse(err)).toBe(true);
  });

  it('is true for a no-envelope 429 with retryAfterMs absent (undefined)', () => {
    const err = new ApiRequestError(429, { code: 'UNKNOWN_ERROR', message: 'Too Many Requests' });
    expect(isBusyResponse(err)).toBe(true);
  });

  it('is true for a no-envelope 429 with retryAfterMs explicitly null', () => {
    const err = new ApiRequestError(
      429,
      { code: 'UNKNOWN_ERROR', message: 'Too Many Requests' },
      null,
    );
    expect(isBusyResponse(err)).toBe(true);
  });

  it('is false for a no-envelope 429 that DID carry a parsed Retry-After (the wait notice owns that case, not this)', () => {
    const err = new ApiRequestError(
      429,
      { code: 'UNKNOWN_ERROR', message: 'Too Many Requests' },
      5_000,
    );
    expect(isBusyResponse(err)).toBe(false);
  });

  it('is false for a no-envelope 4xx below the status floor', () => {
    const err404 = new ApiRequestError(404, { code: 'UNKNOWN_ERROR', message: 'Not Found' });
    const err400 = new ApiRequestError(400, { code: 'INVALID_RESPONSE', message: 'Bad Request' });
    expect(isBusyResponse(err404)).toBe(false);
    expect(isBusyResponse(err400)).toBe(false);
  });

  it('is false for an enveloped error, regardless of status — a real 5xx keeps its own message', () => {
    const err = new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'boom' });
    expect(isBusyResponse(err)).toBe(false);
  });

  it('is false for 429 LOGIN_BACKOFF — its own sentence, no Retry-After header, must never be replaced', () => {
    const err = new ApiRequestError(429, {
      code: 'LOGIN_BACKOFF',
      message: 'Try again in 23 seconds…',
    });
    expect(isBusyResponse(err)).toBe(false);
  });

  it('returns false for a non-ApiRequestError value rather than throwing', () => {
    expect(isBusyResponse(undefined)).toBe(false);
    expect(isBusyResponse(null)).toBe(false);
    expect(isBusyResponse('nope')).toBe(false);
    expect(isBusyResponse(new Error('network error'))).toBe(false);
  });
});

describe('isBusyResponse — bound to the classifier that produces the sentinels (client.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts what apiRequest produces for a non-JSON 503 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html><body>Service Unavailable</body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    let caught: unknown;
    try {
      await apiRequest('/api/v1/whatever', { auth: false });
    } catch (err) {
      caught = err;
    }
    expect(isBusyResponse(caught)).toBe(true);
  });

  it('accepts what apiRequest produces for a JSON 503 body with no error key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    let caught: unknown;
    try {
      await apiRequest('/api/v1/whatever', { auth: false });
    } catch (err) {
      caught = err;
    }
    expect(isBusyResponse(caught)).toBe(true);
  });
});

it('BUSY_MESSAGE is the owner-approved sentence, unchanged', () => {
  expect(BUSY_MESSAGE).toBe('The service is busy right now. Please try again in a moment.');
});
