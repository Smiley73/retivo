/**
 * HttpSyncClient unit tests — covers the 401 refresh-and-retry path
 * added to align sync transport behavior with api/client.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HttpSyncClient is shared with the sync
// loop, so it must NEVER raise the shared wait notice itself (the exclusion
// is by call site — server-data-export.ts raises over this same transport,
// this module deliberately does not). Mocked so a future regression that
// adds a raise call here fails loudly instead of silently.
const raiseWaitNotice = vi.fn();
vi.mock('../lib/toast-queue', () => ({
  raiseWaitNotice: (...args: unknown[]) => raiseWaitNotice(...args),
}));

import {
  HttpSyncClient,
  SyncApiError,
  FreshnessRollbackError,
  type SyncClientDeps,
} from './sync-client';
import { computeCursorTag } from '../crypto/freshness';
import { encryptPayload } from '../crypto/payload-crypto';
import { UnauthenticatedPayloadError } from './pull-apply';
import { generateHdk } from '../crypto/key-wrapping';
import type { PendingMutation } from '../db/types';
import type { EncryptedPayloadEnvelope } from '../crypto/encryption-types';

// Minimal mock for global fetch
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function makeResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const headersObj = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersObj,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('HttpSyncClient', () => {
  let deps: SyncClientDeps;
  let client: HttpSyncClient;

  beforeEach(() => {
    deps = {
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'expired-token',
      getCsrfToken: () => 'csrf-tok',
      refreshAccessToken: vi.fn(),
    };
    client = new HttpSyncClient(deps);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries with refreshed token on 401', async () => {
    const refreshed = 'fresh-token';
    (deps.refreshAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(refreshed);

    // First call returns 401, second succeeds
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(makeResponse(200, { changes: [], newCursor: '1', hasMore: false }));

    const result = await client.pull({ since: '0' });

    expect(deps.refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should carry the refreshed token
    const secondCallHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(secondCallHeaders['Authorization']).toBe(`Bearer ${refreshed}`);
    expect(result).toEqual({ changes: [], newCursor: '1', hasMore: false });
  });

  it('throws SyncApiError when refresh returns null (session expired)', async () => {
    (deps.refreshAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    fetchMock.mockResolvedValueOnce(
      makeResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', traceId: 'tr-1' } }),
    );

    const err = await client.pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.code).toBe('UNAUTHENTICATED');
    expect(err.status).toBe(401);
    expect(err.traceId).toBe('tr-1');
  });

  // SyncApiError carries the parsed
  // Retry-After from the failing response.
  it('carries a parsed Retry-After on SyncApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        429,
        { error: { code: 'PUSH_QUOTA_EXCEEDED', message: 'quota exceeded' } },
        { 'Retry-After': '30' },
      ),
    );

    const err = await client.pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.retryAfterMs).toBe(30_000);
    // This transport is shared with the sync loop (badge-only) — it
    // must never raise the shared notice itself, regardless of what the
    // response carried.
    expect(raiseWaitNotice).not.toHaveBeenCalled();
  });

  it('a Retry-After-free error carries null/undefined, distinguishable from a zero wait', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(500, { error: { code: 'UPSTREAM_ERROR', message: 'boom' } }),
    );

    const err = await client.pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.retryAfterMs ?? null).toBeNull();
  });

  // API Gateway's own stage-throttle 429 (infrastructure `apiThrottleRatePerSec`
  // / `apiThrottleBurst`) never reaches the Lambda: the body is the gateway's
  // `{"message":"Too Many Requests"}` — no `error` envelope, no Retry-After,
  // no X-Build-Id. It must surface as a retryable UPSTREAM_ERROR 429, never be
  // mistaken for a session problem, and never trigger the refresh path.
  it('maps an API-Gateway-shaped 429 (no error envelope, no Retry-After) to a retryable UPSTREAM_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(429, { message: 'Too Many Requests' }),
    );

    const err = await client.pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs ?? null).toBeNull();
    expect(err.traceId).toBeUndefined();
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws SyncApiError without retry when no refreshAccessToken provided', async () => {
    const noRefreshDeps: SyncClientDeps = {
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
    };
    const noRefreshClient = new HttpSyncClient(noRefreshDeps);

    fetchMock.mockResolvedValueOnce(
      makeResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
    );

    await expect(noRefreshClient.pull({ since: '0' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-401 errors', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );

    await expect(client.pull({ since: '0' })).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 500,
    });
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws if retry also returns 401 (e.g. token immediately revoked)', async () => {
    (deps.refreshAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue('new-but-revoked');

    fetchMock
      .mockResolvedValueOnce(makeResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(makeResponse(401, { error: { code: 'ACCESS_TOKEN_REVOKED', message: 'revoked' } }));

    await expect(client.pull({ since: '0' })).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_REVOKED',
      status: 401,
    });
  });
});

describe('HttpSyncClient — clearWorkspace', () => {
  let deps: SyncClientDeps;
  let client: HttpSyncClient;

  beforeEach(() => {
    deps = {
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => 'csrf-tok',
      refreshAccessToken: vi.fn(),
    };
    client = new HttpSyncClient(deps);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /sync/workspace/clear with the body + X-CSRF-Token header and returns { ok, historyErased }', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true, historyErased: true }));

    const result = await client.clearWorkspace({
      currentPassword: 'pw',
      eraseHistory: false,
    });

    expect(result).toEqual({ ok: true, historyErased: true });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/v1/sync/workspace/clear');
    expect(init.method).toBe('POST');
    // Positive CSRF assertion (AGENTS.md: verify the header is actually sent on
    // a new state-changing endpoint — not just the server-side missing→403).
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-tok');
    expect(JSON.parse(init.body as string)).toEqual({
      currentPassword: 'pw',
      eraseHistory: false,
    });
  });

  it('forwards the purge-only retry flag', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true, historyErased: true }));

    await client.clearWorkspace({
      currentPassword: 'pw',
      eraseHistory: true,
      purgeHistoryOnly: true,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      currentPassword: 'pw',
      eraseHistory: true,
      purgeHistoryOnly: true,
    });
  });

  it('throws SyncApiError on a non-2xx (wrong password)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' },
      }),
    );
    // No refresh path: a session-valid wrong-password 401 still surfaces as a
    // SyncApiError once refresh returns null (session not the failure axis).
    (deps.refreshAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const err = await client
      .clearWorkspace({ currentPassword: 'wrong', eraseHistory: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).code).toBe('INVALID_CREDENTIALS');
    expect((err as SyncApiError).status).toBe(401);
  });

  it('does NOT refresh + retry on a 401 INVALID_CREDENTIALS (business-logic 401, not token expiry)', async () => {
    // A wrong-password 401 from POST /sync/workspace/clear is the endpoint's own
    // business rejection, NOT an expired access token. Replaying it would fire
    // the destructive clear TWICE, double-counting the server's per-account
    // backoff + audit trail. The client must NOT call refreshAccessToken and
    // must send exactly one request.
    fetchMock.mockResolvedValueOnce(
      makeResponse(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' },
      }),
    );

    const err = await client
      .clearWorkspace({ currentPassword: 'wrong', eraseHistory: false })
      .catch((e) => e);

    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).code).toBe('INVALID_CREDENTIALS');
    expect(deps.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HttpSyncClient — zero-knowledge freshness', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  function makePending(): PendingMutation {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      aggregateId: 'agg-1',
      aggregateType: 'account',
      operation: 'create',
      expectedVersion: 0,
      schemaVersion: 1,
      payload: { name: 'Test' },
      timestamp: Date.now(),
      deviceId: 'dev-1',
      status: 'pending',
    };
  }

  function lastBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  async function genKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  }

  it('throws when getHdk is not provided (server rejects plaintext)', async () => {
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
    });
    await expect(
      client.push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] }),
    ).rejects.toThrow(/HDK is null/);
    // No HTTP request should be made when the HDK is unavailable.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when getHdk returns null (server rejects plaintext)', async () => {
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => null,
    });
    await expect(
      client.push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] }),
    ).rejects.toThrow(/HDK is null/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT internally retry a push rejected 400 FRESHNESS_HEAD_INVALID (server head validation)', async () => {
    const key = await genKey();
    const refreshAccessToken = vi.fn();
    // The server strictly validates the freshness head and returns a
    // distinguishable 400 code. The HTTP wrapper retries ONLY an
    // access-token-expiry 401 — a 400 is terminal and surfaces as a SyncApiError
    // the SyncContext push-catch keys on to park the batch `failed-error`.
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, {
        error: { code: 'FRESHNESS_HEAD_INVALID', message: 'freshnessHead invalid', traceId: 'tr-fh' },
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      refreshAccessToken,
    });
    const err = await client
      .push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).code).toBe('FRESHNESS_HEAD_INVALID');
    expect((err as SyncApiError).status).toBe(400);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('computes and sends an encrypted freshnessHead when getHdk returns a key', async () => {
    const key = await genKey();
    // The server echoes a head carrying a valid tag for the proposed
    // counter (bumpCounter(0) === 1); push now verifies the echoed head.
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        applied: [],
        rejected: [],
        syncCursor: '1',
        freshnessHead: { freshnessCounter: 1, cursorTag: await computeCursorTag(1, key) },
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
    });
    await client.push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] });
    const body = lastBody();
    const head = body.freshnessHead as { freshnessCounter: number; cursorTag: string };
    expect(head.freshnessCounter).toBe(1);
    expect(typeof head.cursorTag).toBe('string');
    expect(head.cursorTag.length).toBeGreaterThan(0);
    // The MAC is the canonical tag over the proposed counter.
    expect(head.cursorTag).toBe(await computeCursorTag(1, key));
    // Payload is now an encrypted envelope, not the plaintext record.
    const payload = (body.mutations as Array<{ payload: Record<string, unknown> }>)[0]!.payload;
    expect(payload.encryptionVersion).toBe(1);
    expect(payload.alg).toBe('AES-256-GCM');
    expect(payload).not.toHaveProperty('name');
  });

  it('pull throws FreshnessRollbackError when served counter < pinned', async () => {
    const key = await genKey();
    const servedTag = await computeCursorTag(3, key); // valid tag, but stale counter
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [],
        newCursor: '1',
        hasMore: false,
        freshnessHead: { freshnessCounter: 3, cursorTag: servedTag },
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 5,
    });
    const err = await client.pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(FreshnessRollbackError);
    expect((err as FreshnessRollbackError).servedCounter).toBe(3);
    expect((err as FreshnessRollbackError).pinnedCounter).toBe(5);
  });

  it('pull accepts a served counter >= pinned with a valid tag (TOFU: pinned 0, served 1)', async () => {
    const key = await genKey();
    const servedTag = await computeCursorTag(1, key);
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [],
        newCursor: '1',
        hasMore: false,
        freshnessHead: { freshnessCounter: 1, cursorTag: servedTag },
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
    });
    const result = await client.pull({ since: '0' });
    expect(result.freshnessHead?.freshnessCounter).toBe(1);
    expect(result.changes).toEqual([]);
  });

  it('pull throws FreshnessRollbackError when the cursor tag fails verification (tampered)', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [],
        newCursor: '1',
        hasMore: false,
        // Counter not below the pin, but the tag is garbage → MAC fails.
        freshnessHead: { freshnessCounter: 2, cursorTag: 'not-a-valid-tag' },
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
    });
    await expect(client.pull({ since: '0' })).rejects.toBeInstanceOf(
      FreshnessRollbackError,
    );
  });

  it('throws FreshnessRollbackError when pull returns absent freshnessHead with existing pin', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { changes: [], newCursor: '1', hasMore: false /* no freshnessHead */ }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 3, // has a pin
    });
    await expect(client.pull({ since: '0' })).rejects.toBeInstanceOf(FreshnessRollbackError);
  });

  it('accepts absent freshnessHead when pinned counter is 0 (TOFU first contact)', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { changes: [], newCursor: '1', hasMore: false }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
    });
    await expect(client.pull({ since: '0' })).resolves.not.toThrow();
  });

  it('push RESOLVES (no rollback) when the response omits freshnessHead with an existing pin', async () => {
    // The push head echo is best-effort and non-atomic with mutation
    // acceptance. A successful commit whose head echo
    // failed (absent) must NOT present as a rollback — push keeps the pin and
    // returns normally. (Contrast: pull/bootstrap still REJECT a missing head
    // with a pin — the dedicated tests above cover that strict path.)
    const key = await genKey();
    const pinned = 3;
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, { applied: [], rejected: [], syncCursor: '1' /* no freshnessHead */ }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => pinned,
    });
    const result = await client.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [makePending()],
    });
    expect(result.syncCursor).toBe('1');
    // The client never mutates the pin — it stays whatever the caller holds.
    expect(pinned).toBe(3);
  });

  it('push RESOLVES (no rollback) when the response carries freshnessHead: null with an existing pin', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        applied: [],
        rejected: [],
        syncCursor: '1',
        freshnessHead: null,
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 4,
    });
    await expect(
      client.push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] }),
    ).resolves.toMatchObject({ syncCursor: '1' });
  });

  it('throws FreshnessRollbackError when push echoes a lower freshnessCounter than pinned', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        applied: [],
        rejected: [],
        syncCursor: '1',
        freshnessHead: { freshnessCounter: 1, cursorTag: 'bad' }, // pinned = 5, served = 1
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 5,
    });
    await expect(
      client.push({ householdId: 'hh-1', deviceId: 'dev-1', mutations: [makePending()] }),
    ).rejects.toBeInstanceOf(FreshnessRollbackError);
  });
});

