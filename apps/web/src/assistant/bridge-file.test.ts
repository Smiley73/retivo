import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBridgeFile } from './bridge-file';

const SHA = 'a'.repeat(64);

function serve(body: unknown, init: { ok?: boolean; json?: () => Promise<unknown> } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: init.ok ?? true, json: init.json ?? (() => Promise.resolve(body)) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The manifest the hook settles on, or null when it ends unavailable. */
async function fetchBridgeFileInfo() {
  const { result } = renderHook(() => useBridgeFile(true));
  await waitFor(() => expect(result.current.status).not.toBe('loading'));
  return result.current.status === 'ready' ? result.current.info : null;
}

describe('fetchBridgeFileInfo', () => {
  it('reads the manifest from the app origin without cache or credentials', async () => {
    const fetchMock = serve({ version: '1.2.3', sha256: SHA, size: 1234 });
    expect(await fetchBridgeFileInfo()).toEqual({ version: '1.2.3', sha256: SHA, size: 1234 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/bridge.json');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
  });

  it('ignores fields it does not know', async () => {
    serve({ version: '0.0.0', sha256: SHA, size: 1, extra: 'x' });
    expect(await fetchBridgeFileInfo()).toEqual({ version: '0.0.0', sha256: SHA, size: 1 });
  });

  it('is null when the copy serves no manifest', async () => {
    serve(null, { ok: false });
    expect(await fetchBridgeFileInfo()).toBeNull();
  });

  it('is null when the answer is the app shell instead of JSON', async () => {
    serve(null, { json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
    expect(await fetchBridgeFileInfo()).toBeNull();
  });

  it('is null when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await fetchBridgeFileInfo()).toBeNull();
  });

  it.each([
    ['a null body', null],
    ['a string body', 'x'],
    ['no checksum', { version: '1.0.0', size: 10 }],
    ['a short checksum', { version: '1.0.0', sha256: 'a'.repeat(63), size: 10 }],
    ['an uppercase checksum', { version: '1.0.0', sha256: 'A'.repeat(64), size: 10 }],
    ['a checksum with shell syntax', { version: '1.0.0', sha256: `${'a'.repeat(54)};rm -rf /`, size: 10 }],
    ['a version with shell syntax', { version: '1.0.0;rm', sha256: SHA, size: 10 }],
    ['no version', { sha256: SHA, size: 10 }],
    ['a zero size', { version: '1.0.0', sha256: SHA, size: 0 }],
    ['a fractional size', { version: '1.0.0', sha256: SHA, size: 1.5 }],
    ['a size as text', { version: '1.0.0', sha256: SHA, size: '10' }],
    ['an absurd size', { version: '1.0.0', sha256: SHA, size: 10 ** 12 }],
  ])('is null for %s', async (_name, body) => {
    serve(body);
    expect(await fetchBridgeFileInfo()).toBeNull();
  });
});

describe('useBridgeFile', () => {
  it('goes from loading to ready', async () => {
    serve({ version: '1.0.0', sha256: SHA, size: 10 });
    const { result } = renderHook(() => useBridgeFile(true));
    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', info: { version: '1.0.0', sha256: SHA, size: 10 } }));
  });

  it('goes from loading to unavailable', async () => {
    serve(null, { ok: false });
    const { result } = renderHook(() => useBridgeFile(true));
    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }));
  });

  it('does not fetch while disabled', () => {
    const fetchMock = serve({ version: '1.0.0', sha256: SHA, size: 10 });
    renderHook(() => useBridgeFile(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
