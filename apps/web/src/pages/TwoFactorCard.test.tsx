/**
 * TwoFactorCard tests. Covers the page-level 2FA
 * state machine: the load → TOTP-disabled / TOTP-enabled fork, the inline
 * enroll → enabled flow, the password-only disable step-up, and the
 * forget-device error surface.
 *
 * Enroll: `enrollStart` runs as soon as "Set up"
 * is clicked — no gate first, since it writes nothing sensitive. Continue on
 * the QR screen opens the password (+ step-up, when enforced) gate; the live
 * authenticator code is typed in whichever of those is the LAST step, and
 * THAT modal's own Continue/submit performs the real
 * `enrollTotpConfirm(code, password, proof)` write. So a wrong password,
 * step-up code or authenticator code is verified for real and surfaces on
 * the modal that owns the field, with the field still editable,
 * and the ~1-minute TOTP code is seconds
 * old when spent rather than frozen before an emailed-code round trip.
 *
 * `useAuth` is fully mocked; `qrcode` and `../api/client` are stubbed exactly
 * as TotpEnrollment.test.tsx does (TwoFactorCard renders TotpEnrollment, which
 * draws a QR client-side).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoFactorCard } from './TwoFactorCard';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,MOCK') },
}));

vi.mock('../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
}));

type AuthMocks = {
  me: { email: string };
  getMfaStatus: ReturnType<typeof vi.fn>;
  enrollTotpStart: ReturnType<typeof vi.fn>;
  enrollTotpConfirm: ReturnType<typeof vi.fn>;
  disableTotp: ReturnType<typeof vi.fn>;
  confirmTotpRestriction: ReturnType<typeof vi.fn>;
  listTrustedDevices: ReturnType<typeof vi.fn>;
  forgetDevices: ReturnType<typeof vi.fn>;
  stepUpPasskeyOptions: ReturnType<typeof vi.fn>;
  stepUpSendEmailOtp: ReturnType<typeof vi.fn>;
};

let auth: AuthMocks;

function makeAuth(overrides: Partial<AuthMocks> = {}): AuthMocks {
  return {
    me: { email: 'test@example.com' },
    getMfaStatus: vi.fn().mockResolvedValue({ totpEnabled: false }),
    enrollTotpStart: vi
      .fn()
      .mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' }),
    enrollTotpConfirm: vi.fn().mockResolvedValue({ totpEnabled: true, noticeSent: true }),
    disableTotp: vi.fn().mockResolvedValue({ totpEnabled: false, noticeSent: true }),
    confirmTotpRestriction: vi.fn().mockResolvedValue(undefined),
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    forgetDevices: vi.fn().mockResolvedValue(undefined),
    stepUpPasskeyOptions: vi.fn().mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
    stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Click "Set up authenticator app" and wait for the QR screen — enrollStart
 * runs unconditionally, no gate first. */
async function openTotpEnrollment(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
  await screen.findByRole('button', { name: 'Continue' });
}

/** Continue from the QR screen, opening the password gate (no dialog is open
 * yet, so the only Continue on the page is the QR screen's). */
