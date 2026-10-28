import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expectNoA11yViolations } from '../test/a11y';

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

const TOKEN = 'test-approval-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setHashToken(token: string | null): void {
  window.history.replaceState(null, '', `/auth/decline-signup${token ? `#token=${token}` : ''}`);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DeclineSignupPage />
    </MemoryRouter>,
  );
}

// The prefetch defence is load-bearing: a mail client or scanner may GET this page, so nothing may be consumed until a button is clicked.
describe('DeclineSignupPage', () => {
  // Restore the initial URL after each test; replacing with `/` would leak across files in the same worker and break suites that read `window.location`.
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('scrubs the fragment on mount and sends no request', async () => {
    setHashToken(TOKEN);
    renderPage();
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('declines only on the click, once, and shows the confirmation', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockResolvedValueOnce({ declined: true, email: 'foo@example.com' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText(/foo@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/pending account has been deleted/)).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/decline-signup', {
      method: 'POST',
      body: { token: TOKEN },
      auth: false,
    });
  });

  it('shows the API error message when the token is rejected', async () => {
    setHashToken(TOKEN);
    (apiRequest as any).mockRejectedValueOnce(
      new ApiRequestError(410, {
        code: 'APPROVAL_TOKEN_EXPIRED',
        message: 'Approval link has expired.',
      }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Approval link has expired.');
  });

  it('a link without a token shows an inline error and never calls the API', async () => {
    setHashToken(null);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/missing its token/i);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('passes axe accessibility checks in the pre-click state', async () => {
    setHashToken(TOKEN);
    const { container } = renderPage();
    await expectNoA11yViolations(container);
  });
});
