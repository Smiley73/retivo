// PasswordValidatorService's always-on HIBP check: a breached password is PASSWORD_PWNED, and the check fails open on network error, timeout or non-200
// while the local common-passwords check still rejects.
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { COMMON_PASSWORDS } from './data/common-passwords.js';
import { HibpClient } from './hibp-client.js';
import { PasswordValidatorService } from './password-validator.service.js';

// Policy-passing, so only the HIBP branch can reject it.
const STRONG_UNIQUE_PASSWORD = 'Zq7vKp2mWx9rLt4n!';
// Policy-passing, but its lowercase form is in the synthetic common-passwords set injected for one test; the complexity check runs on the original while the common-set lookup is case-insensitive.
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
    const fifteen = 'Zq7vKp2mWx4n!Rt';
    expect(fifteen).toHaveLength(15);
    const err = await service.validate(fifteen).catch((e: unknown) => e);
    expect(pwnedCodeOf(err)).toBe('PASSWORD_TOO_SHORT');
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message: 'Password must be at least 16 characters.',
    });
  });

  it('rejects a 16+ character password missing a special character with PASSWORD_WEAK', async () => {
    const service = new PasswordValidatorService(
      acceptingHibp as unknown as HibpClient,
    );
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
      // Restores the COMMON_PASSWORDS.has spy so other tests keep the real dataset.
      jest.restoreAllMocks();
    });

    it('accepts a strong password when the HIBP request errors', async () => {
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
      // No shipped entry is both 16+ chars and carries a special character, so a synthetic match is injected by spying on COMMON_PASSWORDS' `has` for this test only; the lookup lowercases, so the spy matches the lowercased form.
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
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
