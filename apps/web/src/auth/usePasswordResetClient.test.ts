/**
 * Tests for usePasswordResetClient — the password-reset client surface
 * extracted from AuthContext: the bare request + consume API calls.
 * The hook keeps no post-reset marker: owed-ness is derived from
 * server-authored revisions rather than remembered client-side — see
 * useDerivedRewrap.ts.
 *
 * The api client is mocked at the module boundary so the test exercises only
 * the hook's call shapes, not the transport.
 */
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn();
vi.mock('../api/client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

import { usePasswordResetClient } from './usePasswordResetClient';

describe('usePasswordResetClient', () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requestPasswordReset POSTs the email unauthenticated and returns the opaque body', async () => {
    apiRequest.mockResolvedValue({ accepted: true, resetToken: 'tok' });
    const { result } = renderHook(() => usePasswordResetClient());

    let body: unknown;
    await act(async () => {
      body = await result.current.requestPasswordReset('u@test.com');
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/request-password-reset', {
      method: 'POST',
      body: { email: 'u@test.com' },
      auth: false,
    });
    expect(body).toEqual({ accepted: true, resetToken: 'tok' });
  });

  it('resetPassword POSTs the token + new password and nothing else', async () => {
    apiRequest.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePasswordResetClient());

    await act(async () => {
      await result.current.resetPassword('reset-token', 'NewPassw0rd!Reset');
    });

    expect(apiRequest).toHaveBeenCalledExactlyOnceWith('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token: 'reset-token', newPassword: 'NewPassw0rd!Reset' },
      auth: false,
    });
  });
});
