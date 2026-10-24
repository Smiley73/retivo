import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LoginPage } from './LoginPage';
import { DEV_DEFAULT_PASSWORD } from '../lib/dev-credentials';
import { REPO_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';

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
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      public status: number,
      public error: { code: string; message: string },
      public retryAfterMs?: number | null,
    ) {
      super(error.message);
    }
  },
  configureApi: vi.fn(),
}));

import { useAuth } from '../auth/AuthContext';
import { ApiRequestError, apiRequest } from '../api/client';
import { SetupStepUpRequiredError } from '../auth/useZeroKnowledgeKey';
import { useNavigate } from 'react-router';
import {
  setSignoutReason,
  SIGNOUT_REASON_DEVICE_MISMATCH,
} from '../auth/IdleTimer';

function renderLoginPage(loginFn = vi.fn(), resendFn = vi.fn().mockResolvedValue({ accepted: true })) {
  (useAuth as any).mockReturnValue({
    login: loginFn,
    loginWithPasskey: vi.fn(),
    resendVerification: resendFn,
    isAuthenticated: false,
    isPasskeySupported: () => false,
  });
  (useNavigate as any).mockReturnValue(vi.fn());
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the sign-in form', () => {
    renderLoginPage();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  // Representative auth-page check: the open-source line comes from the shared AuthBrandRow, so the other 7 auth pages inherit it.
  it('renders the open-source line via the shared auth brand row', () => {
    renderLoginPage();
    const link = screen.getByRole('link', { name: 'RETIVO is open source' });
    expect(link).toHaveAttribute('href', REPO_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleDescription('Opens in a new tab');
  });

  it('shows a Forgot password? link to the request-reset page', () => {
    renderLoginPage();
    const link = screen.getByRole('link', { name: 'Forgot password?' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/auth/request-password-reset');
  });

  it('calls login with email and password on submit', async () => {
    const mockLogin = vi.fn().mockResolvedValue(undefined);
    renderLoginPage(mockLogin);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@test.com', 'Password1!');
    });
  });

  it('shows an API error message when login fails', async () => {
    const { ApiRequestError: ApiErr } = await import('../api/client');
    const mockLogin = vi.fn().mockRejectedValue(new ApiErr(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }));
    renderLoginPage(mockLogin);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bad@test.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
    });
  });

  it('shows a generic error when a non-API error is thrown', async () => {
    const mockLogin = vi.fn().mockRejectedValue(new Error('network error'));
    renderLoginPage(mockLogin);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Unable to sign in');
    });
  });

  it('disables the submit button while submitting', async () => {
    let resolve!: () => void;
    const mockLogin = vi.fn().mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    renderLoginPage(mockLogin);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    });

    resolve();
  });

  it('shows the static public-computer warning with the warning tone', () => {
    renderLoginPage();
    const warning = screen.getByText(/avoid signing in on a public or shared computer/i);
    expect(warning).toHaveClass('text-warning');
    expect(warning).toHaveClass('border-warning/40');
  });

  it('renders the public-computer warning as a polite status region, not an assertive alert', () => {
    renderLoginPage();
    // The advisory must be role="status" (polite), not the warning tone's default role="alert"; a regression would still pass the copy, tone, size and axe tests.
    expect(screen.getByRole('status')).toHaveTextContent(/public or shared computer/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the public-computer warning with sign-out and clear-data guidance', () => {
    renderLoginPage();
    expect(
      screen.getByText(/avoid signing in on a public or shared computer/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/sign out/i)).toBeInTheDocument();
    expect(screen.getByText(/clear data on this device/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings . Workspace/i)).toBeInTheDocument();
  });

  it('renders the public-computer warning at the text-sm page baseline', () => {
    renderLoginPage();
    const warning = screen.getByText(/avoid signing in on a public or shared computer/i);
    expect(warning).toHaveClass('text-sm');
  });

  it('shows the device-reset notice after a DEVICE_MISMATCH signout', async () => {
    setSignoutReason(SIGNOUT_REASON_DEVICE_MISMATCH);
    renderLoginPage();
    expect(
      screen.getByText(/this device's session was reset/i),
    ).toBeInTheDocument();
    cleanup();
    renderLoginPage();
    expect(
      screen.queryByText(/this device's session was reset/i),
    ).not.toBeInTheDocument();
  });

  // After an EMAIL_NOT_VERIFIED login failure the page offers an inline "Resend verification email"; the original login error stays visible, resend success is announced in role="status", failure in role="alert", and the action clears on resubmit or email change.
  describe('verification-resend after EMAIL_NOT_VERIFIED', () => {
    async function failLoginWith(code: string, message: string, resendFn = vi.fn()) {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockLogin = vi.fn().mockRejectedValue(new ApiErr(401, { code, message }));
      renderLoginPage(mockLogin, resendFn);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    }

    it('shows the resend action after an EMAIL_NOT_VERIFIED failure', async () => {
      await failLoginWith('EMAIL_NOT_VERIFIED', 'Email not verified');
      expect(
        await screen.findByRole('button', { name: 'Resend verification email' }),
      ).toBeInTheDocument();
    });

    it('does NOT show the resend action for a non-verification login error', async () => {
      await failLoginWith('INVALID_CREDENTIALS', 'Invalid email or password');
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
      });
      expect(
        screen.queryByRole('button', { name: 'Resend verification email' }),
      ).not.toBeInTheDocument();
    });

    it('calls resendVerification with the trimmed email on click', async () => {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const resend = vi.fn().mockResolvedValue({ accepted: true });
      const mockLogin = vi
        .fn()
        .mockRejectedValue(new ApiErr(401, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }));
      renderLoginPage(mockLogin, resend);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  user@test.com  ' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Resend verification email' }),
      );
      await waitFor(() => {
        expect(resend).toHaveBeenCalledWith('user@test.com');
      });
    });

    it('announces a successful resend in a role="status" region', async () => {
      await failLoginWith('EMAIL_NOT_VERIFIED', 'Email not verified', vi.fn().mockResolvedValue({ accepted: true }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Resend verification email' }),
      );
      await waitFor(() => {
        // The standing public-computer advisory is also role="status", so scope to the region carrying the resend copy.
        const statuses = screen.getAllByRole('status');
        expect(
          statuses.some((el) => /a fresh link is on its way/i.test(el.textContent ?? '')),
        ).toBe(true);
      });
    });

    it('announces a resend failure in a role="alert" region while the original login error remains', async () => {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const resend = vi
        .fn()
        .mockRejectedValue(new ApiErr(429, { code: 'RATE_LIMITED', message: 'Too many requests' }));
      await failLoginWith('EMAIL_NOT_VERIFIED', 'Email not verified', resend);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Resend verification email' }),
      );
      await waitFor(() => {
        const alerts = screen.getAllByRole('alert');
        expect(alerts.some((el) => /too many requests/i.test(el.textContent ?? ''))).toBe(true);
        expect(alerts.some((el) => /email not verified/i.test(el.textContent ?? ''))).toBe(true);
      });
    });

    it('clears the resend action when the login form is resubmitted', async () => {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockLogin = vi
        .fn()
        .mockRejectedValueOnce(new ApiErr(401, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }))
        .mockResolvedValueOnce(undefined);
      renderLoginPage(mockLogin);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
      await screen.findByRole('button', { name: 'Resend verification email' });

      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: 'Resend verification email' }),
        ).not.toBeInTheDocument();
      });
    });

    it('clears the resend action when the email field changes', async () => {
      await failLoginWith('EMAIL_NOT_VERIFIED', 'Email not verified');
      await screen.findByRole('button', { name: 'Resend verification email' });

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'other@test.com' } });
      expect(
        screen.queryByRole('button', { name: 'Resend verification email' }),
      ).not.toBeInTheDocument();
    });

    it('clears the resend action when a passkey login is attempted after EMAIL_NOT_VERIFIED', async () => {
      // onPasskeyLogin must call clearResendState() so the resend button doesn't linger under a later passkey error.
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockLogin = vi
        .fn()
        .mockRejectedValue(new ApiErr(401, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }));
      const mockPasskeyLogin = vi
        .fn()
        .mockRejectedValue(new ApiErr(400, { code: 'PASSKEY_FAILED', message: 'Passkey sign in failed' }));
      (useAuth as any).mockReturnValue({
        login: mockLogin,
        loginWithPasskey: mockPasskeyLogin,
        resendVerification: vi.fn(),
        isAuthenticated: false,
        isPasskeySupported: () => true,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
      await screen.findByRole('button', { name: 'Resend verification email' });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: 'Resend verification email' }),
        ).not.toBeInTheDocument();
      });
    });
  });

  // A gateway throttle or timeout with no error envelope shows the shared busy sentence instead of raw upstream text; enveloped errors, including LOGIN_BACKOFF, keep their own message.
  describe('busy-response handling', () => {
    const BUSY_MESSAGE = 'The service is busy right now. Please try again in a moment.';

    async function failLoginWith(status: number, code: string, message: string, retryAfterMs?: number | null) {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockLogin = vi
        .fn()
        .mockRejectedValue(new (ApiErr as any)(status, { code, message }, retryAfterMs));
      renderLoginPage(mockLogin);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    }

    it('shows the busy sentence for a no-envelope 503 (UNKNOWN_ERROR)', async () => {
      await failLoginWith(503, 'UNKNOWN_ERROR', 'Service Unavailable');
      expect(await screen.findByRole('alert')).toHaveTextContent(BUSY_MESSAGE);
    });

    it('shows the busy sentence for a no-envelope 429 with no Retry-After (INVALID_RESPONSE)', async () => {
      await failLoginWith(429, 'INVALID_RESPONSE', 'Too Many Requests');
      expect(await screen.findByRole('alert')).toHaveTextContent(BUSY_MESSAGE);
    });

    it('an enveloped 500 with a real message renders that message, not the busy copy', async () => {
      await failLoginWith(500, 'INTERNAL_ERROR', 'Something went wrong on our end.');
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our end.');
      });
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('a 429 LOGIN_BACKOFF with no Retry-After renders its own wait sentence verbatim, not the busy copy', async () => {
      await failLoginWith(429, 'LOGIN_BACKOFF', 'Try again in 23 seconds…');
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Try again in 23 seconds…');
      });
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('a 429 carrying a parsed retryAfterMs renders its own message, not the busy copy', async () => {
      await failLoginWith(429, 'UNKNOWN_ERROR', 'Too Many Requests', 5_000);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Too Many Requests');
      });
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('a 404 carrying UNKNOWN_ERROR is not busy — the status floor holds', async () => {
      await failLoginWith(404, 'UNKNOWN_ERROR', 'Not Found');
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Not Found');
      });
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('shows the busy sentence on the passkey path for a no-envelope 5xx', async () => {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockPasskeyLogin = vi
        .fn()
        .mockRejectedValue(new ApiErr(502, { code: 'UNKNOWN_ERROR', message: 'Bad Gateway' }));
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: mockPasskeyLogin,
        resendVerification: vi.fn(),
        isAuthenticated: false,
        isPasskeySupported: () => true,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(BUSY_MESSAGE);
    });

    it('a 429 LOGIN_BACKOFF on the passkey path renders its own message, not the busy copy', async () => {
      const { ApiRequestError: ApiErr } = await import('../api/client');
      const mockPasskeyLogin = vi
        .fn()
        .mockRejectedValue(new ApiErr(429, { code: 'LOGIN_BACKOFF', message: 'Try again in 23 seconds…' }));
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: mockPasskeyLogin,
        resendVerification: vi.fn(),
        isAuthenticated: false,
        isPasskeySupported: () => true,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Try again in 23 seconds…');
      });
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });
  });

  // The render-time redirect must wait for `unlockResolved`: before it settles every unlock flag is transiently false, so redirecting would push an encrypted-but-locked household into the app before the envelope fetch discovers it needs a password unlock.
  describe('post-auth redirect gating', () => {
    function renderWithUnlock(overrides: Record<string, unknown>) {
      const navigate = vi.fn();
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: false,
        ...overrides,
      });
      (useNavigate as any).mockReturnValue(navigate);
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      return navigate;
    }

    it('does NOT redirect before unlockResolved becomes true', () => {
      const navigate = renderWithUnlock({ unlockResolved: false });
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Unlock your data' })).not.toBeInTheDocument();
    });

    it('redirects once unlockResolved is true and no unlock is needed', () => {
      const navigate = renderWithUnlock({
        unlockResolved: true,
        isUnlocked: true,
      });
      expect(navigate).toHaveBeenCalled();
    });

    it('holds on /login and shows the unlock prompt when resolved but still locked', () => {
      const navigate = renderWithUnlock({
        unlockResolved: true,
        isUnlocked: false,
        needsKeySetup: false,
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Unlock your data' })).toBeInTheDocument();
    });
  });

  describe('recovery-key unlock toggle', () => {
    function renderLocked(overrides: Record<string, unknown> = {}) {
      const navigate = vi.fn();
      const unlockWithPassword = vi.fn().mockResolvedValue(undefined);
      const unlockWithRecovery = vi.fn().mockResolvedValue(undefined);
      (useAuth as any).mockReturnValue({
        me: { id: 'u-1', email: 'me@local.test', displayName: 'Me' },
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword,
        unlockWithRecovery,
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: true,
        ...overrides,
      });
      (useNavigate as any).mockReturnValue(navigate);
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      return { navigate, unlockWithPassword, unlockWithRecovery };
    }

    it('defaults to the password field with a "Use recovery key instead" toggle', () => {
      renderLocked();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Use recovery key instead' }),
      ).toBeInTheDocument();
    });

    it('links the encrypted-data reset to /security with "Settings → Security" copy', () => {
      renderLocked();
      const link = screen.getByRole('link', {
        name: /delete your encrypted data and start fresh/i,
      });
      expect(link).toHaveAttribute('href', '/security');
      expect(
        screen.getByText(/in Settings . Security/i),
      ).toBeInTheDocument();
    });

    // A regression to the old text link would still satisfy getByRole('button'), so assert the styling and divider.
    it('renders the recovery toggle as a secondary button (not an underline text link) with an "or" divider above it', () => {
      renderLocked();
      const toggle = screen.getByRole('button', { name: 'Use recovery key instead' });
      expect(toggle).toHaveClass('w-full');
      expect(toggle).toHaveClass('border-line-strong');
      expect(toggle).not.toHaveClass('underline');
      const divider = screen.getByText('or');
      expect(divider).toBeInTheDocument();
      expect(
        divider.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('keeps the toggle disabled while an unlock is in flight', async () => {
      let resolve!: () => void;
      const unlockWithPassword = vi
        .fn()
        .mockReturnValue(new Promise<void>((r) => { resolve = r; }));
      renderLocked({ unlockWithPassword });
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Password1!' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Unlock' }).closest('form')!);
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Use recovery key instead' }),
        ).toBeDisabled();
      });
      resolve();
    });

    it('toggling password → recovery switches mode and starts the recovery field empty', () => {
      renderLocked();
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Password1!' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      const recoveryField = screen.getByLabelText('Recovery key');
      expect(recoveryField).toBeInTheDocument();
      expect(recoveryField).toHaveValue('');
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });

    it('toggling shows the recovery-key field and a "use your password" toggle', () => {
      renderLocked();
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      expect(screen.getByLabelText('Recovery key')).toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Use your password instead' }),
      ).toBeInTheDocument();
    });

    // Password mode carries a hidden username so managers fill the right credential; recovery mode must not (a recovery key is never offered for fill or save), so it opts out via the vendor ignore attributes.
    it('password mode renders a hidden username field; recovery mode does not', () => {
      renderLocked();
      const passwordForm = screen.getByLabelText('Password').closest('form')!;
      const username = passwordForm.querySelector('input[name="username"]');
      expect(username).not.toBeNull();
      expect(username).toHaveAttribute('autocomplete', 'username');
      expect(username).toHaveValue('me@local.test');

      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      const recoveryForm = screen.getByLabelText('Recovery key').closest('form')!;
      expect(recoveryForm.querySelector('input[name="username"]')).toBeNull();
    });

    it('the recovery-key field opts out of password managers (ignore attrs + own id)', () => {
      renderLocked();
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      const recoveryField = screen.getByLabelText('Recovery key');
      expect(recoveryField).toHaveAttribute('id', 'unlock-recovery-key');
      expect(recoveryField).toHaveAttribute('autocomplete', 'off');
      expect(recoveryField).toHaveAttribute('data-1p-ignore');
      expect(recoveryField).toHaveAttribute('data-lpignore', 'true');
      expect(recoveryField).toHaveAttribute('data-bwignore');
      expect(recoveryField).toHaveAttribute('data-form-type', 'other');
    });

    it('toggling to password mode clears the entered recovery key value', () => {
      renderLocked();
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      fireEvent.change(screen.getByLabelText('Recovery key'), {
        target: { value: 'ABCD-EF12-3456-7890' },
      });
      // The field resets to the seeded baseline (`DEV_DEFAULT_PASSWORD`: empty off a local-dev host), never the typed recovery key.
      fireEvent.click(screen.getByRole('button', { name: 'Use your password instead' }));
      expect(screen.getByLabelText('Password')).toHaveValue(DEV_DEFAULT_PASSWORD);
    });

    it('toggling mode clears an inline unlock error', async () => {
      const unlockWithRecovery = vi.fn().mockRejectedValue(new Error('wrong key'));
      renderLocked({ unlockWithRecovery });
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      fireEvent.change(screen.getByLabelText('Recovery key'), {
        target: { value: 'WRONG-KEY' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Unlock' }).closest('form')!);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Use your password instead' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('resets recovery mode and the typed secret when the unlock prompt goes away and returns', () => {
      const auth = {
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn().mockResolvedValue(undefined),
        unlockWithRecovery: vi.fn().mockResolvedValue(undefined),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: true,
      };
      (useAuth as any).mockReturnValue(auth);
      (useNavigate as any).mockReturnValue(vi.fn());
      const { rerender } = render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      fireEvent.change(screen.getByLabelText('Recovery key'), {
        target: { value: 'ABCD-EF12-3456-7890' },
      });

      (useAuth as any).mockReturnValue({ ...auth, isUnlocked: true });
      rerender(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );

      // A new locked session in the same tab must reopen in password mode at the seeded baseline, never echoing the prior recovery key.
      (useAuth as any).mockReturnValue(auth);
      rerender(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toHaveValue(DEV_DEFAULT_PASSWORD);
      expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
    });

    it('submitting in recovery mode calls unlockWithRecovery with the entered key', async () => {
      const { unlockWithRecovery, unlockWithPassword, navigate } = renderLocked();
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      fireEvent.change(screen.getByLabelText('Recovery key'), {
        target: { value: 'ABCD-EF12-3456-7890' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Unlock' }).closest('form')!);

      await waitFor(() => {
        expect(unlockWithRecovery).toHaveBeenCalledWith('ABCD-EF12-3456-7890');
      });
      expect(unlockWithPassword).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });

    it('shows an inline error when the recovery key does not unlock', async () => {
      const unlockWithRecovery = vi.fn().mockRejectedValue(new Error('wrong key'));
      renderLocked({ unlockWithRecovery });
      fireEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
      fireEvent.change(screen.getByLabelText('Recovery key'), {
        target: { value: 'WRONG-KEY' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Unlock' }).closest('form')!);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          /that recovery key did not unlock your data/i,
        );
      });
    });
  });

  // A device with a cached HDK / rollback pin served an empty envelope set lands on the same locked screen with one added sentence naming the cause.
  describe('locked screen — empty envelope set on an already-keyed device', () => {
    function renderLocked(overrides: Record<string, unknown> = {}) {
      (useAuth as any).mockReturnValue({
        me: { id: 'u-1', email: 'me@local.test', displayName: 'Me' },
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        unlockWithRecovery: vi.fn(),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: true,
        ...overrides,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      return render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
    }

    it('renders the added sentence when the flag is set', () => {
      renderLocked({ lockedEnvelopeSetEmpty: true });
      expect(
        screen.getByTestId('locked-envelope-set-empty-notice'),
      ).toHaveTextContent(/has no encryption keys, but this device has used one before/);
    });

    it('does not render the sentence when the flag is unset', () => {
      renderLocked({ lockedEnvelopeSetEmpty: false });
      expect(
        screen.queryByTestId('locked-envelope-set-empty-notice'),
      ).not.toBeInTheDocument();
    });

    it('still shows the unlock form and the start-over link', () => {
      renderLocked({ lockedEnvelopeSetEmpty: true });
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /delete your encrypted data and start fresh/i }),
      ).toHaveAttribute('href', '/security');
    });
  });

  describe('unlock-with-passkey button', () => {
    function renderLocked(overrides: Record<string, unknown> = {}) {
      const navigate = vi.fn();
      const unlockWithPasskey = vi.fn().mockResolvedValue(undefined);
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn().mockResolvedValue(undefined),
        unlockWithRecovery: vi.fn().mockResolvedValue(undefined),
        unlockWithPasskey,
        isPasskeySupported: () => true,
        hasPasskeyPrfSlot: true,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: true,
        ...overrides,
      });
      (useNavigate as any).mockReturnValue(navigate);
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      return { navigate, unlockWithPasskey };
    }

    it('shows the button and calls unlockWithPasskey on click when a PRF slot exists', async () => {
      const { unlockWithPasskey, navigate } = renderLocked();
      const button = screen.getByRole('button', { name: 'Unlock with passkey' });
      fireEvent.click(button);
      await waitFor(() => expect(unlockWithPasskey).toHaveBeenCalled());
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });

    it('shows an inline error and stays on the unlock screen when the passkey unlock fails', async () => {
      const unlockWithPasskey = vi.fn().mockRejectedValue(new Error('no prf'));
      const { navigate } = renderLocked({ unlockWithPasskey });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock with passkey' }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          /couldn't unlock your data with that passkey/i,
        );
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Unlock your data' })).toBeInTheDocument();
    });

    it('hides the button when the household has no passkey_prf slot', () => {
      renderLocked({ hasPasskeyPrfSlot: false });
      expect(
        screen.queryByRole('button', { name: 'Unlock with passkey' }),
      ).not.toBeInTheDocument();
    });

    it('hides the button when WebAuthn is unsupported', () => {
      renderLocked({ isPasskeySupported: () => false });
      expect(
        screen.queryByRole('button', { name: 'Unlock with passkey' }),
      ).not.toBeInTheDocument();
    });
  });

  // The `?mode=recovery` pre-select is gated on `needsUnlock`, so it rides on top of the mount-time secret-clearing effect rather than being overwritten.
  describe('?mode=recovery query-param pre-select', () => {
    function renderAt(path: string, overrides: Record<string, unknown> = {}) {
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn().mockResolvedValue(undefined),
        unlockWithRecovery: vi.fn().mockResolvedValue(undefined),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: false,
        unlockResolved: true,
        ...overrides,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      render(
        <MemoryRouter initialEntries={[path]}>
          <LoginPage />
        </MemoryRouter>,
      );
    }

    it('pre-selects recovery mode with an empty field when needsUnlock is true', () => {
      renderAt('/login?mode=recovery');
      const recoveryField = screen.getByLabelText('Recovery key');
      expect(recoveryField).toBeInTheDocument();
      expect(recoveryField).toHaveValue('');
      expect(
        screen.getByRole('button', { name: 'Use your password instead' }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });

    it('stays in password mode without the query param', () => {
      renderAt('/login');
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
    });

    it('does NOT pre-select recovery mode when the unlock prompt is not active', () => {
      // mode=recovery with an already-unlocked session renders no unlock prompt, so the pre-select effect is inert.
      renderAt('/login?mode=recovery', { isUnlocked: true });
      expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
    });
  });

  // The recovery-key modal is a hard gate: dismiss (Esc / scrim / Cancel) must not navigate; only ticking "I have saved my recovery key" and Continue does, since losing every unwrapper makes encrypted data unrecoverable.
  describe('recovery-key modal save gate', () => {
    function renderForSetup(setupEncryption: ReturnType<typeof vi.fn>) {
      const navigate = vi.fn();
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        setupEncryption,
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: true,
        unlockResolved: true,
      });
      (useNavigate as any).mockReturnValue(navigate);
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      return navigate;
    }

    async function openRecoveryModal(navigate: ReturnType<typeof vi.fn>) {
      await screen.findByLabelText('Password');
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Password1!' },
      });
      fireEvent.submit(
        screen.getByRole('button', { name: 'Set up encryption' }).closest('form')!,
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument(),
      );
      expect(navigate).not.toHaveBeenCalled();
    }

    it('Cancel does NOT navigate (keeps the modal open)', async () => {
      const setupEncryption = vi.fn().mockResolvedValue('ABCD-EF12-3456-7890');
      const navigate = renderForSetup(setupEncryption);
      await openRecoveryModal(navigate);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();
    });

    it('Escape does NOT navigate (keeps the modal open)', async () => {
      const setupEncryption = vi.fn().mockResolvedValue('ABCD-EF12-3456-7890');
      const navigate = renderForSetup(setupEncryption);
      await openRecoveryModal(navigate);

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();
    });

    it('Continue stays disabled until the saved-key checkbox is ticked, then navigates', async () => {
      const setupEncryption = vi.fn().mockResolvedValue('ABCD-EF12-3456-7890');
      const navigate = renderForSetup(setupEncryption);
      await openRecoveryModal(navigate);

      const continueBtn = screen.getByRole('button', { name: 'Continue' });
      expect(continueBtn).toBeDisabled();
      fireEvent.click(continueBtn);
      expect(navigate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('checkbox', { name: /i have saved my recovery key/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });

  // Genuine first-time activation is proofless, but a stranded household (a `password` slot, no `recovery` slot) needs a fresh factor to finish the repair when `AUTH_MFA_ENFORCED` is on.
  describe('encryption-setup step-up', () => {
    function renderForSetup(opts: {
      setupEncryption: ReturnType<typeof vi.fn>;
      getMfaStatus?: ReturnType<typeof vi.fn>;
    }) {
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        setupEncryption: opts.setupEncryption,
        getMfaStatus: opts.getMfaStatus ?? vi.fn().mockResolvedValue({ stepUpRequired: false }),
        stepUpPasskeyOptions: vi.fn(),
        stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: true,
        unlockResolved: true,
      });
      (useNavigate as any).mockReturnValue(vi.fn());
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
    }

    async function submitSetupForm(): Promise<void> {
      await screen.findByLabelText('Password');
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'Password1!' },
      });
      fireEvent.submit(
        screen.getByRole('button', { name: 'Set up encryption' }).closest('form')!,
      );
    }

    it('true first-time setup issues exactly one setupEncryption call and never shows a factor prompt', async () => {
      const setupEncryption = vi.fn().mockResolvedValue('ABCD-EF12-3456-7890');
      const getMfaStatus = vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['totp'] });
      renderForSetup({ setupEncryption, getMfaStatus });

      await submitSetupForm();

      await waitFor(() => expect(setupEncryption).toHaveBeenCalledTimes(1));
      expect(setupEncryption).toHaveBeenCalledWith('Password1!', undefined);
      await screen.findByTestId('recovery-key-display');
      expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
      expect(getMfaStatus).not.toHaveBeenCalled();
    });

    it('the stranded-household repair branch shows the factor prompt and retries with the proof', async () => {
      const setupEncryption = vi
        .fn()
        .mockRejectedValueOnce(new SetupStepUpRequiredError())
        .mockResolvedValueOnce('ABCD-EF12-3456-7890');
      const getMfaStatus = vi.fn().mockResolvedValue({
        stepUpRequired: true,
        methods: ['totp'],
        recoveryMethods: ['email_otp'],
      });
      renderForSetup({ setupEncryption, getMfaStatus });

      await submitSetupForm();

      await screen.findByText("Confirm it's you");
      expect(setupEncryption).toHaveBeenCalledTimes(1);
      expect(setupEncryption).toHaveBeenCalledWith('Password1!', undefined);
      expect(getMfaStatus).toHaveBeenCalled();

      fireEvent.change(await screen.findByLabelText('Authenticator code'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

      await waitFor(() => expect(setupEncryption).toHaveBeenCalledTimes(2));
      expect(setupEncryption).toHaveBeenLastCalledWith('Password1!', {
        method: 'totp',
        code: '123456',
      });
      await screen.findByTestId('recovery-key-display');
      expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
    });

    it('holds the redirect through the repair retry even though setup flips the auth flags before its promise returns', async () => {
      // `setupEncryption` sets `isUnlocked` + `needsKeySetup` before it returns the recovery key; on the factor modal's retry that render meets every redirect condition except the `settingUp` hold, which must therefore span the retry or the page navigates before the one-time key is shown.
      const navigate = vi.fn();
      const baseAuth = {
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        getMfaStatus: vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['totp'] }),
        stepUpPasskeyOptions: vi.fn(),
        stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: true,
        unlockResolved: true,
      };
      let rerender!: ReturnType<typeof render>['rerender'];
      const setupEncryption = vi
        .fn()
        .mockRejectedValueOnce(new SetupStepUpRequiredError())
        .mockImplementationOnce(async () => {
          // Yield once so the flag flip lands after the confirm click's synchronous handler, as the real hook does after its server round-trip, then re-render while the promise is pending.
          await Promise.resolve();
          (useAuth as any).mockReturnValue({
            ...baseAuth,
            setupEncryption,
            isUnlocked: true,
            needsKeySetup: false,
          });
          rerender(
            <MemoryRouter>
              <LoginPage />
            </MemoryRouter>,
          );
          return 'ABCD-EF12-3456-7890';
        });
      (useAuth as any).mockReturnValue({ ...baseAuth, setupEncryption });
      (useNavigate as any).mockReturnValue(navigate);
      ({ rerender } = render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      ));

      await submitSetupForm();
      await screen.findByText("Confirm it's you");
      fireEvent.change(await screen.findByLabelText('Authenticator code'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

      await screen.findByTestId('recovery-key-display');
      expect(setupEncryption).toHaveBeenCalledTimes(2);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('the repair factor prompt passes an a11y smoke', async () => {
      const setupEncryption = vi.fn().mockRejectedValueOnce(new SetupStepUpRequiredError());
      const getMfaStatus = vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['totp'] });
      renderForSetup({ setupEncryption, getMfaStatus });

      await submitSetupForm();
      await screen.findByText("Confirm it's you");
      await expectNoA11yViolations(document.body);
    });
  });

  // There is no accept-to-continue step: first-time encryption setup renders as soon as `needsSetup` holds, with no "Loading…" surface and no legal request.
  describe('first-time encryption setup (no legal hold)', () => {
    function renderForSetup(setupEncryption: ReturnType<typeof vi.fn>) {
      const navigate = vi.fn();
      (useAuth as any).mockReturnValue({
        login: vi.fn(),
        loginWithPasskey: vi.fn(),
        unlockWithPassword: vi.fn(),
        setupEncryption,
        isPasskeySupported: () => false,
        isBooting: false,
        isAuthenticated: true,
        isUnlocked: false,
        needsKeySetup: true,
        unlockResolved: true,
        me: { email: 'user@example.com' },
      });
      (useNavigate as any).mockReturnValue(navigate);
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      return navigate;
    }

    it('shows the setup form on the first render, with no "Loading…" surface and no request', () => {
      renderForSetup(vi.fn().mockResolvedValue('ABCD'));

      expect(screen.getByRole('button', { name: 'Set up encryption' })).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument();
      expect(vi.mocked(apiRequest)).not.toHaveBeenCalled();
    });

    it('still holds on the recovery key after setup, without navigating or calling the network', async () => {
      const navigate = renderForSetup(vi.fn().mockResolvedValue('ABCD-EF12-3456-7890'));

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password1!' } });
      fireEvent.submit(
        screen.getByRole('button', { name: 'Set up encryption' }).closest('form')!,
      );

      expect(await screen.findByTestId('recovery-key-display')).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
      expect(vi.mocked(apiRequest)).not.toHaveBeenCalled();
    });

    it('shows the specific error for a wrong password', async () => {
      const setupEncryption = vi.fn().mockRejectedValue(
        new ApiRequestError(401, {
          code: 'INVALID_CREDENTIALS',
          message: 'bad password',
        }),
      );
      renderForSetup(setupEncryption);

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
      fireEvent.submit(
        screen.getByRole('button', { name: 'Set up encryption' }).closest('form')!,
      );

      expect(
        await screen.findByText(
          'Incorrect password. Enter the same password you use to sign in.',
        ),
      ).toBeInTheDocument();
    });
  });
});
