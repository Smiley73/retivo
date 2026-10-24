// Password-reset client (opaque-202 request, 204 consume); docs/security.md "Password change, password reset".
// No marker is kept: whether a re-wrap is owed is derived from server revisions at each unlock (`useDerivedRewrap.ts`).
import { useCallback } from 'react';
import { apiRequest } from '../api/client';

export interface RequestPasswordResetResponse {
  accepted: true;
  /** Dev/test only, on a real send: lets the developer click the reset link without SES. */
  resetToken?: string;
}

export interface PasswordResetClient {
  /** Request a reset link (opaque 202: never reveals whether the email exists). */
  requestPasswordReset(email: string): Promise<RequestPasswordResetResponse>;
  /** Consume a reset token to set a new password (204). */
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