function continueFromQr(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

/** The enforced-flag status shape for an account with no enrolled factor —
 * the emailed code is its only (floor) step-up factor. */
const ENFORCED_EMAIL_ONLY = {
  totpEnabled: false,
  stepUpRequired: true,
  methods: ['email_otp'],
  recoveryMethods: [],
};

function mount(overrides: Partial<AuthMocks> = {}): ReturnType<typeof render> {
  auth = makeAuth(overrides);
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue(auth);
  return render(<TwoFactorCard />);
}

describe('TwoFactorCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Loading… then the authenticator section after status resolves', async () => {
    mount();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
    expect(auth.getMfaStatus).toHaveBeenCalledTimes(1);
    expect(auth.listTrustedDevices).toHaveBeenCalledTimes(1);
  });

  it('offers Set up authenticator app when TOTP is disabled', async () => {
    mount();
    expect(
      await screen.findByRole('button', { name: 'Set up authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('offers Disable without a saved recovery-code action when TOTP is enabled', async () => {
    mount({
      getMfaStatus: vi
        .fn()
        .mockResolvedValue({ totpEnabled: true }),
    });
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recovery codes' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set up authenticator app' }),
    ).not.toBeInTheDocument();
  });

  it('starts enrollment immediately on Set up — no gate before the QR screen', async () => {
    mount();
    await openTotpEnrollment();
    expect(auth.enrollTotpStart).toHaveBeenCalledTimes(1);
    // No password/step-up modal is open yet — the gate runs from Continue,
    // not before the QR screen; and the QR screen collects no code (that is
    // typed in the last gate modal, seconds before it is spent).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authenticator app code')).not.toBeInTheDocument();
  });

  it('gates the enroll write behind the password prompt — which collects the live code LAST on the flag-off floor — then finishes enrollment', async () => {
    const getMfaStatus = vi
      .fn()
      .mockResolvedValueOnce({ totpEnabled: false })
      .mockResolvedValue({ totpEnabled: true });
    mount({ getMfaStatus });
    await openTotpEnrollment();
    continueFromQr();

    const dialog = await screen.findByRole('dialog');
    // The write has NOT run yet — only the password gate has opened.
    expect(auth.enrollTotpConfirm).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    // The password alone is not enough — the live code is typed here too.
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Authenticator app code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    // The password gate's own Continue carries password + just-typed code
    // into the real confirm write (flag-off floor: no step-up proof).
    await waitFor(() =>
      expect(auth.enrollTotpConfirm).toHaveBeenCalledWith('123456', 'pw123456', undefined),
    );
    expect(await screen.findByText(/Enabled\. Codes from your authenticator app/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /recovery codes/i })).not.toBeInTheDocument();
    expect(getMfaStatus).toHaveBeenCalledTimes(2);
  });

  // The server always emails the account when the
  // authenticator app is added or removed, with a single-use undo link — the
  // card tells the person the notice was sent.
  it('shows the factor-change notice line after finishing enrollment', async () => {
    const getMfaStatus = vi
      .fn()
      .mockResolvedValueOnce({ totpEnabled: false })
      .mockResolvedValue({ totpEnabled: true });
    mount({ getMfaStatus });
    await openTotpEnrollment();
    continueFromQr();

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.change(within(dialog).getByLabelText('Authenticator app code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText(/Authenticator app added\. We emailed you/i),
    ).toBeInTheDocument();
  });

  it('shows the factor-change notice line after disabling', async () => {
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({ totpEnabled: true }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(
      await screen.findByText(/Authenticator app removed\. We emailed you a heads-up/i),
    ).toBeInTheDocument();
  });

  // The server reports `noticeSent: false` when the notice mail could not be
  // sent (SES rejected it, or the undo token could not be stored). The card
  // must not claim an email went out in that state.
  it('warns instead of claiming an email when the enrollment notice was not sent', async () => {
    const getMfaStatus = vi
      .fn()
      .mockResolvedValueOnce({ totpEnabled: false })
      .mockResolvedValue({ totpEnabled: true });
    mount({
      getMfaStatus,
      enrollTotpConfirm: vi.fn().mockResolvedValue({ totpEnabled: true, noticeSent: false }),
    });
    await openTotpEnrollment();
    continueFromQr();

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.change(within(dialog).getByLabelText('Authenticator app code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    const line = await screen.findByTestId('totp-factor-notice');
    expect(line).toHaveTextContent(/Authenticator app added, but we couldn't email you/i);
    expect(line).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/We emailed you/i)).not.toBeInTheDocument();
    // The factor itself is still enabled — only the notice failed.
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('warns instead of claiming an email when the disable notice was not sent', async () => {
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({ totpEnabled: true }),
      disableTotp: vi.fn().mockResolvedValue({ totpEnabled: false, noticeSent: false }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));

    const line = await screen.findByTestId('totp-factor-notice');
    expect(line).toHaveTextContent(/Authenticator app removed, but we couldn't email you a heads-up/i);
    expect(screen.queryByText(/We emailed you/i)).not.toBeInTheDocument();
  });

  it('surfaces a wrong password on the password modal with every field still editable', async () => {
    const enrollTotpConfirm = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(401, {
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        }),
      );
    mount({ enrollTotpConfirm });
    await openTotpEnrollment();
    continueFromQr();

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'wrongpw' },
    });
    fireEvent.change(within(dialog).getByLabelText('Authenticator app code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    // The real write ran and really failed — the wrong-password error shows
    // on the modal that collected it, and both fields are still there to fix.
    await waitFor(() =>
      expect(within(dialog).getByText('Current password is incorrect.')).toBeInTheDocument(),
    );
    expect(within(dialog).getByLabelText('Authenticator app code')).toHaveValue('123456');

    // Canceling the gate returns to the still-open QR screen behind it (the
    // pending secret is not lost) rather than aborting enrollment outright.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(auth.enrollTotpStart).toHaveBeenCalledTimes(1);
  });

  it('shows an error Alert when forgetting a device fails', async () => {
    mount({
      listTrustedDevices: vi.fn().mockResolvedValue([
        {
          deviceId: 'dev-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-02-01T00:00:00.000Z',
          lastUsedAt: '2026-01-10T00:00:00.000Z',
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120',
        },
      ]),
      // Reject with a non-Error value so errMessage falls back to the
      // user-facing copy this test asserts on (an Error would surface its own
      // message instead).
      forgetDevices: vi.fn().mockRejectedValue('network down'),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    expect(await screen.findByText(/could not forget that device/i)).toBeInTheDocument();
  });

  it('disables TOTP via the password-only step-up (no code field, no verify-password)', async () => {
    const { container } = mount({
      getMfaStatus: vi
        .fn()
        .mockResolvedValue({ totpEnabled: true }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    // The disable modal collects only a password — the live-code field is gone.
    const dialog = await screen.findByRole('dialog');
    await expectNoA11yViolations(container);
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    expect(within(dialog).queryByLabelText('Authenticator code')).toBeNull();
    // The dialog's own primary action (not the card's Disable button) submits.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      // Flag-off floor: password-only, no step-up factor.
      expect(auth.disableTotp).toHaveBeenCalledWith('pw123456', undefined);
    });
  });

  it('passes axe accessibility checks once loaded', async () => {
    const { container } = mount();
    await screen.findByRole('button', { name: 'Set up authenticator app' });
    await expectNoA11yViolations(container);
  });

  it('gates disable behind the reusable step-up modal when enforced, then disables with the proof', async () => {
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: true,
        stepUpRequired: true,
        methods: ['email_otp'],
        recoveryMethods: [],
      }),
    });
    // Card "Disable" → password prompt.
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Disable' }));

    // The reusable step-up modal opens; the disable has NOT run yet.
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(auth.disableTotp).not.toHaveBeenCalled();

    const factorDialog = screen.getByRole('dialog');
    fireEvent.click(within(factorDialog).getByRole('button', { name: /Email me a code/i }));
    await waitFor(() =>
      expect(auth.stepUpSendEmailOtp).toHaveBeenCalledWith('mfa_totp_disable'),
    );
    fireEvent.change(within(factorDialog).getByLabelText('Email code'), {
      target: { value: '654321' },
    });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(auth.disableTotp).toHaveBeenCalledWith('pw123456', {
        method: 'email_otp',
        code: '654321',
      }),
    );
  });

  it('gates the enroll write behind the reusable step-up modal when enforced — which collects the live code LAST — then confirms with code, password and proof together', async () => {
    mount({ getMfaStatus: vi.fn().mockResolvedValue(ENFORCED_EMAIL_ONLY) });
    await openTotpEnrollment();
    expect(auth.enrollTotpStart).toHaveBeenCalledTimes(1);
    continueFromQr();

    // The password gate opens first — password only: a step-up follows, so
    // the live code goes in THAT (last) modal, not here.
    const pwDialog = await screen.findByRole('dialog');
    expect(auth.enrollTotpConfirm).not.toHaveBeenCalled();
    expect(within(pwDialog).queryByLabelText('Authenticator app code')).not.toBeInTheDocument();
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    // The reusable step-up modal opens next; the write STILL has not run.
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(auth.enrollTotpConfirm).not.toHaveBeenCalled();

    const factorDialog = screen.getByRole('dialog');
    fireEvent.click(within(factorDialog).getByRole('button', { name: /Email me a code/i }));
    await waitFor(() =>
      expect(auth.stepUpSendEmailOtp).toHaveBeenCalledWith('mfa_totp_enroll'),
    );
    fireEvent.change(within(factorDialog).getByLabelText('Email code'), {
      target: { value: '654321' },
    });
    // The emailed code alone is not enough — the live authenticator code is
    // typed here, after the email arrived, so it is seconds old when spent.
    expect(within(factorDialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(within(factorDialog).getByLabelText('Authenticator app code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Continue' }));

    // The step-up modal's own submit performs the real write, carrying the
    // just-typed code plus the password + proof collected by the gate — all
    // verified together, seconds after each was collected.
    await waitFor(() =>
      expect(auth.enrollTotpConfirm).toHaveBeenCalledWith('123456', 'pw123456', {
        method: 'email_otp',
        code: '654321',
      }),
    );
  });

  it('a rejected authenticator code surfaces on the step-up modal with the field still editable, and a fresh code retries with the same password + proof', async () => {
    const enrollTotpConfirm = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiRequestError(401, {
          code: 'MFA_CODE_INVALID',
          message: 'The code is incorrect or enrollment was not started.',
        }),
      )
      .mockResolvedValue({ totpEnabled: true });
    mount({ enrollTotpConfirm, getMfaStatus: vi.fn().mockResolvedValue(ENFORCED_EMAIL_ONLY) });
    await openTotpEnrollment();
    continueFromQr();
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    const factorDialog = screen.getByRole('dialog');
    fireEvent.click(within(factorDialog).getByRole('button', { name: /Email me a code/i }));
    // Wait for the send to settle (the button flips to "Resend code" once
    // `otpSent` lands, in the same render that clears `submitting`) — the
    // fields and Continue are disabled while it is in flight.
    await waitFor(() =>
      expect(within(factorDialog).getByRole('button', { name: 'Resend code' })).toBeInTheDocument(),
    );
    fireEvent.change(within(factorDialog).getByLabelText('Email code'), {
      target: { value: '654321' },
    });
    fireEvent.change(within(factorDialog).getByLabelText('Authenticator app code'), {
      target: { value: '111111' },
    });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Continue' }));

    // The server rejected the (stale / mistyped) authenticator code: the error
    // shows on the modal that owns the field, and the field is right there to
    // fix — no cancelling back through two modals to a frozen code.
    await waitFor(() =>
      expect(
        within(factorDialog).getByText('The code is incorrect or enrollment was not started.'),
      ).toBeInTheDocument(),
    );
    const codeField = within(factorDialog).getByLabelText('Authenticator app code');
    expect(codeField).toHaveValue('111111');
    fireEvent.change(codeField, { target: { value: '222222' } });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Continue' }));

    // The retry reuses the same password + emailed code (the server checks
    // the authenticator code before spending the proof, so it is unconsumed).
    await waitFor(() =>
      expect(enrollTotpConfirm).toHaveBeenLastCalledWith('222222', 'pw123456', {
        method: 'email_otp',
        code: '654321',
      }),
    );
    expect(enrollTotpConfirm).toHaveBeenCalledTimes(2);
  });

  it('does not offer the emailed code as the enrollment step-up factor once a passkey is enrolled — the server refuses it', async () => {
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: false,
        stepUpRequired: true,
        methods: ['passkey'],
        recoveryMethods: ['email_otp'],
      }),
    });
    await openTotpEnrollment();
    continueFromQr();
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());

    // Only the enrolled passkey is offered — no factor picker, no emailed-code
    // path (the recovery list is dropped for enrollment purposes).
    const factorDialog = screen.getByRole('dialog');
    expect(within(factorDialog).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(
      within(factorDialog).queryByRole('button', { name: /Email me a code/i }),
    ).not.toBeInTheDocument();
    expect(within(factorDialog).getByText(/browser will ask for your passkey/i)).toBeInTheDocument();
  });

  it('still offers the emailed code as a recovery factor for DISABLE — the no-lockout floor', async () => {
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: true,
        stepUpRequired: true,
        methods: ['totp'],
        recoveryMethods: ['email_otp'],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());

    const factorDialog = screen.getByRole('dialog');
    expect(
      within(factorDialog).getByRole('radiogroup', { name: 'Choose a factor' }),
    ).toBeInTheDocument();
    expect(within(factorDialog).getByText('Emailed code')).toBeInTheDocument();
  });

  it('renders a restricted authenticator app with a confirm action that lifts it', async () => {
    const getMfaStatus = vi.fn().mockResolvedValue({
      totpEnabled: true,
      totpRestrictedPostReset: true,
      // A predating passkey is the only real proving method for a restricted
      // TOTP (it's a singleton — email_otp can never vouch, no timestamp).
      methods: ['totp'],
      recoveryMethods: [],
    });
    const { container } = mount({ getMfaStatus });
    expect(await screen.findByText('Needs confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/added right after a password reset/i),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);

    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm this authenticator app' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Confirm this authenticator app')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Authenticator code'), {
      target: { value: '111222' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(auth.confirmTotpRestriction).toHaveBeenCalledWith({
        method: 'totp',
        code: '111222',
      }),
    );
  });

  it('offers no dead-end confirm modal when nothing predates the reset — points at removal instead', async () => {
    // Email-OTP is filtered out of the confirm methods (it can never vouch),
    // so an account whose only eligible factor was email_otp has nothing left.
    mount({
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: true,
        totpRestrictedPostReset: true,
        methods: ['email_otp'],
        recoveryMethods: [],
      }),
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm this authenticator app' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/don't have an older sign-in method/i),
    ).toBeInTheDocument();
    // Routes into the existing disable flow (the escape hatch) rather than a
    // step-up modal that could never succeed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    const pwDialog = await screen.findByRole('dialog');
    expect(within(pwDialog).getByText('Disable authenticator app')).toBeInTheDocument();
  });
});
