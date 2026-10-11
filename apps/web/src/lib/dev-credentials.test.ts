/**
 * Dev-credential prefill tests.
 *
 * The module computes the prefill decision once at load from the browser
 * host + build mode, so each case stubs both, resets the module registry,
 * then dynamically imports a fresh copy. Covers: DEV + localhost/127.0.0.1
 * prefill; DEV + RFC1918 private IPv4 prefill; DEV + public host → blank;
 * non-DEV + private IP → blank; non-DEV + localhost → blank (the build-mode
 * gate strips the seeded literals from a production bundle).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModule(opts: {
  dev: boolean;
  hostname: string;
}): Promise<typeof import('./dev-credentials.js')> {
  vi.resetModules();
  vi.stubEnv('DEV', opts.dev);
  vi.stubEnv('PROD', !opts.dev);
  vi.stubGlobal('window', {
    location: { hostname: opts.hostname },
  } as unknown as Window & typeof globalThis);
  return import('./dev-credentials.js');
}

describe('dev-credential prefill', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['localhost', '127.0.0.1'])(
    'prefills on %s under DEV mode',
    async (hostname) => {
      const mod = await loadModule({ dev: true, hostname });
      expect(mod.DEV_DEFAULT_EMAIL).toBe('dev@local.test');
      expect(mod.DEV_DEFAULT_PASSWORD).toBe('LocalDevPass1!');
    },
  );

  it.each(['localhost', '127.0.0.1'])(
    'stays blank on %s when not in DEV mode',
    async (hostname) => {
      const mod = await loadModule({ dev: false, hostname });
      expect(mod.DEV_DEFAULT_EMAIL).toBe('');
      expect(mod.DEV_DEFAULT_PASSWORD).toBe('');
    },
  );

  it.each(['192.168.1.42', '10.1.2.3', '172.16.0.9', '172.31.255.1'])(
    'prefills under DEV on RFC1918 private host %s',
    async (hostname) => {
      const mod = await loadModule({ dev: true, hostname });
      expect(mod.DEV_DEFAULT_EMAIL).toBe('dev@local.test');
      expect(mod.DEV_DEFAULT_PASSWORD).toBe('LocalDevPass1!');
    },
  );

  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', 'app.example.com'])(
    'stays blank under DEV on public / non-private host %s',
    async (hostname) => {
      const mod = await loadModule({ dev: true, hostname });
      expect(mod.DEV_DEFAULT_EMAIL).toBe('');
      expect(mod.DEV_DEFAULT_PASSWORD).toBe('');
    },
  );

  it('stays blank for a private IP when not in DEV mode', async () => {
    const mod = await loadModule({ dev: false, hostname: '192.168.1.42' });
    expect(mod.DEV_DEFAULT_EMAIL).toBe('');
    expect(mod.DEV_DEFAULT_PASSWORD).toBe('');
  });
});
