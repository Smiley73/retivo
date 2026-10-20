import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('readBridgePort', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  async function read(value: string | undefined): Promise<number | null> {
    if (value === undefined) vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', undefined as unknown as string);
    else vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', value);
    const { readBridgePort } = await import('./bridge-port');
    return readBridgePort();
  }

  it.each([undefined, '', '   '])('is null, with no warning, when unset or blank (%j)', async (value) => {
    expect(await read(value)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['24580', 24580],
    [' 24580 ', 24580],
    ['1024', 1024],
    ['65535', 65535],
  ])('reads %j', async (value, port) => {
    expect(await read(value)).toBe(port);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['1023', '65536', '0', '-1', '24580.5', 'abc', '2458e1', '0x5000', '24 580'])(
    'is null with one warning for %j',
    async (value) => {
      vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', value);
      const { readBridgePort } = await import('./bridge-port');
      expect(readBridgePort()).toBeNull();
      expect(readBridgePort()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});
