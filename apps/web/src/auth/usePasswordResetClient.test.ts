// The hook's call shapes with the api client mocked at the module boundary; owed-ness is derived from server revisions, not remembered here (see useDerivedRewrap.ts).
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
