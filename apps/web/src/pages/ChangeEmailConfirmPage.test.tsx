/**
 * Tests for ChangeEmailConfirmPage: token
 * capture from the URL fragment, fragment scrub, the confirm POST path, and the
 * success / error / missing-token outcomes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiRequest: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
  configureApi: vi.fn(),
}));

import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { ChangeEmailConfirmPage } from './ChangeEmailConfirmPage';

const TOKEN = 'change-email-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setHashToken(token: string | null): void {
  window.history.replaceState(
    null,
    '',
    `/auth/change-email/confirm${token ? `#token=${token}` : ''}`,
  );
}

function mockConfirm(fn: ReturnType<typeof vi.fn>) {
  (useAuth as any).mockReturnValue({ confirmEmailChange: fn });
}

describe('ChangeEmailConfirmPage', () => {
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('confirms on mount when the URL fragment carries a token, then scrubs it', async () => {
    setHashToken(TOKEN);
    const confirmFn = vi.fn().mockResolvedValue({ email: 'new@example.test' });
    mockConfirm(confirmFn);

    render(
      <MemoryRouter>
        <ChangeEmailConfirmPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(confirmFn).toHaveBeenCalledWith(TOKEN);
    });
    expect(await screen.findByText(/new@example.test/)).toBeInTheDocument();
    expect(screen.getByText(/sign-in email is now/i)).toBeInTheDocument();
    // The fragment is scrubbed from the URL.
    expect(window.location.hash).toBe('');
  });

  it('shows the API error message when the token is rejected', async () => {
    setHashToken(TOKEN);
    mockConfirm(
      vi.fn().mockRejectedValue(
        new ApiRequestError(410, {
          code: 'CHANGE_EMAIL_TOKEN_EXPIRED',
          message: 'Email-change link has expired. Request a new one.',
        }),
      ),
    );

    render(
      <MemoryRouter>
        <ChangeEmailConfirmPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email-change link has expired. Request a new one.',
    );
  });

  it('reports an error when the token is missing from the link', async () => {
    setHashToken(null);
    const confirmFn = vi.fn();
    mockConfirm(confirmFn);

    render(
      <MemoryRouter>
        <ChangeEmailConfirmPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/token is missing/i);
    expect(confirmFn).not.toHaveBeenCalled();
  });
});
