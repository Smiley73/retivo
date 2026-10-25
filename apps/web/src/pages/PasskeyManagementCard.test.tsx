// PasskeyManagementCard add / remove flows and the factor-change notice line: the server emails the account on add or remove with a single-use undo link and reports `noticeSent`; the card claims the notice was sent only when it was.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasskeyManagementCard } from './PasskeyManagementCard';
import { useAuth } from '../auth/AuthContext';
import { getKeyEnvelopes } from '../auth/key-envelope-client';
import { EnrollmentCommitAmbiguousError } from '../auth/useZeroKnowledgeKey';
import { ApiRequestError } from '../api/client';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));

vi.mock('../auth/key-envelope-client', () => ({
  getKeyEnvelopes: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
}));

const PASSKEY = {
  id: 'cred-1',
  credentialId: 'cred-1',
  deviceType: 'singleDevice' as const,
  backedUp: false,
  transports: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
};

type AuthMocks = {
  me: { email: string };
  registerPasskey: ReturnType<typeof vi.fn>;
  listPasskeys: ReturnType<typeof vi.fn>;
  removePasskey: ReturnType<typeof vi.fn>;
  enrollPasskeyForEncryption: ReturnType<typeof vi.fn>;
  isUnlocked: boolean;
  getMfaStatus: ReturnType<typeof vi.fn>;
  stepUpPasskeyOptions: ReturnType<typeof vi.fn>;
  stepUpSendEmailOtp: ReturnType<typeof vi.fn>;
};

let auth: AuthMocks;

function makeAuth(overrides: Partial<AuthMocks> = {}): AuthMocks {
  return {
    me: { email: 'test@example.com' },
    registerPasskey: vi
      .fn()
      .mockResolvedValue({ ...PASSKEY, id: 'cred-new', credentialId: 'cred-new', noticeSent: true }),
    listPasskeys: vi.fn().mockResolvedValue([]),
    removePasskey: vi.fn().mockResolvedValue({ noticeSent: true }),
    enrollPasskeyForEncryption: vi.fn().mockResolvedValue(undefined),
    isUnlocked: false,
    getMfaStatus: vi.fn().mockResolvedValue({ stepUpRequired: false }),
    stepUpPasskeyOptions: vi.fn().mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
    stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mount(overrides: Partial<AuthMocks> = {}) {
  auth = makeAuth(overrides);
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue(auth);
  const onError = vi.fn();
  const onEnrollError = vi.fn();
  return {
    ...render(<PasskeyManagementCard onError={onError} onEnrollError={onEnrollError} />),
    onError,
    onEnrollError,
  };
}

const OTHER_PASSKEY = { ...PASSKEY, id: 'cred-other', credentialId: 'cred-other' };

function stepUpRequired() {
  return vi.fn().mockResolvedValue({
    totpEnabled: true,
    stepUpRequired: true,
    methods: ['totp'],
    recoveryMethods: ['email_otp'],
  });
}

function prfSlotBoundTo(credentialId: string | null): void {
  vi.mocked(getKeyEnvelopes).mockResolvedValue({
    slots: credentialId ? [{ slotType: 'passkey_prf', credentialBinding: credentialId }] : [],
    envelopeSetVersion: 1,
    envelopeSetTag: 'tag',
    currentCredentialRevision: 'rev',
  } as never);
}

async function awaitBindingResolved(): Promise<void> {
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('switch', { name: 'Use for encryption' })
        .some((s) => (s as HTMLInputElement).checked),
    ).toBe(true),
  );
}

async function confirmWithCode(code: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

async function continueWithEnrollPassword(value: string): Promise<void> {
  const pwDialog = await screen.findByRole('dialog');
  fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
    target: { value },
  });
  fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));
}

// Register a passkey through the gated add flow (password, factor, ceremony), then accept the "Use this passkey to unlock your data?" confirm.
async function registerPasskeyAndConfirmEnroll(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Add passkey/i }));
  const addDialog = await screen.findByRole('dialog');
  fireEvent.change(within(addDialog).getByLabelText('Current password'), {
    target: { value: 'pw123456' },
  });
  fireEvent.click(within(addDialog).getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '111111' },
  });
  const addFactorDialog = await screen.findByRole('dialog');
  fireEvent.click(within(addFactorDialog).getByRole('button', { name: 'Add passkey' }));
  await waitFor(() => expect(auth.registerPasskey).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: 'Use for encryption' }));
}

