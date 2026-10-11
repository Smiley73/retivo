/**
 * Shared test helper: default stubs for the card-mount-effect surfaces that
 * `useAuth()` now exposes and the Security page's cards call on mount —
 * `TwoFactorCard` (`getMfaStatus()` / `listTrustedDevices()`)
 * and `AccountCard` (`fetchAccountRecord()` → `GET /auth/me`).
 * Without these defaults the cards throw / surface
 * a load-error Alert that pollutes unrelated `getByRole('alert')` assertions.
 * Spread this into each `renderPage` mock before `...overrides` so a test can
 * still override any single method.
 */
import { vi } from 'vitest';

export function mfaAuthDefaults() {
  return {
    mfaChallenge: null,
    verifyMfa: vi.fn().mockResolvedValue({ deviceRemembered: false }),
    sendEmailOtp: vi.fn().mockResolvedValue(undefined),
    clearMfaChallenge: vi.fn(),
    getMfaStatus: vi
      .fn()
      .mockResolvedValue({ totpEnabled: false }),
    enrollTotpStart: vi
      .fn()
      .mockResolvedValue({ secret: 'SECRET', otpauthUrl: 'otpauth://totp/x' }),
    enrollTotpConfirm: vi.fn().mockResolvedValue({ totpEnabled: true }),
    disableTotp: vi.fn().mockResolvedValue({ totpEnabled: false }),
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    forgetDevices: vi.fn().mockResolvedValue(undefined),
    // AccountCard mount-effect surface.
    fetchAccountRecord: vi
      .fn()
      .mockResolvedValue({ email: 'test@example.test' }),
    changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: false }),
    sendEmailChangeOtp: vi.fn().mockResolvedValue(undefined),
    verifyEmailChangeStepUp: vi.fn().mockResolvedValue({}),
    stepUpPasskeyOptions: vi
      .fn()
      .mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
    stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
  };
}
