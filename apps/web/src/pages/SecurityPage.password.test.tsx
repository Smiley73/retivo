/**
 * Component tests for the Security page's change-password modal: the
 * unsaved-changes guard (Esc / Cancel) and password-manager interop (native
 * form + tokens). Renders through SecurityPage, which hosts the card.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SecurityPage } from '../pages/SecurityPage';
import { ISSUES_URL } from '../lib/brand';

vi.mock('react-router', async () => (await import('./security-page.test-harness')).reactRouterMock());
vi.mock('../db/store', async () => (await import('./security-page.test-harness')).dbStoreMock());
vi.mock('../lib/local-data', async () => (await import('./security-page.test-harness')).localDataMock());
vi.mock('../db/monte-carlo-cache', async () => (await import('./security-page.test-harness')).monteCarloCacheMock());
vi.mock('../lib/demo-data-loader', async () => (await import('./security-page.test-harness')).demoDataLoaderMock());
vi.mock('../api/client', async () => (await import('./security-page.test-harness')).apiClientMock());
vi.mock('../auth/AuthContext', async () => (await import('./security-page.test-harness')).authContextMock());
vi.mock('../contexts/ThemeContext', async () => (await import('./security-page.test-harness')).themeContextMock());
vi.mock('../sync/SyncContext', async () => (await import('./security-page.test-harness')).syncContextMock());
vi.mock('../lib/data-export', async () => (await import('./security-page.test-harness')).dataExportMock());
vi.mock('../lib/data-import', async () => (await import('./security-page.test-harness')).dataImportMock());
vi.mock('../auth/key-envelope-client', async () => (await import('./security-page.test-harness')).keyEnvelopeClientMock());

import { useAuth } from '../auth/AuthContext';
import { securityAuthValue } from './security-page.test-harness';

function renderPage(overrides: Record<string, unknown> = {}) {
  (useAuth as any).mockReturnValue(securityAuthValue({ isUnlocked: true, needsKeySetup: false }, overrides));
  return render(<MemoryRouter><SecurityPage /></MemoryRouter>);
}

async function openPasswordModal() {
  // Wait for the page to settle (listPasskeys resolves), then click
  // "Change password". Opened via userEvent so React Aria's modal
  // focus management runs (focus moves into the dialog) — the Esc-to-
  // dismiss tests below rely on focus being inside the overlay, exactly
  // as it is for a real user.
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  await waitFor(() => expect(screen.getByLabelText('Current password')).toBeInTheDocument());
}

describe('SecurityPage change-password modal — unsaved-changes guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Cancel button after typing closes immediately (intentional discard)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Security' }),
    ).toBeInTheDocument();
    await openPasswordModal();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldsecret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('Esc while typing surfaces the Stay/Leave prompt', async () => {
    const user = userEvent.setup();
    renderPage();
    await openPasswordModal();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'oldsecret' } });

    // React Aria's modal owns Esc-to-dismiss — drive it via
    // userEvent, not a synthetic document keydown.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('Esc on an unedited modal closes immediately (no prompt)', async () => {
    const user = userEvent.setup();
    renderPage();
    await openPasswordModal();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});

describe('SecurityPage change-password modal — password-manager interop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a native form: name/autocomplete tokens + hidden username', async () => {
    renderPage();
    await openPasswordModal();

    const current = screen.getByLabelText('Current password');
    const next = screen.getByLabelText('New password');
    const confirm = screen.getByLabelText('Confirm new password');
    // Real <form> + tokens: managers detect the change-password shape,
    // offer "update password?", and can fill-and-submit.
    const form = current.closest('form');
    expect(form).not.toBeNull();
    expect(current).toHaveAttribute('name', 'current-password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');
    expect(next).toHaveAttribute('name', 'new-password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm).toHaveAttribute('name', 'confirm-new-password');
    expect(confirm).toHaveAttribute('autocomplete', 'new-password');
    const username = form!.querySelector('input[name="username"]');
    expect(username).not.toBeNull();
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(username).toHaveValue('me@local.test');
  });

  it('a failed follow-up attempt clears the still-visible success notice (no contradictory status)', async () => {
    const { ApiRequestError } = await import('../api/client');
    const changePassword = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      // A rejected transaction — nothing changed, safe to retry from
      // this same form, unlike the lost-response path (covered separately).
      .mockRejectedValueOnce(new ApiRequestError(409, { code: 'PASSWORD_SAME_AS_CURRENT', message: 'boom' }));
    renderPage({ changePassword });
    await openPasswordModal();

    const fillValid = () => {
      fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-123456' } });
      fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-123456' } });
    };
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText(/Password changed successfully/)).toBeInTheDocument(),
    );

    // Reopen inside the 4s notice window; the second attempt fails at the
    // API. The stale success notice must clear when the new attempt starts —
    // success and failure status must never show together.
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('boom')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Password changed successfully/)).not.toBeInTheDocument();
  });

  it('Enter submits the form when valid, and is gated by the same validation as the button', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    renderPage({ changePassword });
    await openPasswordModal();

    const form = screen.getByLabelText('Current password').closest('form');
    expect(form).not.toBeNull();

    // Invalid (empty fields): submit is a no-op.
    fireEvent.submit(form!);
    expect(changePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.submit(form!);
    await waitFor(() =>
      // Flag-off floor: password-only, no step-up factor.
      expect(changePassword).toHaveBeenCalledWith('OldSecret-123', 'NewSecret-123456', undefined),
    );
  });
});

describe('SecurityPage change-password modal — password policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the 16-character + special-character requirement copy in an info-icon tooltip', async () => {
    const user = userEvent.setup();
    renderPage();
    await openPasswordModal();
    // The requirement copy now lives behind an info-(i) tooltip next to the
    // "New password" label rather than an always-visible hint. It is hidden
    // until the keyboard-focusable trigger is hovered/focused.
    const trigger = screen.getByLabelText('Password requirements');
    expect(trigger).toHaveClass('cursor-help');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Min 16 characters, must include uppercase, lowercase, a digit, and a special character. Common passwords are rejected.',
    );
  });

  it('keeps submit disabled for a 15-character new password (below the 16-char minimum)', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    renderPage({ changePassword });
    await openPasswordModal();
    const form = screen.getByLabelText('Current password').closest('form')!;
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    // 15 chars, otherwise compliant (upper + lower + digit + special).
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-12345' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-12345' } });
    expect(within(form).getByRole('button', { name: 'Change password' })).toBeDisabled();
    // The identically-gated onSubmit is a no-op even if fired directly.
    fireEvent.submit(form);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('keeps submit disabled for a 16-character new password missing a special character', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    renderPage({ changePassword });
    await openPasswordModal();
    const form = screen.getByLabelText('Current password').closest('form')!;
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    // 16 chars, upper + lower + digit, but NO special character.
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecretPass123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecretPass123' } });
    expect(within(form).getByRole('button', { name: 'Change password' })).toBeDisabled();
    fireEvent.submit(form);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('enables submit and changes with a compliant 16+ character special-character new password', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    renderPage({ changePassword });
    await openPasswordModal();
    const form = screen.getByLabelText('Current password').closest('form')!;
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-123456' } });
    expect(within(form).getByRole('button', { name: 'Change password' })).toBeEnabled();
    fireEvent.submit(form);
    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith('OldSecret-123', 'NewSecret-123456', undefined),
    );
  });
});

describe('SecurityPage change-password card — offered only on an unlocked workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a locked workspace offers no change and states the way forward', async () => {
    renderPage({ isUnlocked: false, needsKeySetup: false });
    await waitFor(() =>
      expect(
        screen.getByText(/Unlock your data on this device before changing your password/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
  });

  it('an account that never completed key setup offers no change and states the way forward', async () => {
    renderPage({ isUnlocked: false, needsKeySetup: true });
    await waitFor(() =>
      expect(
        screen.getByText(/Finish setting up encryption for this account/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
  });
});

describe('SecurityPage change-password modal — rejected / upgrade-required / lost-response paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fillValid = () => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-123456' } });
  };

  it('the upgrade-required answer renders as a reload prompt, not a validation error', async () => {
    const { ApiRequestError } = await import('../api/client');
    const changePassword = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(409, { code: 'UPGRADE_REQUIRED', message: 'Reload the page to continue.' }));
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText(/A newer version of this page is available. Reload/i)).toBeInTheDocument(),
    );
    // Never shown as a raw validation-style server message.
    expect(screen.queryByText('Reload the page to continue.')).not.toBeInTheDocument();
  });

  it('a rejected transaction surfaces the server message and keeps the form open for a retry', async () => {
    const { ApiRequestError } = await import('../api/client');
    const changePassword = vi
      .fn()
      .mockRejectedValue(new ApiRequestError(409, { code: 'STALE_ENVELOPE_VERSION', message: 'Envelope-set version is stale or non-monotonic.' }));
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('Envelope-set version is stale or non-monotonic.')).toBeInTheDocument(),
    );
    // The form stays open (nothing changed — safe to retry).
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('PASSWORD_SLOT_NOT_CANONICAL renders the Report an issue on GitHub link in the page alert, keyed on the code', async () => {
    const { ApiRequestError } = await import('../api/client');
    // The server message is deliberately URL-free; the link is the web's.
    const changePassword = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(409, {
          code: 'PASSWORD_SLOT_NOT_CANONICAL',
          message: 'Any server wording at all.',
        }),
      );
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    const link = await screen.findByRole('link', { name: 'Report an issue on GitHub' });
    expect(link).toHaveAttribute('href', ISSUES_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const alert = link.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).not.toHaveTextContent(/support/i);
    // The node replaces the server's message rather than joining it.
    expect(screen.queryByText(/Any server wording at all/)).not.toBeInTheDocument();
    // The form stays open (nothing changed — safe to retry).
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('a 503 CHANGE_PASSWORD_CONFLICT (a pre-commit transient failure) is treated as rejected, not lost — no sign-in-again wording, form stays open for a retry', async () => {
    // The server only ever throws CHANGE_PASSWORD_CONFLICT from inside
    // `runTransactWrite`'s TransientTransactionError catch, which fires
    // strictly BEFORE any session revocation/denylisting/re-issue — the old
    // password still signs in and the new one was never committed. Treating
    // this as 'indeterminate' would send the user to sign in with a password
    // guaranteed to be wrong, burning an attempt against the shared backoff.
    const { ApiRequestError } = await import('../api/client');
    const changePassword = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(503, {
          code: 'CHANGE_PASSWORD_CONFLICT',
          message: 'Could not save this change right now. Try again.',
        }),
      );
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('Could not save this change right now. Try again.')).toBeInTheDocument(),
    );
    // The form stays open (nothing changed — safe to retry), not the
    // lost-response sign-in-again wording.
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(
      screen.queryByText(/We could not confirm whether your password changed\. Sign in again/i),
    ).not.toBeInTheDocument();
  });

  it('the lost-response path: no automatic retry, no claimed verdict, sign-in-again wording, and no route back to the form', async () => {
    // A non-ApiRequestError (network/timeout) — apiRequest never resolved a
    // verdict, so there is nothing to distinguish "rejected" from "committed".
    const changePassword = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    // The wording appears in the page-level alert AND in the card's
    // persistent notice that replaced the trigger.
    await waitFor(() =>
      expect(
        screen.getAllByText(/We could not confirm whether your password changed\. Sign in again/i)
          .length,
      ).toBeGreaterThan(0),
    );
    // Called exactly once — no automatic retry.
    expect(changePassword).toHaveBeenCalledTimes(1);
    // The form closed rather than inviting a replay of the old password.
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    // …and the change action cannot be REOPENED either: the card's trigger is
    // replaced by the sign-in-again notice, so there is no route back to a
    // form that would replay the old password against the shared login
    // backoff (e.g. after a commit whose execution failed before session
    // revocation, when the old session still answers).
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
  });

  it('a preparation failure (not-sent) surfaces the specific reason and keeps the form open — never the sign-in-again wording', async () => {
    // PasswordChangeNotSentError exists precisely to tell a prepare-phase
    // failure (locked workspace, stale/tampered slot set — nothing ever left
    // the client) apart from a lost response: the old behaviour told the
    // user to sign in with a NEW password that was never set server-side.
    const { PasswordChangeNotSentError } = await import('../auth/types');
    const changePassword = vi
      .fn()
      .mockRejectedValue(
        new PasswordChangeNotSentError('Unlock your data before changing your password.'),
      );
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('Unlock your data before changing your password.')).toBeInTheDocument(),
    );
    // Nothing was sent — definitely unchanged, safe to retry from this form.
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(
      screen.queryByText(/We could not confirm whether your password changed\. Sign in again/i),
    ).not.toBeInTheDocument();
  });

  it('a confirmed commit whose device confirmation failed shows the change-succeeded notice, not the sign-in-again wording, and offers no route back to the form', async () => {
    // PasswordChangeCommittedError is a KNOWN post-commit state (the server
    // answered 200; only the device-side rollback-pin write failed, and the
    // workspace was locked fail-closed): the card must never claim ignorance
    // of a verdict the client has, and must never reopen a form that would
    // replay the now-definitely-wrong old password.
    const { PasswordChangeCommittedError } = await import('../auth/types');
    const changePassword = vi
      .fn()
      .mockRejectedValue(
        new PasswordChangeCommittedError(
          'Your password was changed, but this device could not finish updating. Unlock your data with your new password to continue.',
        ),
      );
    renderPage({ changePassword });
    await openPasswordModal();
    fillValid();
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);
    await waitFor(() =>
      expect(
        screen.getAllByText(/Your password was changed, but this device could not finish updating/i)
          .length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByText(/We could not confirm whether your password changed\. Sign in again/i),
    ).not.toBeInTheDocument();
    // The form closed and the trigger is gone — no route back.
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
  });
});

describe('SecurityPage change-password modal — step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a fresh factor when step-up is enforced, then changes with the proof', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    const stepUpSendEmailOtp = vi.fn().mockResolvedValue(undefined);
    renderPage({
      changePassword,
      stepUpSendEmailOtp,
      // AUTH_MFA_ENFORCED on → GET /auth/mfa/status reports step-up required
      // with the Email-OTP no-lockout floor as the only factor.
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: false,
        stepUpRequired: true,
        methods: ['email_otp'],
        recoveryMethods: [],
      }),
    });
    await openPasswordModal();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldSecret-123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewSecret-123456' } });
    fireEvent.submit(screen.getByLabelText('Current password').closest('form')!);

    // The reusable step-up modal opens; the change has NOT run yet.
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(changePassword).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Email me a code/i }));
    await waitFor(() => expect(stepUpSendEmailOtp).toHaveBeenCalledWith('change_password'));
    fireEvent.change(within(dialog).getByLabelText('Email code'), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith('OldSecret-123', 'NewSecret-123456', {
        method: 'email_otp',
        code: '123456',
      }),
    );
  });
});
