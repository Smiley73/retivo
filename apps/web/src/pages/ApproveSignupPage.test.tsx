/**
 * Tests for the ApproveSignupPage component.
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
import { ApproveSignupPage } from './ApproveSignupPage';

const TOKEN = 'test-approval-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setHashToken(token: string | null): void {
  // jsdom 'window.location' is mutable; setting hash triggers a hashchange.
  window.history.replaceState(null, '', `/auth/approve-signup${token ? `#token=${token}` : ''}`);
}

describe('ApproveSignupPage', () => {
  // Snapshot the initial URL once so we restore the exact same value the
  // worker started with after each test. Replacing with `/` instead would
  // leak across files in the same vitest worker and break unrelated
  // suites that read `window.location`.
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('approves on mount when the URL fragment carries a token', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockResolvedValueOnce({ approved: true, email: 'foo@example.com' });

    render(
      <MemoryRouter>
        <ApproveSignupPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/auth/approve-signup',
        expect.objectContaining({
          method: 'POST',
          body: { token: TOKEN },
          auth: false,
        }),
      );
    });
    expect(await screen.findByText(/foo@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/can now sign in/)).toBeInTheDocument();

    // Fragment is scrubbed from the URL.
    expect(window.location.hash).toBe('');
  });

  it('shows the API error message when the token is rejected', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockRejectedValueOnce(
      new ApiRequestError(410, {
        code: 'APPROVAL_TOKEN_EXPIRED',
        message: 'Approval link has expired.',
      }),
    );

    render(
      <MemoryRouter>
        <ApproveSignupPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Approval link has expired.',
    );
  });

  it('reports an error when the token is missing from the link', async () => {
    setHashToken(null);

    render(
      <MemoryRouter>
        <ApproveSignupPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /token is missing/i,
    );
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
