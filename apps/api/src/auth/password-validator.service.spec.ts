/**
 * Unit tests for PasswordValidatorService — the always-on HIBP breach check.
 *
 * Pins the post-flag behaviour:
 *   - The HIBP breach check runs on every validate() with no env flag (the
 *     removed HIBP_CHECK_ENABLED gate). A breached password → PASSWORD_PWNED.
 *   - The check fails open: when the HIBP call cannot complete (network
 *     error / timeout / non-200), the password is NOT rejected on that basis,
 *     while the local common-passwords check still rejects a known-weak one.
 *
 * No real network call is made: the "runs / rejects" cases stub
 * `HibpClient.isPwned`; the fail-open cases drive the real `HibpClient`
 * against a stubbed global `fetch` so the documented outage behaviour
 * (returns false) is exercised end-to-end.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { COMMON_PASSWORDS } from './data/common-passwords.js';
import { HibpClient } from './hibp-client.js';
import { PasswordValidatorService } from './password-validator.service.js';

// Strong, unique, policy-passing password (≥16 chars, upper + lower + digit +
// special, not in the common-passwords set) so only the HIBP branch can reject
// it.
const STRONG_UNIQUE_PASSWORD = 'Zq7vKp2mWx9rLt4n!';
// Policy-passing length + complexity (16 chars, upper + lower + digit +
// special), but its lowercase form is in the synthetic common-passwords set
// injected for that one test → must still be rejected as PASSWORD_TOO_COMMON
// regardless of HIBP availability. The complexity check runs on the original
// password (so it needs an uppercase), while the common-set lookup is
// case-insensitive (`password.toLowerCase()`).
const COMMON_PASSWORD = 'CommonPassword1!';

function pwnedCodeOf(err: unknown): string | undefined {
  if (err instanceof BadRequestException) {
    const res = err.getResponse() as { code?: string };
    return res.code;
  }
  return undefined;
}

describe('PasswordValidatorService — length and complexity policy', () => {
  const acceptingHibp = { isPwned: jest.fn().mockResolvedValue(false) };

  it('rejects a 15-character password with PASSWORD_TOO_SHORT', async () => {
    const service = new PasswordValidatorService(
      acceptingHibp as unknown as HibpClient,
    );
    // 15 chars, otherwise fully compliant (upper + lower + digit + special).
    const fifteen = 'Zq7vKp2mWx4n!Rt';
    expect(fifteen).toHaveLength(15);
    const err = await service.validate(fifteen).catch((e: unknown) => e);
    expect(pwnedCodeOf(err)).toBe('PASSWORD_TOO_SHORT');
    // The updated minimum (16) is surfaced in the message.
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message: 'Password must be at least 16 characters.',
    });
  });

  it('rejects a 16+ character password missing a special character with PASSWORD_WEAK', async () => {
    const service = new PasswordValidatorService(
      acceptingHibp as unknown as HibpClient,
    );
    // 16 chars with upper + lower + digit but NO special character.
    const noSpecial = 'Zq7vKp2mWx9rLt4n';
    expect(noSpecial).toHaveLength(16);
    const err = await service.validate(noSpecial).catch((e: unknown) => e);
    expect(pwnedCodeOf(err)).toBe('PASSWORD_WEAK');
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message:
        'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character.',
    });
  });

  it('accepts a compliant 16+ character password with a special character', async () => {
    const service = new PasswordValidatorService(
      acceptingHibp as unknown as HibpClient,
    );
    await expect(service.validate(STRONG_UNIQUE_PASSWORD)).resolves.toBeUndefined();
  });
});

describe('PasswordValidatorService — always-on HIBP breach check', () => {
  describe('breach check runs with no env flag', () => {
    it('rejects a breached password with PASSWORD_PWNED', async () => {
      const hibp = { isPwned: jest.fn().mockResolvedValue(true) };
      const service = new PasswordValidatorService(hibp as unknown as HibpClient);

      await expect(service.validate(STRONG_UNIQUE_PASSWORD)).rejects.toMatchObject({
        response: { code: 'PASSWORD_PWNED' },
      });
      // The check ran without any env flag gating it.
      expect(hibp.isPwned).toHaveBeenCalledWith(STRONG_UNIQUE_PASSWORD);
    });

    it('accepts a non-breached password (the check ran and passed)', async () => {
      const hibp = { isPwned: jest.fn().mockResolvedValue(false) };
      const service = new PasswordValidatorService(hibp as unknown as HibpClient);

      await expect(service.validate(STRONG_UNIQUE_PASSWORD)).resolves.toBeUndefined();
      expect(hibp.isPwned).toHaveBeenCalledWith(STRONG_UNIQUE_PASSWORD);
    });
  });

  describe('fails open on HIBP unavailability (no real network call)', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
      // Restores the COMMON_PASSWORDS.has spy the common-password case installs
      // so every other test keeps the real, unmocked dataset.
      jest.restoreAllMocks();
    });

    it('accepts a strong password when the HIBP request errors', async () => {
      // Real client, but the network layer rejects — its catch fails open.
      globalThis.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
      const service = new PasswordValidatorService(new HibpClient());

      await expect(
        service.validate(STRONG_UNIQUE_PASSWORD),
      ).resolves.toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('accepts a strong password when the HIBP request aborts (timeout)', async () => {
      // Simulate the AbortController timeout path: fetch rejects with an
      // AbortError, which the client's catch also fails open on.
      globalThis.fetch = jest.fn().mockImplementation(() => {
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        return Promise.reject(abort);
      }) as unknown as typeof fetch;
      const service = new PasswordValidatorService(new HibpClient());

      await expect(
        service.validate(STRONG_UNIQUE_PASSWORD),
      ).resolves.toBeUndefined();
    });

    it('still rejects a known-weak password locally even when HIBP is down', async () => {
      // Even with HIBP unreachable, the local common-passwords check is the
      // primary defense and rejects before the HIBP call is ever reached.
      // No real entry in the shipped dataset is both 16+ chars and carries a
      // special character, so inject a synthetic common-passwords match scoped
      // to just this test by spying on the shared `COMMON_PASSWORDS` set's
      // `has` (restored via jest.restoreAllMocks() in afterEach so every other
      // test keeps the real dataset). `COMMON_PASSWORD` clears the new
      // length/complexity gates (16 chars, upper + lower + digit + special),
      // and the lookup lowercases it — so the spy matches the lowercased form
      // and validation reaches the common-passwords check.
      const hasSpy = jest
        .spyOn(COMMON_PASSWORDS, 'has')
        .mockImplementation((pw: string) => pw === COMMON_PASSWORD.toLowerCase());
      const fetchSpy = jest
        .fn()
        .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
      globalThis.fetch = fetchSpy;
      const service = new PasswordValidatorService(new HibpClient());

      const err = await service.validate(COMMON_PASSWORD).catch((e: unknown) => e);
      expect(pwnedCodeOf(err)).toBe('PASSWORD_TOO_COMMON');
      expect(hasSpy).toHaveBeenCalledWith(COMMON_PASSWORD.toLowerCase());
      // Local check short-circuits before any HIBP request.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
