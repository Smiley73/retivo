/**
 * Authenticated MFA-management API surface (enforced MFA), split
 * out of AuthContext.tsx so that file does not grow past its recorded
 * shape-limit exception. These are thin `apiRequest` wrappers
 * over the guarded `/auth/mfa/*` management endpoints; they carry
 * no auth state of their own (the access token + CSRF cookie travel through the
 * shared `apiRequest` client), so a plain hook returning stable callbacks is
 * the whole surface. AuthContext re-exports the hook's methods through context;
 * the Security 2FA card consumes them via `useAuth()`.
 *
 * The endpoint paths + request/response shapes mirror the API controller
 * (apps/api/src/auth/auth.controller.ts) exactly:
 *   - GET    /auth/mfa/status                  → { totpEnabled, ... }
 *   - POST   /auth/mfa/totp/enroll/start       → { secret, otpauthUrl }
 *   - POST   /auth/mfa/totp/enroll/confirm     { code }            → { totpEnabled, noticeSent }
 *   - POST   /auth/mfa/totp/disable            { currentPassword } → { totpEnabled, noticeSent }
 *   - GET    /auth/mfa/trusted-devices         → { devices: [...] }
 *   - POST   /auth/mfa/trusted-devices/forget  { deviceIds? }      → 204
 */
import { useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';
import { stepUpProofFields, type StepUpProof } from '../components/useStepUp';

/** Current MFA factor status for the management UI (no secret material). */
export interface MfaStatus {
  totpEnabled: boolean;
  /** ISO timestamp the TOTP factor was enrolled, when enabled. */
  enrolledAt?: string;
  /** ISO timestamp of the last successful TOTP verify, when present. */
  lastVerifiedAt?: string;
  /**
   * True when a fresh second-factor step-up is required before a sensitive
   * operation (= `AUTH_MFA_ENFORCED`). The destructive-op cards read this to
   * decide whether to open the reusable step-up modal.
   */
  stepUpRequired?: boolean;
  /** Eligible routine step-up factors (strongest first), when `stepUpRequired`. */
  methods?: string[];
  /** Eligible recovery step-up factors, when `stepUpRequired`. */
  recoveryMethods?: string[];
  /** True while the TOTP factor is restricted post-reset — needs a confirm-restriction lift (or removal) before it can be
   * used to sign in or approve changes. */
  totpRestrictedPostReset?: boolean;
}

/** A trusted (remember-this-device) row, display-safe fields only. */
export interface TrustedDevice {
  /** The stable client deviceId — the row's sort key. */
  deviceId: string;
  /** ISO timestamp the device was first trusted. */
  createdAt: string;
  /** ISO timestamp the trust window lapses (~30 days out). */
  expiresAt: string;
  /** ISO timestamp the trust was last exercised at sign-in, when present. */
  lastUsedAt?: string | null;
  /** Best-effort client IP recorded at trust time. */
  ip?: string | null;
  /** Best-effort user-agent recorded at trust time. */
  userAgent?: string | null;
}

/** The management methods AuthContext threads through context. */
export interface MfaManagement {
  /** Read the current authenticator status for the management card. */
  getMfaStatus(): Promise<MfaStatus>;
  /** Begin TOTP enrollment: returns the base32 secret + the otpauth URL. */
  enrollTotpStart(): Promise<{ secret: string; otpauthUrl: string }>;
  /** Confirm enrollment with a live code; promotes the pending secret. The
   * write is gated: the account password is
   * always re-verified, and a fresh second factor `proof` is required on top
   * when `AUTH_MFA_ENFORCED` is on. `noticeSent`:
   * whether the server's factor-change notice mail actually went out — the
   * card only claims "we emailed you" when it did. */
  enrollTotpConfirm(
    code: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ totpEnabled: boolean; noticeSent: boolean }>;
  /** Disable TOTP behind a password re-verify (+ a fresh step-up factor when
   * `AUTH_MFA_ENFORCED` is on). Resolves `noticeSent` — see `enrollTotpConfirm`. */
  disableTotp(
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ totpEnabled: boolean; noticeSent: boolean }>;
  /** Lift the TOTP factor's post-reset restriction — the proof must come from a different, already-enrolled,
   * non-restricted factor that predates the reset (`totp` or `passkey` only;
   * Email-OTP has no enrollment timestamp to vouch with). */
  confirmTotpRestriction(proof: StepUpProof): Promise<void>;
  /** List the caller's trusted devices. */
  listTrustedDevices(): Promise<TrustedDevice[]>;
  /** Forget devices by id, or every device when `deviceIds` is omitted. */
  forgetDevices(deviceIds?: string[]): Promise<void>;
}

/**
 * Returns the stable MFA-management callbacks. No internal state: every call is
 * a one-shot authenticated request, so the methods only depend on the shared
 * `apiRequest` client (which reads the in-memory access token + CSRF cookie).
 */
export function useMfaManagement(): MfaManagement {
  const getMfaStatus = useCallback(
    (): Promise<MfaStatus> => apiRequest<MfaStatus>('/api/v1/auth/mfa/status'),
    [],
  );

  const enrollTotpStart = useCallback(
    (): Promise<{ secret: string; otpauthUrl: string }> =>
      apiRequest('/api/v1/auth/mfa/totp/enroll/start', { method: 'POST' }),
    [],
  );

  const enrollTotpConfirm = useCallback(
    (
      code: string,
      currentPassword: string,
      proof?: StepUpProof,
    ): Promise<{ totpEnabled: boolean; noticeSent: boolean }> =>
      apiRequest('/api/v1/auth/mfa/totp/enroll/confirm', {
        method: 'POST',
        body: { code, stepUp: { currentPassword, ...stepUpProofFields(proof) } },
      }),
    [],
  );

  const disableTotp = useCallback(
    (
      currentPassword: string,
      proof?: StepUpProof,
    ): Promise<{ totpEnabled: boolean; noticeSent: boolean }> =>
      apiRequest('/api/v1/auth/mfa/totp/disable', {
        method: 'POST',
        body: { currentPassword, ...stepUpProofFields(proof) },
      }),
    [],
  );

  const confirmTotpRestriction = useCallback(
    (proof: StepUpProof): Promise<void> =>
      apiRequest('/api/v1/auth/mfa/totp/confirm-restriction', {
        method: 'POST',
        body: stepUpProofFields(proof),
      }),
    [],
  );

  const listTrustedDevices = useCallback(async (): Promise<TrustedDevice[]> => {
    const res = await apiRequest<{ devices: TrustedDevice[] }>(
      '/api/v1/auth/mfa/trusted-devices',
    );
    return res.devices;
  }, []);

  const forgetDevices = useCallback(async (deviceIds?: string[]): Promise<void> => {
    await apiRequest('/api/v1/auth/mfa/trusted-devices/forget', {
      method: 'POST',
      // Omit the body entirely when forgetting all so the server's
      // `deviceIds === undefined` branch (forget-all + drop the trust cookie)
      // fires; an explicit list forgets just those.
      ...(deviceIds ? { body: { deviceIds } } : {}),
    });
  }, []);

  return useMemo(
    () => ({
      getMfaStatus,
      enrollTotpStart,
      enrollTotpConfirm,
      disableTotp,
      confirmTotpRestriction,
      listTrustedDevices,
      forgetDevices,
    }),
    [
      getMfaStatus,
      enrollTotpStart,
      enrollTotpConfirm,
      disableTotp,
      confirmTotpRestriction,
      listTrustedDevices,
      forgetDevices,
    ],
  );
}