describe('PasskeyManagementCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prfSlotBoundTo(null);
  });

  it('shows the empty state once loaded', async () => {
    mount();
    expect(await screen.findByText(/No passkeys yet/i)).toBeInTheDocument();
  });

  it('shows the factor-change notice line after adding a passkey', async () => {
    mount();
    await screen.findByText(/No passkeys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /Add passkey/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText(/Passkey added\. We emailed you/i),
    ).toBeInTheDocument();
    expect(auth.registerPasskey).toHaveBeenCalledTimes(1);
  });

  it('shows the factor-change notice line after removing a passkey', async () => {
    mount({ listPasskeys: vi.fn().mockResolvedValue([PASSKEY]) });
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));

    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));

    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(auth.removePasskey).toHaveBeenCalledWith('cred-1', 'pw123456', undefined));
    expect(
      await screen.findByText(/Passkey removed\. We emailed you a heads-up/i),
    ).toBeInTheDocument();
  });

  // `noticeSent: false` means the notice mail could not be sent; the card must not claim an email went out.
  it('warns instead of claiming an email when the add notice was not sent', async () => {
    mount({
      registerPasskey: vi
        .fn()
        .mockResolvedValue({ ...PASSKEY, id: 'cred-new', credentialId: 'cred-new', noticeSent: false }),
    });
    await screen.findByText(/No passkeys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /Add passkey/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    const line = await screen.findByTestId('passkey-factor-notice');
    expect(line).toHaveTextContent(/Passkey added, but we couldn't email you/i);
    expect(line).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/We emailed you/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('warns instead of claiming an email when the removal notice was not sent', async () => {
    mount({
      listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
      removePasskey: vi.fn().mockResolvedValue({ noticeSent: false }),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    const line = await screen.findByTestId('passkey-factor-notice');
    expect(line).toHaveTextContent(/Passkey removed, but we couldn't email you a heads-up/i);
    expect(screen.queryByText(/We emailed you/i)).not.toBeInTheDocument();
  });
});

// A passkey-encryption write into a household that already holds a slot is never exempt, since the toggle renders only once `isUnlocked`. The shared password floor always opens first; the fresh-factor step layers on when required, and both entry points (the switch and the just-registered confirm) share the gate.
describe('PasskeyManagementCard — encryption-enrollment password + step-up gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('switching which passkey unlocks encrypted data opens the password prompt, then the step-up modal, and passes both', async () => {
    const user = userEvent.setup();
    prfSlotBoundTo('cred-other');
    mount({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([PASSKEY, OTHER_PASSKEY]),
      getMfaStatus: stepUpRequired(),
    });
    await awaitBindingResolved();

    const target = screen
      .getAllByRole('switch', { name: 'Use for encryption' })
      .find((s) => !(s as HTMLInputElement).checked)!;
    await user.click(target);

    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await screen.findByText("Confirm it's you");
    expect(
      screen.getByText(/before switching which passkey unlocks your encrypted data/i),
    ).toBeInTheDocument();
    expect(auth.enrollPasskeyForEncryption).not.toHaveBeenCalled();

    await confirmWithCode('123456');

    await waitFor(() =>
      expect(auth.enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-1', 'pw123456', {
        method: 'totp',
        code: '123456',
      }),
    );
    expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
  });

  it('the first-ever encryption enrollment now ALSO requires the password floor and a factor step when required (reversal)', async () => {
    const user = userEvent.setup();
    prfSlotBoundTo(null);
    mount({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
      getMfaStatus: stepUpRequired(),
    });
    const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
    // Let the mount-time `getMfaStatus` and PRF-binding reads settle first.
    await waitFor(() => expect(auth.getMfaStatus).toHaveBeenCalled());
    await waitFor(() => expect(getKeyEnvelopes).toHaveBeenCalled());

    await user.click(toggle);

    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await screen.findByText("Confirm it's you");
    expect(auth.enrollPasskeyForEncryption).not.toHaveBeenCalled();

    await confirmWithCode('222222');

    await waitFor(() =>
      expect(auth.enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-1', 'pw123456', {
        method: 'totp',
        code: '222222',
      }),
    );
  });

  it('with AUTH_MFA_ENFORCED off, the password prompt still opens and Continue enrolls with the password alone (no proof)', async () => {
    const user = userEvent.setup();
    prfSlotBoundTo(null);
    mount({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
      getMfaStatus: vi.fn().mockResolvedValue({ stepUpRequired: false }),
    });
    const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
    await waitFor(() => expect(auth.getMfaStatus).toHaveBeenCalled());

    await user.click(toggle);

    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(auth.enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-1', 'pw123456', undefined),
    );
    expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
  });

  it('confirming "Use for encryption" for a just-registered passkey opens the password prompt, then the step-up modal', async () => {
    prfSlotBoundTo('cred-other');
    mount({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([OTHER_PASSKEY]),
      getMfaStatus: stepUpRequired(),
    });
    await awaitBindingResolved();

    await registerPasskeyAndConfirmEnroll();
    await continueWithEnrollPassword('confirm-pw');

    await screen.findByText("Confirm it's you");
    expect(auth.enrollPasskeyForEncryption).not.toHaveBeenCalled();

    await confirmWithCode('654321');

    await waitFor(() =>
      expect(auth.enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-new', 'confirm-pw', {
        method: 'totp',
        code: '654321',
      }),
    );
  });

  // On the enforced path the enroll write runs inside `useStepUp`'s submit, which reports any non-API failure as the ambiguous "We couldn't confirm it's you". A failure before any proof was sent (an authenticator with no PRF support, a locked session) is not about the factor: it must reach the card's own sink with the real cause and close the flow, while a server-answered or outcome-unknown failure still belongs to the modal.
  describe('local failures on the enforced enrollment path', () => {
    it('a passkey with no PRF support reports the plain no-PRF sentence through onEnrollError on the post-registration confirm path — never the ambiguous step-up failure', async () => {
      prfSlotBoundTo('cred-other');
      const { onEnrollError } = mount({
        isUnlocked: true,
        listPasskeys: vi.fn().mockResolvedValue([OTHER_PASSKEY]),
        getMfaStatus: stepUpRequired(),
        enrollPasskeyForEncryption: vi
          .fn()
          .mockRejectedValue(new Error('passkey did not return a PRF result (unsupported)')),
      });
      await awaitBindingResolved();
      await registerPasskeyAndConfirmEnroll();
      await continueWithEnrollPassword('confirm-pw');
      await screen.findByText("Confirm it's you");

      await confirmWithCode('654321');

      await waitFor(() =>
        expect(onEnrollError).toHaveBeenCalledWith(
          "This passkey can't be used for encryption (no PRF support).",
        ),
      );
      expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
      expect(screen.queryByText(/couldn't confirm it's you/i)).not.toBeInTheDocument();
    });

    it('a locked-session failure on the toggle path reports its own message through onError and closes the modal', async () => {
      const user = userEvent.setup();
      prfSlotBoundTo(null);
      const { onError } = mount({
        isUnlocked: true,
        listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
        getMfaStatus: stepUpRequired(),
        enrollPasskeyForEncryption: vi
          .fn()
          .mockRejectedValue(
            new Error('Unlock your data before enabling a passkey for encryption.'),
          ),
      });
      const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
      await waitFor(() => expect(auth.getMfaStatus).toHaveBeenCalled());
      await user.click(toggle);
      await continueWithEnrollPassword('pw123456');
      await screen.findByText("Confirm it's you");

      await confirmWithCode('123456');

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          'Unlock your data before enabling a passkey for encryption.',
        ),
      );
      expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
      expect(screen.queryByText(/couldn't confirm it's you/i)).not.toBeInTheDocument();
    });

    it('a server-rejected factor still shows inside the still-open step-up modal, not on the card sink', async () => {
      const user = userEvent.setup();
      prfSlotBoundTo(null);
      const { onError } = mount({
        isUnlocked: true,
        listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
        getMfaStatus: stepUpRequired(),
        enrollPasskeyForEncryption: vi
          .fn()
          .mockRejectedValue(
            new ApiRequestError(401, { code: 'MFA_CODE_INVALID', message: 'That code is not valid.' }),
          ),
      });
      const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
      await waitFor(() => expect(auth.getMfaStatus).toHaveBeenCalled());
      await user.click(toggle);
      await continueWithEnrollPassword('pw123456');
      await screen.findByText("Confirm it's you");

      await confirmWithCode('000000');

      expect(await screen.findByText('That code is not valid.')).toBeInTheDocument();
      expect(screen.getByText("Confirm it's you")).toBeInTheDocument();
      expect(onError).not.toHaveBeenCalled();
    });

    it('a factor-carrying request whose outcome is unknown keeps the ambiguous, non-retryable step-up failure', async () => {
      const user = userEvent.setup();
      prfSlotBoundTo(null);
      const { onError } = mount({
        isUnlocked: true,
        listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
        getMfaStatus: stepUpRequired(),
        enrollPasskeyForEncryption: vi
          .fn()
          .mockRejectedValue(new EnrollmentCommitAmbiguousError(new TypeError('Failed to fetch'))),
      });
      const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
      await waitFor(() => expect(auth.getMfaStatus).toHaveBeenCalled());
      await user.click(toggle);
      await continueWithEnrollPassword('pw123456');
      await screen.findByText("Confirm it's you");

      await confirmWithCode('123456');

      expect(await screen.findByText(/couldn't confirm it's you/i)).toBeInTheDocument();
      expect(screen.getByText("Confirm it's you")).toBeInTheDocument();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('passes axe accessibility checks with the enrollment password prompt open', async () => {
    prfSlotBoundTo(null);
    const { container } = mount({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([PASSKEY]),
      getMfaStatus: vi.fn().mockResolvedValue({ stepUpRequired: false }),
    });
    const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
    fireEvent.click(toggle);
    await screen.findByRole('dialog');
    await expectNoA11yViolations(container);
  });
});
