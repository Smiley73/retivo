/**
 * Password-reset client surface, extracted from AuthContext so that file stays
 * under the shape limit. Owns the `requestPasswordReset` + `resetPassword`
 * API calls (the opaque-202 request and the 204 consume).
 *
 * No `sessionStorage` marker is dropped on consume: whether a re-wrap is
 * owed is DERIVED from two server-authored revisions on every unlock-state
 * transition (`useDerivedRewrap.ts`), so nothing durable needs to remember
 * that a reset happened. `resetPassword` is the bare API call.
 *
 * See "Password change, password reset" in docs/security.md.
 */
import { useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface RequestPasswordResetResponse {
  accepted: true;
  /** Returned in dev/test only, and only on a real send, so the developer
   * can click the reset link without a real SES delivery. */
  resetToken?: string;
}

export interface PasswordResetClient {
  /** Request a password-reset link (opaque 202 — never reveals whether the
   * email exists; dev/test builds may echo the raw token). */
  requestPasswordReset(email: string): Promise<RequestPasswordResetResponse>;
  /** Consume a password-reset token: set a new password (204). */
  resetPassword(token: string, newPassword: string): Promise<void>;
}

export function usePasswordResetClient(): PasswordResetClient {
  const requestPasswordReset = useCallback(
    async (email: string): Promise<RequestPasswordResetResponse> => {
      return apiRequest<RequestPasswordResetResponse>(
        '/api/v1/auth/request-password-reset',
        { method: 'POST', body: { email }, auth: false },
      );
    },
    [],
  );

  const resetPassword = useCallback(
    async (token: string, newPassword: string): Promise<void> => {
      await apiRequest('/api/v1/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword },
        auth: false,
      });
    },
    [],
  );

  return {
    requestPasswordReset,
    resetPassword,
  };
}
