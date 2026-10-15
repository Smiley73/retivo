/**
 * Tests for the Security-page AccountCard: account-record render, the Edit/Save/
 * Cancel form for name + birthdate, the email-change interactions (request →
 * pending; request → step-up → pending), the pending-state UI, and an a11y
 * smoke pass over the rendered card.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountCard } from './AccountCard';
import { expectNoA11yViolations } from '../test/a11y';

function renderCard(props: { email: string; onError: (m: string | null) => void }) {
  return render(
    <MemoryRouter>
      <AccountCard {...props} />
    </MemoryRouter>,
  );
}

// WebAuthn browser boundary: the passkey step-up factor prompts
// `startAuthentication`.
const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
}));

// Mock only `useAuth`; the rest of the module stays real.
vi.mock('../auth/AuthContext', async () => {
  const actual =
    await vi.importActual<typeof import('../auth/AuthContext')>('../auth/AuthContext');
  return {
    ...actual,
    useAuth: vi.fn(),
  };
});

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

const RECORD = {
  email: 'alice@example.test',
  firstName: 'Alice',
  lastName: 'Smith',
  birthdate: '1970-04-12',
};

const USER_ID = 'user-1';

function mockAuth(overrides: Record<string, unknown> = {}) {
  const fns = {
    me: { id: USER_ID },
    fetchAccountRecord: vi.fn().mockResolvedValue(RECORD),
    updateAccountRecord: vi.fn().mockResolvedValue(RECORD),
    changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: false }),
    sendEmailChangeOtp: vi.fn().mockResolvedValue(undefined),
    verifyEmailChangeStepUp: vi.fn().mockResolvedValue({}),
    stepUpPasskeyOptions: vi.fn().mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
    ...overrides,
  };
  (useAuth as any).mockReturnValue(fns);
  return fns;
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('AccountCard', () => {
  it('renders the read-only account record from /auth/me', async () => {
    mockAuth();
    renderCard({ email: "claim@example.test", onError: vi.fn() });

    // Email resolves from the fetched record (not the JWT-claim fallback).
    expect(await screen.findByText('alice@example.test')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    // Birthdate is formatted, not the raw ISO string.
    expect(screen.queryByText('1970-04-12')).not.toBeInTheDocument();
    // Copy distinguishes the account record from the household-plan people.
    expect(
      screen.getByText(/edited separately on the/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /household page/i })).toBeInTheDocument();
  });

  it('falls back to the JWT-claim email when /auth/me fails', async () => {
    mockAuth({ fetchAccountRecord: vi.fn().mockRejectedValue(new Error('boom')) });
    renderCard({ email: "claim@example.test", onError: vi.fn() });
    expect(await screen.findByText('claim@example.test')).toBeInTheDocument();
  });

  it('starts an email change (MFA off) and shows the pending state', async () => {
    const fns = mockAuth({ changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: false }) });
    renderCard({ email: "claim@example.test", onError: vi.fn() });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(fns.changeEmail).toHaveBeenCalledWith('new@example.test', 'Sup3rSecret!pw');
    });
    // Pending state: "check your inbox at <new address>".
    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
    expect(screen.getByText('new@example.test')).toBeInTheDocument();
  });

  it('runs the step-up factor when the request requires it (MFA on)', async () => {
    const fns = mockAuth({
      changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['email_otp'] }),
      verifyEmailChangeStepUp: vi.fn().mockResolvedValue({}),
    });
    renderCard({ email: "claim@example.test", onError: vi.fn() });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    // Step-up stage: send an email code, then verify it.
    const sendBtn = await screen.findByRole('button', { name: /email me a code/i });
    fireEvent.click(sendBtn);
    await waitFor(() => expect(fns.sendEmailChangeOtp).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/email code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm and send link/i }));
    await waitFor(() => {
      expect(fns.verifyEmailChangeStepUp).toHaveBeenCalledWith('email_otp', '123456', undefined);
    });
    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
  });

  it('shows the authenticator-code field (no send button) when step-up method is TOTP', async () => {
    const fns = mockAuth({
      changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['totp'] }),
      verifyEmailChangeStepUp: vi.fn().mockResolvedValue({}),
    });
    renderCard({ email: 'claim@example.test', onError: vi.fn() });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    // TOTP step-up: no "Email me a code" button, field labelled "Authenticator code".
    await waitFor(() => expect(fns.changeEmail).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /email me a code/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/authenticator code/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm and send link/i }));
    await waitFor(() => {
      expect(fns.verifyEmailChangeStepUp).toHaveBeenCalledWith('totp', '123456', undefined);
    });
    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
  });

  it('completes the step-up with a passkey assertion when step-up method is passkey', async () => {
    const assertionResponse = {
      id: 'cred-1',
      rawId: 'cred-1',
      response: {},
      clientExtensionResults: {},
      type: 'public-key',
    };
    startAuthentication.mockResolvedValue(assertionResponse);
    const fns = mockAuth({
      changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['passkey'] }),
      stepUpPasskeyOptions: vi
        .fn()
        .mockResolvedValue({ challenge: 'chal', allowCredentials: [] }),
      verifyEmailChangeStepUp: vi.fn().mockResolvedValue({}),
    });
    renderCard({ email: 'claim@example.test', onError: vi.fn() });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    // Passkey step-up: no code field, confirm prompts WebAuthn and posts the
    // assertion (no code) to the change-email verify-step-up endpoint.
    await waitFor(() => expect(fns.changeEmail).toHaveBeenCalled());
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /confirm and send link/i }));

    await waitFor(() =>
      expect(fns.stepUpPasskeyOptions).toHaveBeenCalledWith('change_email'),
    );
    await waitFor(() =>
      expect(startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: 'chal', allowCredentials: [] },
      }),
    );
    await waitFor(() =>
      expect(fns.verifyEmailChangeStepUp).toHaveBeenCalledWith(
        'passkey',
        '',
        assertionResponse,
      ),
    );
    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
  });

  it('shows the send-code error inline in the step-up modal when the send fails', async () => {
    const { ApiRequestError } = await import('../api/client');
    mockAuth({
      changeEmail: vi.fn().mockResolvedValue({ stepUpRequired: true, methods: ['email_otp'] }),
      sendEmailChangeOtp: vi
        .fn()
        .mockRejectedValue(
          new (ApiRequestError as any)(500, {
            code: 'SERVER_ERROR',
            message: 'Could not send OTP.',
          }),
        ),
    });
    renderCard({ email: 'claim@example.test', onError: vi.fn() });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    const sendBtn = await screen.findByRole('button', { name: /email me a code/i });
    fireEvent.click(sendBtn);

    // Step-up errors surface INLINE in the reusable modal.
    expect(await screen.findByText('Could not send OTP.')).toBeInTheDocument();
  });

  it('surfaces the API error message via onError on a failed request', async () => {
    const { ApiRequestError } = await import('../api/client');
    const onError = vi.fn();
    mockAuth({
      changeEmail: vi
        .fn()
        .mockRejectedValue(
          new (ApiRequestError as any)(409, {
            code: 'EMAIL_TAKEN',
            message: 'An account with this email already exists.',
          }),
        ),
    });
    renderCard({ email: 'claim@example.test', onError });
    await screen.findByText('alice@example.test');

    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/new email/i), {
      target: { value: 'taken@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText(/current password/i), {
      target: { value: 'Sup3rSecret!pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('An account with this email already exists.');
    });
  });

  it('has no a11y violations (card + open modal)', async () => {
    mockAuth();
    const { container } = renderCard({ email: 'claim@example.test', onError: vi.fn() });
    await screen.findByText('alice@example.test');
    fireEvent.click(screen.getByRole('button', { name: /change email/i }));
    await screen.findByRole('dialog');
    await expectNoA11yViolations(container);
  });

  describe('account-record edit form (account-editable-name-and-birthdate)', () => {
    it('edits and saves: seeds from the fetched record and renders the API response, not the typed values', async () => {
      const UPDATED = {
        email: 'alice@example.test',
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
      };
      const fns = mockAuth({ updateAccountRecord: vi.fn().mockResolvedValue(UPDATED) });
      renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      expect(screen.getByLabelText(/first name/i)).toHaveValue('Alice');
      expect(screen.getByLabelText(/last name/i)).toHaveValue('Smith');

      fireEvent.change(screen.getByLabelText(/first name/i), {
        target: { value: '  Alicia  ' },
      });
      fireEvent.change(screen.getByLabelText(/last name/i), {
        target: { value: '  Smythe  ' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(fns.updateAccountRecord).toHaveBeenCalledWith({
          firstName: 'Alicia',
          lastName: 'Smythe',
          birthdate: '1970-04-12',
        });
      });
      // Displays what the API returned, not the locally-typed values —
      // proven by the API mock returning a DIFFERENT last name/birthdate.
      expect(await screen.findByText('Alicia Smythe')).toBeInTheDocument();
    });

    it('error path: the rejection message is surfaced, the form stays open with the entered values, and the card keeps showing the original record', async () => {
      const { ApiRequestError } = await import('../api/client');
      mockAuth({
        updateAccountRecord: vi
          .fn()
          .mockRejectedValue(
            new (ApiRequestError as any)(400, {
              code: 'BAD_REQUEST',
              message: 'Could not save your account details.',
            }),
          ),
      });
      renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.change(screen.getByLabelText(/first name/i), {
        target: { value: 'Alicia' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(
        await screen.findByText('Could not save your account details.'),
      ).toBeInTheDocument();
      // Form stays open with the entered value.
      expect(screen.getByLabelText(/first name/i)).toHaveValue('Alicia');

      // The underlying record was never overwritten by the failed save:
      // cancelling reveals the original, unchanged display.
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    });

    it('client validation blocks the save and makes no request: blank name', async () => {
      const fns = mockAuth();
      renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByText('Enter a first name.')).toBeInTheDocument();
      expect(fns.updateAccountRecord).not.toHaveBeenCalled();
    });

    it('client validation blocks the save and makes no request: blank last name', async () => {
      const fns = mockAuth();
      renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.change(screen.getByLabelText(/last name/i), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByText('Enter a last name.')).toBeInTheDocument();
      expect(fns.updateAccountRecord).not.toHaveBeenCalled();
    });

    it.each([
      ['a future date', '2999-01-01', 'Date of birth cannot be in the future.'],
      ['120+ years ago', '1800-01-01', 'Date of birth must be within the last 120 years.'],
    ])(
      'client validation blocks the save and makes no request: %s',
      async (_label, badDate, message) => {
        // Drive the out-of-range value through the fetched record (seeded
        // into the DatePicker on Edit) rather than simulating segment-by-
        // segment keyboard entry — `validateBirthdate` runs on Save
        // regardless of whether the value was typed or seeded, so this
        // exercises the same client-validation path without depending on
        // React Aria's segment-typing internals.
        const fns = mockAuth({
          fetchAccountRecord: vi.fn().mockResolvedValue({ ...RECORD, birthdate: badDate }),
        });
        renderCard({ email: 'claim@example.test', onError: vi.fn() });
        await screen.findByText('alice@example.test');

        fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(fns.updateAccountRecord).not.toHaveBeenCalled();
      },
    );

    it('a successful save renders the updated record and writes nothing personal to browser storage', async () => {
      mockAuth({
        updateAccountRecord: vi.fn().mockResolvedValue({
          ...RECORD,
          firstName: 'Alicia',
          lastName: 'Jones',
        }),
      });
      renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Alicia' } });
      fireEvent.change(screen.getByLabelText(/last name/i), { target: { value: 'Jones' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(screen.getByText('Alicia Jones')).toBeInTheDocument();
      });
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i)!;
          const entry = `${key}=${storage.getItem(key)}`;
          expect(entry).not.toContain('Alicia');
          expect(entry).not.toContain('Jones');
          expect(entry).not.toContain('1970-04-12');
        }
      }
    });

    it('has no a11y violations with the edit form open', async () => {
      mockAuth();
      const { container } = renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');
      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      await screen.findByLabelText(/first name/i);
      await expectNoA11yViolations(container);
    });

    it('has no a11y violations with a field error rendered (the error must be associated with its field)', async () => {
      mockAuth();
      const { container } = renderCard({ email: 'claim@example.test', onError: vi.fn() });
      await screen.findByText('alice@example.test');
      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await screen.findByText('Enter a first name.');
      await expectNoA11yViolations(container);
    });
  });
});
