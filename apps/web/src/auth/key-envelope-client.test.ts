import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from '../api/client';
import { getKeyEnvelopes, upsertKeyEnvelopeSlot } from './key-envelope-client';
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
    await upsertKeyEnvelopeSlot('slot-pw', {
      slot: sampleSlot,
      envelopeSetVersion: 1,
      envelopeSetTag: 'dGFn',
    });
    expect(lastRequestMethod(fetchSpy)).toBe('PUT');
    expect(lastRequestHeaders(fetchSpy)['X-CSRF-Token']).toBe(CSRF_VALUE);
  });

  it('sends expectedEnvelopeSetVersion = proposed - 1 on PUT (atomic slot+meta guard)', async () => {
    await upsertKeyEnvelopeSlot('slot-pw', {
      slot: sampleSlot,
      envelopeSetVersion: 3,
      envelopeSetTag: 'dGFn',
    });
    const sent = lastRequestBody(fetchSpy);
    expect(sent.envelopeSetVersion).toBe(3);
    expect(sent.expectedEnvelopeSetVersion).toBe(2);
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
    await upsertKeyEnvelopeSlot('a/b c', { slot: sampleSlot, envelopeSetVersion: 1, envelopeSetTag: 'x' });
    const url = fetchSpy.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain('/api/v1/auth/key-envelopes/a%2Fb%20c');
  });
});
