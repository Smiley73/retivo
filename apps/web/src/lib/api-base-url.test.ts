/**
 * API base URL resolution tests.
 *
 * The module resolves `API_BASE_URL` once at load, so each case stubs the
 * env + browser host, resets the module registry, then dynamically imports
 * a fresh copy. Covers: explicit env wins; dev + blank → derive from the
 * browser host (localhost and LAN); prod + missing → throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModule(opts: {
  apiBaseUrl?: string;
  dev: boolean;
  hostname: string;
}): Promise<typeof import('./api-base-url.js')> {
  vi.resetModules();
  if (opts.apiBaseUrl === undefined) {
    vi.stubEnv('VITE_API_BASE_URL', undefined as unknown as string);
  } else {
    vi.stubEnv('VITE_API_BASE_URL', opts.apiBaseUrl);
  }
  vi.stubEnv('DEV', opts.dev);
  vi.stubEnv('PROD', !opts.dev);
  vi.stubGlobal('window', {
    location: { hostname: opts.hostname },
  } as unknown as Window & typeof globalThis);
  return import('./api-base-url.js');
}

describe('API_BASE_URL resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses an explicit VITE_API_BASE_URL verbatim in dev', async () => {
    const mod = await loadModule({
      apiBaseUrl: 'http://192.168.1.42:9000',
      dev: true,
      hostname: 'localhost',
    });
    expect(mod.API_BASE_URL).toBe('http://192.168.1.42:9000');
  });

  it('uses an explicit VITE_API_BASE_URL verbatim in prod', async () => {
    const mod = await loadModule({
      apiBaseUrl: 'https://api.example.com',
      dev: false,
      hostname: 'app.example.com',
    });
    expect(mod.API_BASE_URL).toBe('https://api.example.com');
  });

  it('derives localhost:3001 in dev when blank and host is localhost', async () => {
    const mod = await loadModule({
      apiBaseUrl: '',
      dev: true,
      hostname: 'localhost',
    });
    expect(mod.API_BASE_URL).toBe('http://localhost:3001');
  });

  it('derives <lan-ip>:3001 in dev when blank and host is a LAN address', async () => {
    const mod = await loadModule({
      apiBaseUrl: '',
      dev: true,
      hostname: '192.168.1.42',
    });
    expect(mod.API_BASE_URL).toBe('http://192.168.1.42:3001');
  });

  it('derives from the browser host in dev when the var is missing', async () => {
    const mod = await loadModule({
      apiBaseUrl: undefined,
      dev: true,
      hostname: '10.0.0.5',
    });
    expect(mod.API_BASE_URL).toBe('http://10.0.0.5:3001');
  });

  it('returns same-origin "" in prod when blank', async () => {
    const mod = await loadModule({
      apiBaseUrl: '',
      dev: false,
      hostname: 'app.example.com',
    });
    expect(mod.API_BASE_URL).toBe('');
  });

  it('throws in prod when the var is missing', async () => {
    await expect(
      loadModule({ apiBaseUrl: undefined, dev: false, hostname: 'app.example.com' }),
    ).rejects.toThrow(/VITE_API_BASE_URL is not set/);
  });
});
