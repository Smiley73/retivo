/**
 * Tests for the key-envelope HTTP client. Every new state-changing client
 * call must be proven to attach the `X-CSRF-Token` header before merge
 * (AGENTS.md, "Project-specific security").
 *
 * Drives the real `apiRequest` transport against a stubbed `fetch` + a
 * `csrf-token` cookie, so the assertion exercises the production header path
 * end-to-end rather than a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from '../api/client';
import {
  deleteKeyEnvelopeSlot,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  type UpsertKeyEnvelopeSlotBody,
} from './key-envelope-client';
import type { KeyEnvelopeSlot } from '../crypto/encryption-types';

const CSRF_VALUE = 'csrf-abc-123';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastRequestHeaders(fetchSpy: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

function lastRequestMethod(fetchSpy: ReturnType<typeof vi.fn>): string | undefined {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return init?.method;
}

function lastRequestBody(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
}

const sampleSlot: KeyEnvelopeSlot = {
  householdId: 'hh-1',
  slotId: 'slot-pw',
  slotType: 'password',
  wrappedKey: 'd3JhcA',
  encryptionVersion: 1,
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
};

describe('key-envelope-client', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // A readable (non-HttpOnly) csrf-token cookie, as the API sets on login.
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `csrf-token=${CSRF_VALUE}`,
    });
    fetchSpy = vi.fn(async () => jsonResponse(undefined, 204));
    vi.stubGlobal('fetch', fetchSpy);
    configureApi({ getAccessToken: () => 'access-token', refreshAccessToken: async () => null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches X-CSRF-Token on PUT (upsert)', async () => {
    const body: UpsertKeyEnvelopeSlotBody = {
      slot: sampleSlot,
      envelopeSetVersion: 1,
      envelopeSetTag: 'dGFn',
    };
    await upsertKeyEnvelopeSlot('slot-pw', body);
    expect(lastRequestMethod(fetchSpy)).toBe('PUT');
    expect(lastRequestHeaders(fetchSpy)['X-CSRF-Token']).toBe(CSRF_VALUE);
  });

  it('sends expectedEnvelopeSetVersion = proposed - 1 on PUT (atomic slot+meta guard)', async () => {
    const body: UpsertKeyEnvelopeSlotBody = {
      slot: sampleSlot,
      envelopeSetVersion: 3,
      envelopeSetTag: 'dGFn',
    };
    await upsertKeyEnvelopeSlot('slot-pw', body);
    const sent = lastRequestBody(fetchSpy);
    expect(sent.envelopeSetVersion).toBe(3);
    expect(sent.expectedEnvelopeSetVersion).toBe(2);
  });

  it('attaches X-CSRF-Token on DELETE', async () => {
    await deleteKeyEnvelopeSlot('slot-pw', { envelopeSetVersion: 2, envelopeSetTag: 'dGFn' });
    expect(lastRequestMethod(fetchSpy)).toBe('DELETE');
    expect(lastRequestHeaders(fetchSpy)['X-CSRF-Token']).toBe(CSRF_VALUE);
  });

  it('sends expectedEnvelopeSetVersion = proposed - 1 on DELETE (atomic slot+meta guard)', async () => {
    await deleteKeyEnvelopeSlot('slot-pw', { envelopeSetVersion: 2, envelopeSetTag: 'dGFn' });
    const sent = lastRequestBody(fetchSpy);
    expect(sent.envelopeSetVersion).toBe(2);
    expect(sent.expectedEnvelopeSetVersion).toBe(1);
  });

  it('does not attach X-CSRF-Token on the GET read', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' }),
    );
    await getKeyEnvelopes();
    expect(lastRequestMethod(fetchSpy)).toBe('GET');
    expect(lastRequestHeaders(fetchSpy)['X-CSRF-Token']).toBeUndefined();
  });

  it('encodes the slotId into the request path', async () => {
    await deleteKeyEnvelopeSlot('a/b c', { envelopeSetVersion: 1, envelopeSetTag: 'x' });
    const url = fetchSpy.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain('/api/v1/auth/key-envelopes/a%2Fb%20c');
  });
});
