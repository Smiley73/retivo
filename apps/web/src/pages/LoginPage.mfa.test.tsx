/**
 * LoginPage MFA-challenge step tests. When
 * `useAuth().mfaChallenge` is non-null, the page renders MfaChallengeForm in
 * place of the sign-in form. A successful verify with a remembered device
 * surfaces the "this device is now trusted" notice — and because the real
 * `verifyMfa` clears `mfaChallenge` in the same render that sets the notice,
 * the notice is rendered on the sign-in surface, not inside the challenge
 * block.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: vi.fn(() => vi.fn()),
    useLocation: vi.fn(() => ({ state: null, pathname: '/login' })),
  };
});

vi.mock('../api/client', () => ({
  apiRequest: vi.fn(),
  // Defined inside the factory (vitest hoists vi.mock above imports, so a
  // module-scope class would hit a TDZ error). Re-imported below for the test.
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
  configureApi: vi.fn(),
}));

// WebAuthn-support detection used by MfaChallengeForm to gate the passkey
// factor. Defaults to supported; individual tests flip it.
const browserSupportsWebAuthn = vi.fn(() => true);
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => browserSupportsWebAuthn(),
}));

import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';

function renderWithMfa(overrides: Record<string, unknown> = {}) {
  (useAuth as any).mockReturnValue({
    login: vi.fn(),
    loginWithPasskey: vi.fn(),
    resendVerification: vi.fn(),
    isAuthenticated: false,
    isPasskeySupported: () => false,
    isBooting: false,
    unlockResolved: false,
    mfaChallenge: {
      challengeToken: 'tok',
      methods: ['totp'],
      recoveryMethods: ['email_otp'],
    },
    verifyMfa: vi.fn().mockResolvedValue({ deviceRemembered: false }),
    verifyMfaWithPasskey: vi.fn().mockResolvedValue({ deviceRemembered: false }),
    sendEmailOtp: vi.fn().mockResolvedValue(undefined),
    clearMfaChallenge: vi.fn(),
    ...overrides,
  });
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage — MFA challenge step', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the challenge form (not the sign-in form) when a challenge is pending', () => {
    renderWithMfa();
    expect(
      screen.getByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();
    // The sign-in form heading is not rendered while challenged.
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('calls verifyMfa with the entered code on Continue', async () => {
    const verifyMfa = vi.fn().mockResolvedValue({ deviceRemembered: false });
    renderWithMfa({ verifyMfa });
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(verifyMfa).toHaveBeenCalledWith('totp', '123456', false);
    });
  });

  it('shows the device-trusted notice after a remembered verify', async () => {
    // Model the real AuthContext: verifyMfa resolves deviceRemembered=true AND
    // clears mfaChallenge. The component sets deviceTrustedNotice in the same
    // render, so the notice must surface on the sign-in surface (challenge gone)
    // rather than inside the challenge block.
    const auth: Record<string, unknown> = {
      login: vi.fn(),
      loginWithPasskey: vi.fn(),
      resendVerification: vi.fn(),
      isAuthenticated: false,
      isPasskeySupported: () => false,
      isBooting: false,
      unlockResolved: false,
      mfaChallenge: { challengeToken: 'tok', methods: ['totp'], recoveryMethods: [] },
      sendEmailOtp: vi.fn().mockResolvedValue(undefined),
      clearMfaChallenge: vi.fn(),
    };
    auth.verifyMfa = vi.fn().mockImplementation(async () => {
      // Mirror the context: a successful verify clears the pending challenge.
      auth.mfaChallenge = null;
      return { deviceRemembered: true };
    });
    (useAuth as any).mockImplementation(() => auth);

    const { rerender } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '111111' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /trust this device/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Re-render with the cleared challenge (the real provider re-renders on the
    // setMfaChallenge(null) state change inside verifyMfa).
    await waitFor(() => expect(auth.mfaChallenge).toBeNull());
    rerender(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/this device is now trusted/i)).toBeInTheDocument();
    // It renders on the sign-in surface, not the (now-gone) challenge form.
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('calls clearMfaChallenge from the back link', () => {
    const clearMfaChallenge = vi.fn();
    renderWithMfa({ clearMfaChallenge });
    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(clearMfaChallenge).toHaveBeenCalledTimes(1);
  });

  it('routes the passkey assert through verifyMfaWithPasskey', async () => {
    const verifyMfaWithPasskey = vi.fn().mockResolvedValue({ deviceRemembered: false });
    renderWithMfa({
      verifyMfaWithPasskey,
      mfaChallenge: { challengeToken: 'tok', methods: ['passkey'], recoveryMethods: ['email_otp'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
    await waitFor(() => expect(verifyMfaWithPasskey).toHaveBeenCalledWith(false));
  });

  it('maps an expired-after-assert challenge back to the password form', async () => {
    const clearMfaChallenge = vi.fn();
    const verifyMfaWithPasskey = vi
      .fn()
      .mockRejectedValue(
        new (ApiRequestError as any)(401, {
          code: 'MFA_CHALLENGE_EXPIRED',
          message: 'The MFA challenge has expired. Sign in again.',
        }),
      );
    renderWithMfa({
      verifyMfaWithPasskey,
      clearMfaChallenge,
      mfaChallenge: { challengeToken: 'tok', methods: ['passkey'], recoveryMethods: ['email_otp'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
    // The expired-token branch clears the challenge (back to the password form)
    // rather than re-throwing to the form.
    await waitFor(() => expect(clearMfaChallenge).toHaveBeenCalledTimes(1));
  });

  it('maps an expired-after-entry code-factor challenge back to the password form', async () => {
    // Sibling of the passkey case above: a code factor whose challenge
    // expired between entry and submit must route back to sign-in with the same
    // "session expired" copy, not strand the user on the challenge form.
    const clearMfaChallenge = vi.fn();
    const verifyMfa = vi
      .fn()
      .mockRejectedValue(
        new (ApiRequestError as any)(401, {
          code: 'MFA_CHALLENGE_EXPIRED',
          message: 'The MFA challenge has expired. Sign in again.',
        }),
      );
    renderWithMfa({ verifyMfa, clearMfaChallenge });
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(clearMfaChallenge).toHaveBeenCalledTimes(1));
  });
});
