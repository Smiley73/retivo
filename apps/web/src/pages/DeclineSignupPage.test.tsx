/**
 * Tests for the DeclineSignupPage component.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../api/client', () => ({
  apiRequest: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
  configureApi: vi.fn(),
}));

import { apiRequest, ApiRequestError } from '../api/client';
import { DeclineSignupPage } from './DeclineSignupPage';

const TOKEN = 'decline-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function setHashToken(token: string | null): void {
  window.history.replaceState(null, '', `/auth/decline-signup${token ? `#token=${token}` : ''}`);
}

describe('DeclineSignupPage', () => {
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('declines on mount when the URL fragment carries a token', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockResolvedValueOnce({ declined: true, email: 'spam@example.com' });

    render(
      <MemoryRouter>
        <DeclineSignupPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/auth/decline-signup',
        expect.objectContaining({
          method: 'POST',
          body: { token: TOKEN },
          auth: false,
        }),
      );
    });
    expect(await screen.findByText(/spam@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/has been deleted/)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('shows the API error message when the token is rejected', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockRejectedValueOnce(
      new ApiRequestError(400, {
        code: 'APPROVAL_TOKEN_INVALID',
        message: 'Approval link is invalid or has already been used.',
      }),
    );

    render(
      <MemoryRouter>
        <DeclineSignupPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /already been used/i,
    );
  });

  it('reports an error when the token is missing from the link', async () => {
    setHashToken(null);

    render(
      <MemoryRouter>
        <DeclineSignupPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /token is missing/i,
    );
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
