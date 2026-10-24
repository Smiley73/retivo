// Unit tests for the CSRF cookie injection in the API client.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock document.cookie before importing the module.
const cookies: Record<string, string> = {};
Object.defineProperty(document, 'cookie', {
  get() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  },
  configurable: true,
});

const { apiRequest, configureApi, ApiRequestError } = await import('./client.js');

beforeEach(() => {
  for (const key of Object.keys(cookies)) delete cookies[key];
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  const init: ResponseInit =
    status === 204
      ? { status }
      : { status, headers: { 'Content-Type': 'application/json' } };
  const responseBody = status === 204 ? null : JSON.stringify(body);
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseBody, init));
}

describe('CSRF header injection', () => {
  beforeEach(() => {
    configureApi({
      getAccessToken: () => 'test-access-token',
      refreshAccessToken: async () => 'test-access-token',
    });
  });

  it('sends X-CSRF-Token header on POST when csrf-token cookie is present', async () => {
    cookies['csrf-token'] = 'my-csrf-token';
    const spy = mockFetch(200, { ok: true });

    await apiRequest('/api/v1/plans', { method: 'POST', body: { name: 'test' } });

    const [, init] = spy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('my-csrf-token');
  });

  it('does NOT send X-CSRF-Token on GET requests', async () => {
    cookies['csrf-token'] = 'my-csrf-token';
    const spy = mockFetch(200, { data: [] });

    await apiRequest('/api/v1/plans');

    const [, init] = spy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });

  it('sends X-CSRF-Token on PATCH', async () => {
    cookies['csrf-token'] = 'patch-token';
    const spy = mockFetch(200, { id: '1' });

    await apiRequest('/api/v1/plans/1', { method: 'PATCH', body: {} });

    const [, init] = spy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('patch-token');
  });

  it('sends X-CSRF-Token on DELETE', async () => {
    cookies['csrf-token'] = 'delete-token';
    const spy = mockFetch(204, null);

    await apiRequest('/api/v1/plans/1', { method: 'DELETE' });

    const [, init] = spy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('delete-token');
  });

  it('omits X-CSRF-Token when no csrf-token cookie exists', async () => {
    const spy = mockFetch(200, { data: [] });

    await apiRequest('/api/v1/plans', { method: 'POST', body: {} });

    const [, init] = spy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });
});

describe('401 refresh-and-retry', () => {
  it('does NOT refresh+retry on a 401 INVALID_CREDENTIALS (verify-password)', async () => {
    // A deliberate credential-validation failure must not be retried: that would re-run verify-password, double-recording its audit event and consuming a second throttle slot.
    const refresh = vi.fn(async () => 'new-token');
    configureApi({
      getAccessToken: () => 'test-access-token',
      refreshAccessToken: refresh,
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      apiRequest('/api/v1/auth/verify-password', {
        method: 'POST',
        body: { currentPassword: 'wrong', purpose: 'data_export' },
      }),
    ).rejects.toBeInstanceOf(ApiRequestError);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('DOES refresh+retry on a 401 without INVALID_CREDENTIALS (expired token)', async () => {
    // An expired access token is refreshed once and retried.
    const refresh = vi.fn(async () => 'new-token');
    configureApi({
      getAccessToken: () => 'stale-token',
      refreshAccessToken: refresh,
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Token expired.' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await apiRequest('/api/v1/plans', { method: 'POST', body: {} });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Retry-After carriage', () => {
  beforeEach(() => {
    configureApi({
      getAccessToken: () => 'test-access-token',
      refreshAccessToken: async () => 'test-access-token',
    });
  });

  it('carries a parsed Retry-After on ApiRequestError for a JSON error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '45' } },
      ),
    );

    const err = (await apiRequest('/api/v1/plans').catch((e) => e)) as InstanceType<
      typeof ApiRequestError
    >;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.retryAfterMs).toBe(45_000);
  });

  it('carries a parsed Retry-After on ApiRequestError for a non-JSON (gateway) error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Service Unavailable</html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html', 'Retry-After': '20' },
      }),
    );

    const err = (await apiRequest('/api/v1/plans').catch((e) => e)) as InstanceType<
      typeof ApiRequestError
    >;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.error.code).toBe('INVALID_RESPONSE');
    expect(err.retryAfterMs).toBe(20_000);
  });

  it('an absent Retry-After carries null/undefined, distinguishable from a zero wait', async () => {
    mockFetch(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } });

    const err = (await apiRequest('/api/v1/plans').catch((e) => e)) as InstanceType<
      typeof ApiRequestError
    >;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.retryAfterMs ?? null).toBeNull();
  });
});
