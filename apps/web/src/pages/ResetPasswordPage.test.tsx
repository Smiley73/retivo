/**
 * Tests for the ResetPasswordPage component.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
  // Faithful stand-in for the real helper (a localStorage read of the
  // last-known sign-in email) — the page wires it into the hidden
  // username field for password-manager credential association.
  readStoredAuthEmail: () =>
    localStorage.getItem('retivo.auth.email') ?? '',
}));

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateMock };
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
import { ResetPasswordPage } from './ResetPasswordPage';

const TOKEN = 'reset-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setHashToken(token: string | null): void {
  window.history.replaceState(
    null,
    '',
    `/auth/reset-password${token ? `#token=${token}` : ''}`,
  );
}

function renderPage(resetPassword = vi.fn()) {
  (useAuth as any).mockReturnValue({ resetPassword });
  return render(
    <MemoryRouter>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

function fillPasswords(value: string): void {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value } });
}

describe('ResetPasswordPage', () => {
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('scrubs the token from the URL fragment on mount', async () => {
    setHashToken(TOKEN);
    renderPage();
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('warns up front that a reset does not unlock encrypted data', () => {
    setHashToken(TOKEN);
    renderPage();
    expect(screen.getByText(/recovery key/i)).toBeInTheDocument();
    expect(screen.getByText(/can.?t be recovered/i)).toBeInTheDocument();
  });

  it('submits the captured token + new password and redirects to /login on success', async () => {
    setHashToken(TOKEN);
    const fn = vi.fn().mockResolvedValue(undefined);
    renderPage(fn);

    fillPasswords('ResetPassw0rd!New');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await waitFor(() => {
      expect(fn).toHaveBeenCalledWith(TOKEN, 'ResetPassw0rd!New');
    });
    // The redirect runs after that call resolves, so the gate above does not
    // imply it has happened yet — re-query rather than assert once.
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }),
    );
  });

  it('blocks submit when the two passwords differ', async () => {
    setHashToken(TOKEN);
    const fn = vi.fn();
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'ResetPassw0rd!New' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Different0rd!New' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText(/don.?t match/i)).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it('surfaces an expired/invalid token API error', async () => {
    setHashToken(TOKEN);
    const { ApiRequestError } = await import('../api/client');
    const fn = vi.fn().mockRejectedValue(
      new ApiRequestError(410, {
        code: 'RESET_TOKEN_EXPIRED',
        message: 'Password-reset link has expired. Request a new one.',
      }),
    );
    renderPage(fn);

    fillPasswords('ResetPassw0rd!New');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(
      await screen.findByText('Password-reset link has expired. Request a new one.'),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // Inline "service is busy" copy.
  it('shows the busy sentence for a no-envelope 5xx', async () => {
    setHashToken(TOKEN);
    const { ApiRequestError } = await import('../api/client');
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' }));
    renderPage(fn);

    fillPasswords('ResetPassw0rd!New');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(
      await screen.findByText('The service is busy right now. Please try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('a genuine enveloped 5xx renders its own message, not the busy copy', async () => {
    setHashToken(TOKEN);
    const { ApiRequestError } = await import('../api/client');
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Something broke.' }));
    renderPage(fn);

    fillPasswords('ResetPassw0rd!New');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Something broke.')).toBeInTheDocument();
    expect(
      screen.queryByText('The service is busy right now. Please try again in a moment.'),
    ).not.toBeInTheDocument();
  });

  it('reports a missing token when the link carries none', () => {
    setHashToken(null);
    renderPage();
    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
  });

  // Password-manager interop: the form
  // carries a best-effort hidden username from the last-known sign-in
  // email so the manager's "update password?" prompt targets the right
  // credential; absent when unknown.
  it('renders a hidden username from the stored sign-in email', () => {
    localStorage.setItem('retivo.auth.email', 'ada@example.com');
    try {
      setHashToken(TOKEN);
      const { container } = renderPage();
      const username = container.querySelector('input[name="username"]');
      expect(username).not.toBeNull();
      expect(username).toHaveAttribute('autocomplete', 'username');
      expect(username).toHaveValue('ada@example.com');
      // Inside the same form as the password fields (managers associate
      // per-form).
      expect(username!.closest('form')).toBe(
        screen.getByLabelText('New password').closest('form'),
      );
    } finally {
      localStorage.removeItem('retivo.auth.email');
    }
  });

  it('omits the hidden username when no sign-in email is stored', () => {
    setHashToken(TOKEN);
    const { container } = renderPage();
    expect(container.querySelector('input[name="username"]')).toBeNull();
  });
});
