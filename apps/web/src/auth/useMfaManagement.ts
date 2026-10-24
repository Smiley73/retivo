// Authenticated MFA-management API surface: thin `apiRequest` wrappers over the guarded `/auth/mfa/*` endpoints.
// No auth state of its own; AuthContext re-exports the methods through context for the Security 2FA card.
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
  /** True when a fresh second-factor step-up is required before a sensitive operation (`AUTH_MFA_ENFORCED`). */
  stepUpRequired?: boolean;
  /** Eligible routine step-up factors (strongest first), when `stepUpRequired`. */
  methods?: string[];
  /** Eligible recovery step-up factors, when `stepUpRequired`. */
  recoveryMethods?: string[];
  /**
   * True while restricted post-reset: needs a confirm-restriction lift (or removal) before it can sign in or approve
   * changes.
   */
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
  getMfaStatus(): Promise<MfaStatus>;
  /** Begin TOTP enrollment: returns the base32 secret + the otpauth URL. */
  enrollTotpStart(): Promise<{ secret: string; otpauthUrl: string }>;
  /**
   * Confirms enrollment with a live code. The account password is always re-verified, plus a fresh `proof` when
   * `AUTH_MFA_ENFORCED` is on. `noticeSent`: whether the factor-change notice mail went out (the card claims "we
   * emailed you" only then).
   */
  enrollTotpConfirm(
    code: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ totpEnabled: boolean; noticeSent: boolean }>;
  /**
   * Disables TOTP behind a password re-verify (+ fresh `proof` when `AUTH_MFA_ENFORCED` is on); `noticeSent` as in
   * `enrollTotpConfirm`.
   */
  disableTotp(
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<{ totpEnabled: boolean; noticeSent: boolean }>;
  /**
   * Lifts the post-reset restriction; the proof must come from a different, already-enrolled, non-restricted factor
   * that predates the reset (`totp` or `passkey`; Email-OTP has no enrollment timestamp).
   */
  confirmTotpRestriction(proof: StepUpProof): Promise<void>;
  listTrustedDevices(): Promise<TrustedDevice[]>;
  /** Forget devices by id, or every device when `deviceIds` is omitted. */
  forgetDevices(deviceIds?: string[]): Promise<void>;
}

/** Stable MFA-management callbacks; stateless, each call is a one-shot authenticated request. */
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
      // Omit the body to forget all: the server's `deviceIds === undefined` branch also drops the trust cookie.
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