describe('HttpSyncClient — payload guard', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  async function genKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
  }

  function clientWithHdk(key: CryptoKey, householdId = 'hh-1'): HttpSyncClient {
    return new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
      getHouseholdId: () => householdId,
    });
  }

  // --- pull -------------------------------------------------------------

  it('pull rejects the WHOLE response when HDK is held and a row is plain (not-envelope)', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [
          {
            aggregateId: 'agg-1',
            aggregateType: 'account',
            operation: 'create',
            payload: { name: 'Checking', balance: 100 },
            version: 1,
            schemaVersion: 1,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
          },
        ],
        newCursor: '5',
        hasMore: false,
      }),
    );
    const err = await clientWithHdk(key).pull({ since: '0' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthenticatedPayloadError);
    expect((err as UnauthenticatedPayloadError).phase).toBe('pull');
    expect((err as UnauthenticatedPayloadError).reason).toBe('not-envelope');
  });

  it('pull quarantines an envelope-shaped row that fails to decrypt (forged/tampered) instead of rejecting the whole response', async () => {
    const key = await genKey();
    const report = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [
          {
            aggregateId: 'agg-1',
            aggregateType: 'account',
            operation: 'create',
            payload: {
              encryptionVersion: 1,
              alg: 'AES-256-GCM',
              keyId: 'hh-1',
              nonce: 'AAAAAAAAAAAAAAAA',
              ciphertext: 'not-real-ciphertext',
            },
            version: 1,
            schemaVersion: 1,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
          },
        ],
        newCursor: '5',
        hasMore: false,
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
      getHouseholdId: () => 'hh-1',
      reportDecryptOutcome: report,
    });
    const result = await client.pull({ since: '0' });
    // The bad row is dropped — never applied — and the response otherwise
    // resolves normally (a single bad row must not wedge the pull).
    expect(result.changes).toEqual([]);
    expect(report).toHaveBeenCalledWith({
      quarantined: [{ aggregateId: 'agg-1', aggregateType: 'account', version: 1 }],
      resolved: [],
    });
  });

  it('pull decrypts a genuinely valid envelope and applies the plaintext (regression)', async () => {
    const key = await genKey();
    const envelope = await encryptPayload(
      { name: 'Checking', balance: 100 },
      { householdId: 'hh-1', aggregateId: 'agg-1', aggregateType: 'account', encryptionVersion: 1 },
      key,
      'hh-1',
    );
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [
          {
            aggregateId: 'agg-1',
            aggregateType: 'account',
            operation: 'create',
            payload: envelope,
            version: 1,
            schemaVersion: 1,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
          },
        ],
        newCursor: '5',
        hasMore: false,
      }),
    );
    const result = await clientWithHdk(key).pull({ since: '0' });
    expect(result.changes[0]!.payload).toEqual({ name: 'Checking', balance: 100 });
  });

  // --- bootstrap ----------------------------------------------------------

  it('bootstrap rejects the WHOLE response when a SNAPSHOT aggregate is plain (not-envelope)', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: null,
        workspaceSnapshot: {
          householdId: 'hh-1',
          aggregates: [
            {
              id: 'agg-1',
              householdId: 'hh-1',
              schemaVersion: 1,
              version: 1,
              updatedAt: '2026-07-07T00:00:00.000Z',
              deviceId: 'dev-1',
              aggregateType: 'account',
              payload: { name: 'Checking' },
            },
          ],
        },
        postSnapshotMutations: [],
        syncCursor: '9',
        timestamp: '2026-07-07T00:00:00.000Z',
      }),
    );
    const err = await clientWithHdk(key).bootstrap({ force: false }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthenticatedPayloadError);
    expect((err as UnauthenticatedPayloadError).phase).toBe('bootstrap');
    expect((err as UnauthenticatedPayloadError).reason).toBe('not-envelope');
  });

  it('bootstrap rejects the WHOLE response when a POST-SNAPSHOT mutation is plain (not-envelope)', async () => {
    const key = await genKey();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: null,
        workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
        postSnapshotMutations: [
          {
            aggregateId: 'agg-2',
            aggregateType: 'account',
            operation: 'create',
            payload: { name: 'Savings' },
            version: 1,
            schemaVersion: 1,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
          },
        ],
        syncCursor: '9',
        timestamp: '2026-07-07T00:00:00.000Z',
      }),
    );
    const err = await clientWithHdk(key).bootstrap({ force: false }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthenticatedPayloadError);
    expect((err as UnauthenticatedPayloadError).phase).toBe('bootstrap');
    expect((err as UnauthenticatedPayloadError).reason).toBe('not-envelope');
  });

  it('bootstrap quarantines a poisoned snapshot aggregate on decrypt failure instead of rejecting the whole response (forged envelope)', async () => {
    const key = await genKey();
    const report = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: null,
        workspaceSnapshot: {
          householdId: 'hh-1',
          aggregates: [
            {
              id: 'agg-1',
              householdId: 'hh-1',
              schemaVersion: 1,
              version: 1,
              updatedAt: '2026-07-07T00:00:00.000Z',
              deviceId: 'dev-1',
              aggregateType: 'account',
              payload: {
                encryptionVersion: 1,
                alg: 'AES-256-GCM',
                keyId: 'hh-1',
                nonce: 'AAAAAAAAAAAAAAAA',
                ciphertext: 'not-real-ciphertext',
              },
            },
          ],
        },
        postSnapshotMutations: [],
        syncCursor: '9',
        timestamp: '2026-07-07T00:00:00.000Z',
      }),
    );
    const client = new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => key,
      getPinnedFreshnessCounter: () => 0,
      getHouseholdId: () => 'hh-1',
      reportDecryptOutcome: report,
    });
    const result = await client.bootstrap({ force: false });
    expect(result.workspaceSnapshot.aggregates).toEqual([]);
    expect(report).toHaveBeenCalledWith({
      quarantined: [{ aggregateId: 'agg-1', aggregateType: 'account', version: 1 }],
      resolved: [],
    });
  });

  it('bootstrap decrypts a genuine snapshot aggregate and a genuine post-snapshot mutation (regression)', async () => {
    const key = await genKey();
    // Deliberately distinct household ids so this test actually exercises
    // which source each half of bootstrap() binds into the AAD: the
    // snapshot half must bind `workspaceSnapshot.householdId`, the
    // post-snapshot half must bind the client's own `deps.getHouseholdId()`
    // — a swap between the two would fail to decrypt below.
    const snapshotHouseholdId = 'hh-snapshot';
    const clientHouseholdId = 'hh-client';
    const snapshotEnvelope = await encryptPayload(
      { name: 'Checking', balance: 100 },
      {
        householdId: snapshotHouseholdId,
        aggregateId: 'agg-1',
        aggregateType: 'account',
        encryptionVersion: 1,
      },
      key,
      snapshotHouseholdId,
    );
    const mutationEnvelope = await encryptPayload(
      { name: 'Savings', balance: 50 },
      {
        householdId: clientHouseholdId,
        aggregateId: 'agg-2',
        aggregateType: 'account',
        encryptionVersion: 1,
      },
      key,
      clientHouseholdId,
    );
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: null,
        workspaceSnapshot: {
          householdId: snapshotHouseholdId,
          aggregates: [
            {
              id: 'agg-1',
              householdId: snapshotHouseholdId,
              schemaVersion: 1,
              version: 1,
              updatedAt: '2026-07-07T00:00:00.000Z',
              deviceId: 'dev-1',
              aggregateType: 'account',
              payload: snapshotEnvelope,
            },
          ],
        },
        postSnapshotMutations: [
          {
            aggregateId: 'agg-2',
            aggregateType: 'account',
            operation: 'create',
            payload: mutationEnvelope,
            version: 1,
            schemaVersion: 1,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
          },
        ],
        syncCursor: '9',
        timestamp: '2026-07-07T00:00:00.000Z',
      }),
    );
    const result = await clientWithHdk(key, clientHouseholdId).bootstrap({ force: false });
    expect(result.workspaceSnapshot.aggregates[0]!.payload).toEqual({
      name: 'Checking',
      balance: 100,
    });
    expect(result.postSnapshotMutations[0]!.payload).toEqual({
      name: 'Savings',
      balance: 50,
    });
  });
});

