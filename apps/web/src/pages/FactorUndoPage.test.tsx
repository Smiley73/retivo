// FactorUndoPage. The prefetch defence is load-bearing: a mail client or scanner may GET this page, so the undo must not run until an explicit button click.
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
}));

import { apiRequest } from '../api/client';
import { FactorUndoPage } from './FactorUndoPage';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'undo-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setHash(fields: string | null): void {
  window.history.replaceState(null, '', `/auth/factor-undo${fields ? `#${fields}` : ''}`);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FactorUndoPage />
    </MemoryRouter>,
  );
}

describe('FactorUndoPage', () => {
  const initialHref = window.location.href;

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', initialHref);
  });

  it('scrubs the token from the URL fragment on mount', async () => {
    setHash(`u=${USER_ID}&t=${TOKEN}&k=passkey_add`);
    renderPage();
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('performs nothing on mount — the undo only runs on the explicit click', async () => {
    setHash(`u=${USER_ID}&t=${TOKEN}&k=passkey_add`);
    renderPage();
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('renders the passkey-add copy and consumes only on click', async () => {
    (apiRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setHash(`u=${USER_ID}&t=${TOKEN}&k=passkey_add`);
    renderPage();
    expect(
      screen.getByText(/removes the passkey that was just added/i),
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Remove it and sign out everywhere' });
    expect(apiRequest).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/factor-undo/consume', {
        method: 'POST',
        body: { userId: USER_ID, token: TOKEN, kind: 'passkey_add' },
        auth: false,
      }),
    );
    expect(await screen.findByText(/every device was signed out/i)).toBeInTheDocument();
  });

  it('renders removal-kind copy with a "sign out everywhere" button', async () => {
    setHash(`u=${USER_ID}&t=${TOKEN}&k=passkey_remove`);
    renderPage();
    expect(screen.getByText(/can't restore the passkey/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
  });

  it('an already-used-or-expired response renders the same message as a genuinely expired one', async () => {
    (apiRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    setHash(`u=${USER_ID}&t=${TOKEN}&k=passkey_add`);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Remove it and sign out everywhere' }));
    expect(
      await screen.findByText(/already been used or has expired/i),
    ).toBeInTheDocument();
  });

  it('a missing token shows an inline error and never calls the API', async () => {
    setHash(null);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(
      await screen.findByText(/missing its token/i),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('a link truncated after the token (no kind) shows an inline error and never calls the API', async () => {
    setHash(`u=${USER_ID}&t=${TOKEN}`);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(
      await screen.findByText(/missing information/i),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('passes axe accessibility checks in the pre-click state', async () => {
    setHash(`u=${USER_ID}&t=${TOKEN}&k=totp_add`);
    const { container } = renderPage();
    await expectNoA11yViolations(container);
  });
});
