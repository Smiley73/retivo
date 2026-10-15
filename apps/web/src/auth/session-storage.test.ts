import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepLegacySignupProfileKeys } from './session-storage';

const PREFIX = 'retivo:signup-profile:';

describe('sweepLegacySignupProfileKeys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('removes every signup-profile key and leaves all other keys with their values', () => {
    const survivors: Record<string, string> = {
      'retivo:blocked-reset:pending': 'u-1',
      'retivo:household-ready-banner-pending:hh-1': '1',
      'retivo:household-ready-banner-dismissed:hh-1': '1',
      'retivo:primary-member-seeded:hh-1': '1',
      'retivo.auth.email': 'me@example.test',
      'retivo.auth.deviceId': 'dev-1',
      // Near misses: not under the exact prefix.
      'retivo:signup-profile': 'no-colon-suffix',
      'x-retivo:signup-profile:u-9': 'prefixed-elsewhere',
    };
    for (const [k, v] of Object.entries(survivors)) localStorage.setItem(k, v);
    // Many adjacent matches: removing while iterating by index would skip some.
    for (let i = 0; i < 12; i += 1) localStorage.setItem(`${PREFIX}u-${i}`, 'x');

    sweepLegacySignupProfileKeys();

    expect(localStorage.length).toBe(Object.keys(survivors).length);
    for (const [k, v] of Object.entries(survivors)) expect(localStorage.getItem(k)).toBe(v);
  });

  it('is a no-op when there is nothing to remove', () => {
    localStorage.setItem('retivo.auth.email', 'me@example.test');

    sweepLegacySignupProfileKeys();

    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('retivo.auth.email')).toBe('me@example.test');
  });

  it('never reads the value of a matching key', () => {
    localStorage.setItem(`${PREFIX}u-1`, 'secret-1');
    localStorage.setItem(`${PREFIX}u-2`, 'secret-2');
    localStorage.setItem('retivo.auth.email', 'me@example.test');
    // Wrap the real storage: spying on the instance would add own properties
    // that some Storage implementations report as keys.
    const real = localStorage;
    const getItem = vi.fn((key: string) => real.getItem(key));
    vi.stubGlobal('localStorage', {
      get length() {
        return real.length;
      },
      key: (i: number) => real.key(i),
      getItem,
      removeItem: (key: string) => real.removeItem(key),
    });

    sweepLegacySignupProfileKeys();

    expect(getItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(real.length).toBe(1);
    expect(real.getItem('retivo.auth.email')).toBe('me@example.test');
  });

  it('returns silently when localStorage is absent', () => {
    vi.stubGlobal('localStorage', undefined);

    expect(() => sweepLegacySignupProfileKeys()).not.toThrow();
  });

  it('swallows storage access errors', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('SecurityError');
      },
    });

    expect(() => sweepLegacySignupProfileKeys()).not.toThrow();
  });
});