describe('HttpSyncClient — pull/bootstrap wire-schema validation (@retirement/contracts)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.mockReset();
    // The boundary parse warns-and-degrades; assert on it explicitly.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  // No getHdk → dark path: no decrypt / freshness, so pull/bootstrap return the
  // parsed body straight from the boundary. Isolates the schema-validation step.
  function darkClient(): HttpSyncClient {
    return new HttpSyncClient({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
    });
  }

  const validChange = {
    aggregateId: 'agg-1',
    aggregateType: 'account',
    operation: 'create' as const,
    payload: { name: 'Checking' },
    version: 1,
    schemaVersion: 1,
    updatedAt: '2026-07-07T00:00:00.000Z',
    deviceId: 'dev-1',
  };

  // (a) positive — a current valid pull envelope parses cleanly (no warning).
  it('applies a valid pull envelope unchanged and does not warn', async () => {
    const body = { changes: [validChange], newCursor: '5', hasMore: false };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().pull({ since: '0' });

    expect(result).toEqual(body);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // (a) positive — a current valid bootstrap envelope parses cleanly.
  it('applies a valid bootstrap envelope unchanged and does not warn', async () => {
    const body = {
      snapshotId: null,
      workspaceSnapshot: {
        householdId: 'hh-1',
        aggregates: [
          {
            id: 'agg-1',
            householdId: 'hh-1',
            schemaVersion: 1,
            version: 3,
            updatedAt: '2026-07-07T00:00:00.000Z',
            deviceId: 'dev-1',
            aggregateType: 'account',
            payload: { name: 'Checking' },
          },
        ],
      },
      postSnapshotMutations: [validChange],
      syncCursor: '9',
      timestamp: '2026-07-07T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().bootstrap({ force: false });

    expect(result).toEqual(body);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // (b) negative — an unknown `aggregateType` must NOT hard-fail the pull; the
  // existing warn-and-skip in SyncContext (a separate, working code path) owns
  // it. The schema keeps `aggregateType` a plain string, so the row passes the
  // boundary untouched and the sync cycle is never aborted here.
  it('does not hard-fail a pull carrying an unknown aggregateType', async () => {
    const body = {
      changes: [{ ...validChange, aggregateType: 'retiredMysteryType' }],
      newCursor: '5',
      hasMore: false,
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().pull({ since: '0' });

    expect(result.changes[0]!.aggregateType).toBe('retiredMysteryType');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // (c) a known-type envelope with an unexpected EXTRA field still applies. The
  // extra field doesn't fail validation, and the original body is returned so
  // the field survives for any downstream consumer.
  it('applies a known-type envelope carrying an unexpected extra field', async () => {
    const body = {
      changes: [{ ...validChange, surpriseFutureField: 'keep-me' }],
      newCursor: '5',
      hasMore: false,
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().pull({ since: '0' });

    expect(
      (result.changes[0] as unknown as Record<string, unknown>).surpriseFutureField,
    ).toBe('keep-me');
  });

  // (c) a known-type field DRIFT (a required field retyped) fails safeParse but
  // must DEGRADE — warn and still apply — never throw-and-abort the sync cycle.
  it('degrades (warns, still applies, never throws) on a known-type field drift', async () => {
    const body = {
      // `version` retyped string→ genuine known-type drift that safeParse rejects.
      changes: [{ ...validChange, version: 'not-a-number' }],
      newCursor: '5',
      hasMore: false,
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().pull({ since: '0' });

    // A diagnostic warning was emitted (drift is observable)...
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]![0])).toContain('field-permissive degrade');
    // ...but the pull was NOT aborted — the change is still applied as-is.
    expect(result.changes[0]!.aggregateId).toBe('agg-1');
    expect((result.changes[0] as unknown as Record<string, unknown>).version).toBe(
      'not-a-number',
    );
  });

  // (c) a MISSING OPTIONAL field (freshnessHead absent) is not drift — it parses
  // cleanly and applies with no warning.
  it('applies a bootstrap envelope missing the optional freshnessHead without warning', async () => {
    const body = {
      snapshotId: null,
      workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
      postSnapshotMutations: [],
      syncCursor: '9',
      timestamp: '2026-07-07T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, body));

    const result = await darkClient().bootstrap({ force: false });

    expect(result).toEqual(body);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('createExportSyncTransport', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads bootstrap + pull via GET (never pushes) and rides the cookie', async () => {
    const { createExportSyncTransport } = await import('./sync-client');
    const transport = createExportSyncTransport({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'access-tok',
      getCsrfToken: () => 'csrf-tok',
      refreshAccessToken: vi.fn(),
      getHdk: () => null,
      householdId: 'hh-1',
    });

    fetchMock
      .mockResolvedValueOnce(
        makeResponse(200, {
          snapshotId: null,
          workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
          postSnapshotMutations: [],
          syncCursor: '9',
          timestamp: '2026-07-07T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(makeResponse(200, { changes: [], newCursor: '9', hasMore: false }));

    const boot = await transport.bootstrap({ force: true });
    const pull = await transport.pull({ since: boot.syncCursor });

    expect(pull.hasMore).toBe(false);
    // Both legs are GETs that include credentials (the export-authorization
    // cookie), and no POST /sync/push is ever issued.
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('GET');
      expect(init.credentials).toBe('include');
      expect(String(call[0])).not.toContain('/sync/push');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The export-bundle path deliberately
  // never retries (server-data-export.ts's bootstrap/pull loop must fail
  // visibly rather than continue from a partial baseline), but a served
  // Retry-After must still survive on the SyncApiError this transport
  // throws — the wait-notice countdown is raised from exactly this value.
  it('carries a parsed Retry-After on a SyncApiError thrown out of the export transport', async () => {
    const { createExportSyncTransport } = await import('./sync-client');
    const transport = createExportSyncTransport({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'access-tok',
      getCsrfToken: () => 'csrf-tok',
      refreshAccessToken: vi.fn(),
      getHdk: () => null,
      householdId: 'hh-1',
    });

    fetchMock.mockResolvedValueOnce(
      makeResponse(
        429,
        { error: { code: 'UPSTREAM_ERROR', message: 'busy' } },
        { 'Retry-After': '12' },
      ),
    );

    const err = await transport.bootstrap({ force: true }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.retryAfterMs).toBe(12_000);
  });
});

describe('HttpSyncClient decrypt quarantine', () => {
  const householdId = 'hh-quarantine';

  async function encryptedChange(
    hdk: CryptoKey,
    overrides: Partial<{
      aggregateId: string;
      aggregateType: string;
      version: number;
      corrupt: boolean;
    }> = {},
  ) {
    const aggregateId = overrides.aggregateId ?? 'agg-1';
    const aggregateType = overrides.aggregateType ?? 'account';
    const envelope = (await encryptPayload(
      { label: 'ok' },
      { householdId, aggregateId, aggregateType, encryptionVersion: 1 },
      hdk,
      householdId,
    )) as EncryptedPayloadEnvelope;
    if (overrides.corrupt) {
      // Flip the last base64url char of the ciphertext — GCM auth-tag
      // verification fails, throwing PayloadCryptoError (never a silent
      // wrong-plaintext decrypt).
      const flipped = envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith('A') ? 'B' : 'A');
      envelope.ciphertext = flipped;
    }
    return {
      aggregateId,
      aggregateType,
      operation: 'update' as const,
      payload: envelope,
      version: overrides.version ?? 1,
      schemaVersion: 1,
      updatedAt: '2026-09-02T00:00:00.000Z',
      deviceId: 'device-1',
    };
  }

  function depsWithHdk(hdk: CryptoKey, reportDecryptOutcome?: SyncClientDeps['reportDecryptOutcome']): SyncClientDeps {
    return {
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'tok',
      getCsrfToken: () => null,
      getHdk: () => hdk,
      getHouseholdId: () => householdId,
      reportDecryptOutcome,
    };
  }

  it('pull: a middle row that fails to decrypt is dropped, the others apply, and one quarantine entry is reported', async () => {
    const hdk = await generateHdk();
    const good1 = await encryptedChange(hdk, { aggregateId: 'agg-good-1' });
    const bad = await encryptedChange(hdk, { aggregateId: 'agg-bad', version: 7, corrupt: true });
    const good2 = await encryptedChange(hdk, { aggregateId: 'agg-good-2' });
    const report = vi.fn();
    const client = new HttpSyncClient(depsWithHdk(hdk, report));

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { changes: [good1, bad, good2], newCursor: '9', hasMore: false }),
    );

    const result = await client.pull({ since: '0' });

    expect(result.changes.map((c) => c.aggregateId)).toEqual(['agg-good-1', 'agg-good-2']);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      quarantined: [{ aggregateId: 'agg-bad', aggregateType: 'account', version: 7 }],
      resolved: [
        { aggregateId: 'agg-good-1', aggregateType: 'account' },
        { aggregateId: 'agg-good-2', aggregateType: 'account' },
      ],
    });
  });

  it('bootstrap: a poisoned snapshot aggregate row is dropped, the rest of the snapshot applies', async () => {
    const hdk = await generateHdk();
    const good = await encryptedChange(hdk, { aggregateId: 'agg-good' });
    const bad = await encryptedChange(hdk, { aggregateId: 'agg-bad', version: 3, corrupt: true });
    const report = vi.fn();
    const client = new HttpSyncClient(depsWithHdk(hdk, report));

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: 'snap-1',
        workspaceSnapshot: {
          householdId,
          aggregates: [
            { id: good.aggregateId, householdId, schemaVersion: 1, version: 1, updatedAt: good.updatedAt, deviceId: 'd', aggregateType: good.aggregateType, payload: good.payload },
            { id: bad.aggregateId, householdId, schemaVersion: 1, version: 3, updatedAt: bad.updatedAt, deviceId: 'd', aggregateType: bad.aggregateType, payload: bad.payload },
          ],
        },
        postSnapshotMutations: [],
        syncCursor: '9',
        timestamp: '2026-09-02T00:00:00.000Z',
      }),
    );

    const result = await client.bootstrap({ force: true });

    expect(result.workspaceSnapshot.aggregates.map((a) => a.id)).toEqual(['agg-good']);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        quarantined: [{ aggregateId: 'agg-bad', aggregateType: 'account', version: 3 }],
      }),
    );
    // The quarantined rows' identities
    // are also returned directly on the result, not only through the
    // fire-and-forget `reportDecryptOutcome` side channel, so a `clearFirst`
    // applier can carry each one's last readable local copy across its wipe.
    expect(result.quarantined).toEqual([
      { aggregateId: 'agg-bad', aggregateType: 'account', version: 3 },
    ]);
  });

  it('bootstrap: a poisoned post-snapshot mutation row is dropped, the snapshot itself still applies', async () => {
    const hdk = await generateHdk();
    const bad = await encryptedChange(hdk, { aggregateId: 'agg-bad-mut', version: 5, corrupt: true });
    const report = vi.fn();
    const client = new HttpSyncClient(depsWithHdk(hdk, report));

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: 'snap-1',
        workspaceSnapshot: { householdId, aggregates: [] },
        postSnapshotMutations: [bad],
        syncCursor: '9',
        timestamp: '2026-09-02T00:00:00.000Z',
      }),
    );

    const result = await client.bootstrap({ force: true });

    expect(result.postSnapshotMutations).toEqual([]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        quarantined: [{ aggregateId: 'agg-bad-mut', aggregateType: 'account', version: 5 }],
      }),
    );
  });

  it('bootstrap: quarantined is empty when every row decrypts cleanly', async () => {
    const hdk = await generateHdk();
    const good = await encryptedChange(hdk, { aggregateId: 'agg-good' });
    const report = vi.fn();
    const client = new HttpSyncClient(depsWithHdk(hdk, report));

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: 'snap-1',
        workspaceSnapshot: {
          householdId,
          aggregates: [
            { id: good.aggregateId, householdId, schemaVersion: 1, version: 1, updatedAt: good.updatedAt, deviceId: 'd', aggregateType: good.aggregateType, payload: good.payload },
          ],
        },
        postSnapshotMutations: [],
        syncCursor: '9',
        timestamp: '2026-09-02T00:00:00.000Z',
      }),
    );

    const result = await client.bootstrap({ force: true });

    expect(result.quarantined).toEqual([]);
  });

  it('createExportSyncTransport: a quarantined row rejects the whole export instead of silently omitting it', async () => {
    const { createExportSyncTransport } = await import('./sync-client');
    const hdk = await generateHdk();
    const bad = await encryptedChange(hdk, { aggregateId: 'agg-bad', version: 3, corrupt: true });
    const transport = createExportSyncTransport({
      apiBaseUrl: 'http://localhost:3001',
      getAccessToken: () => 'access-tok',
      getCsrfToken: () => 'csrf-tok',
      getHdk: () => hdk,
      householdId,
    });

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        snapshotId: 'snap-1',
        workspaceSnapshot: {
          householdId,
          aggregates: [
            { id: bad.aggregateId, householdId, schemaVersion: 1, version: 3, updatedAt: bad.updatedAt, deviceId: 'd', aggregateType: bad.aggregateType, payload: bad.payload },
          ],
        },
        postSnapshotMutations: [],
        syncCursor: '9',
        timestamp: '2026-09-02T00:00:00.000Z',
      }),
    );

    await expect(transport.bootstrap({ force: true })).rejects.toThrow(/Export blocked/);
  });

  it('a freshness rollback in the same response still rejects the whole call, never quarantines', async () => {
    const hdk = await generateHdk();
    const good = await encryptedChange(hdk, { aggregateId: 'agg-good' });
    const report = vi.fn();
    const client = new HttpSyncClient({
      ...depsWithHdk(hdk, report),
      getPinnedFreshnessCounter: () => 5,
    });

    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        changes: [good],
        newCursor: '9',
        hasMore: false,
        freshnessHead: { freshnessCounter: 1, cursorTag: 'bogus' },
      }),
    );

    await expect(client.pull({ since: '0' })).rejects.toBeInstanceOf(FreshnessRollbackError);
    expect(report).not.toHaveBeenCalled();
  });
});
