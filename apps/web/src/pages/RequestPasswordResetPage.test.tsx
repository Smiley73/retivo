import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
}));

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
import { RequestPasswordResetPage } from './RequestPasswordResetPage';

function renderPage(requestPasswordReset = vi.fn()) {
  (useAuth as any).mockReturnValue({ requestPasswordReset });
  return render(
    <MemoryRouter>
      <RequestPasswordResetPage />
    </MemoryRouter>,
  );
}

describe('RequestPasswordResetPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('warns up front that a reset does not unlock encrypted data', () => {
    renderPage();
    expect(screen.getByText(/recovery key/i)).toBeInTheDocument();
    expect(screen.getByText(/can.?t be recovered/i)).toBeInTheDocument();
  });

  it('submits the email and shows the opaque success copy', async () => {
    const fn = vi.fn().mockResolvedValue({ accepted: true });
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(fn).toHaveBeenCalledWith('user@test.com');
    });
    expect(
      await screen.findByText(/if an account exists for that email/i),
    ).toBeInTheDocument();
  });

  it('renders a dev shortcut link when the response carries a token', async () => {
    const fn = vi.fn().mockResolvedValue({ accepted: true, resetToken: 'dev-token-123' });
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    const link = await screen.findByRole('link', { name: 'reset now' });
    expect(link).toHaveAttribute('href', '/auth/reset-password#token=dev-token-123');
  });

  it('surfaces an API error message', async () => {
    const { ApiRequestError } = await import('../api/client');
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(429, { code: 'RATE_LIMITED', message: 'Slow down.' }));
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Slow down.')).toBeInTheDocument();
  });

  it('shows the busy sentence for a no-envelope 5xx', async () => {
    const { ApiRequestError } = await import('../api/client');
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' }));
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText('The service is busy right now. Please try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('a genuine enveloped 5xx renders its own message, not the busy copy', async () => {
    const { ApiRequestError } = await import('../api/client');
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Something broke.' }));
    renderPage(fn);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@test.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Something broke.')).toBeInTheDocument();
    expect(
      screen.queryByText('The service is busy right now. Please try again in a moment.'),
    ).not.toBeInTheDocument();
  });
});
