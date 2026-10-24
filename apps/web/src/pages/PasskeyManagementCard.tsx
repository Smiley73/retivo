/** Security page Passkeys card: list, add, remove and encryption-unlock enrollment (see docs/security.md). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, type PasskeyInfo } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { Alert } from '../components/Alert';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Muted } from '../components/Muted';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { getKeyEnvelopes } from '../auth/key-envelope-client';
import { EnrollmentCommitAmbiguousError } from '../auth/useZeroKnowledgeKey';
import { formatDate } from '../lib/format-date';
import { deviceTypeLabel, transportLabel } from './profile-page-shared';
import {
  SettingsCard,
  PasswordPromptModal,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  FingerprintIcon,
  TrashIcon,
} from './profile-page-chrome';

interface Props {
  /** Page-level error sink (single top-of-page Alert) for list/register errors. */
  onError: (message: string | null) => void;
  /** Page-level enroll-error sink (separate top-of-page Alert). */
  onEnrollError: (message: string | null) => void;
}

export const PasskeyManagementCard: React.FC<Props> = ({
  onError,
  onEnrollError,
}) => {
  const {
    me,
    registerPasskey,
    listPasskeys,
    removePasskey,
    confirmPasskeyRestriction,
    enrollPasskeyForEncryption,
    isUnlocked,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const email = me?.email ?? '';
  // Every passkey control maps to an endpoint on the authenticated exemption allowlist, so all stay enabled while the disclaimer gate blocks: a blocked user must still manage account-security keys.
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<PasskeyInfo | null>(null);
  const [prfCredentialId, setPrfCredentialId] = useState<string | null>(null);
  // Positive confirmation only: prfCredentialId is also null before the fetch resolves or after it failed, and treating that as "no PRF slot" could let an enroll silently replace the household's existing slot.
  const [prfBindingResolved, setPrfBindingResolved] = useState(false);
  const [enrollingCredentialId, setEnrollingCredentialId] = useState<string | null>(null);
  const [registerEnrollTarget, setRegisterEnrollTarget] = useState<PasskeyInfo | null>(null);
  // Claims an email went out only when the server reports noticeSent (a warning otherwise); cleared at the start of the next add or remove.
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(
    null,
  );

  const [removePassword, setRemovePassword] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [showRemovePassword, setShowRemovePassword] = useState(false);
  const [showRemoveFactor, setShowRemoveFactor] = useState(false);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);

  const [registering, setRegistering] = useState(false);
  const [addPassword, setAddPassword] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [showAddPassword, setShowAddPassword] = useState(false);
  const [showAddFactor, setShowAddFactor] = useState(false);

  // Lifting a restriction needs no password baseline: ConfirmRestrictedFactorDto requires only a fresh factor proof, which proves an old factor.
  const [confirmTarget, setConfirmTarget] = useState<PasskeyInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMfaStatus()
      .then((s) => {
        if (cancelled) return;
        setStepUpRequired(!!s.stepUpRequired);
        if (s.methods?.length) setStepUpMethods(s.methods);
        if (s.recoveryMethods) setStepUpRecoveryMethods(s.recoveryMethods);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMfaStatus]);

  const loadPasskeys = useCallback(async () => {
    try {
      const keys = await listPasskeys();
      setPasskeys(keys);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [listPasskeys]);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys]);

  const loadPrfBinding = useCallback(async () => {
    if (!isUnlocked) return;
    try {
      const envelopes = await getKeyEnvelopes();
      const prf = envelopes.slots.find((s) => s.slotType === 'passkey_prf');
      setPrfCredentialId(prf?.credentialBinding ?? null);
      setPrfBindingResolved(true);
    } catch {
      // Leave the binding unresolved so the auto-enroll guard stays conservative.
    }
  }, [isUnlocked]);

  useEffect(() => {
    loadPrfBinding();
  }, [loadPrfBinding]);

  // Enrolling into a household that already holds a slot always needs a proof (no first-ever exemption) plus the password floor, in either AUTH_MFA_ENFORCED state.
  // pendingEnrollTargetRef lets the toggle and the post-registration confirm share one gate.
  const pendingEnrollTargetRef = useRef<{ credentialId: string; isConfirm: boolean } | null>(null);
  const [enrollPassword, setEnrollPassword] = useState('');
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [showEnrollPassword, setShowEnrollPassword] = useState(false);
  const [showEnrollStepUp, setShowEnrollStepUp] = useState(false);

  const resetEnroll = useCallback(() => {
    pendingEnrollTargetRef.current = null;
    setShowEnrollPassword(false);
    setShowEnrollStepUp(false);
    setEnrollPassword('');
    setEnrollError(null);
    setEnrollBusy(false);
  }, []);

  const enableEncryptionCore = useCallback(
    async (credentialId: string, password: string, proof?: StepUpProof): Promise<void> => {
      setEnrollingCredentialId(credentialId);
      try {
        await enrollPasskeyForEncryption(credentialId, password, proof);
        setPrfCredentialId(credentialId);
      } finally {
        setEnrollingCredentialId(null);
      }
    },
    [enrollPasskeyForEncryption],
  );

  const onEnableEncryptionRequested = useCallback((pk: PasskeyInfo) => {
    pendingEnrollTargetRef.current = { credentialId: pk.credentialId, isConfirm: false };
    setEnrollError(null);
    setShowEnrollPassword(true);
  }, []);

  const onConfirmRegisterEnroll = useCallback(() => {
    if (!registerEnrollTarget) return;
    const target = registerEnrollTarget;
    setRegisterEnrollTarget(null);
    pendingEnrollTargetRef.current = { credentialId: target.credentialId, isConfirm: true };
    setEnrollError(null);
    setShowEnrollPassword(true);
  }, [registerEnrollTarget]);

  // A PRF-unsupported authenticator throws KeyWrappingError; give a clear message only on the post-registration confirm, whose registration already succeeded and is not rolled back.
  const classifyEnrollError = useCallback((err: unknown, isConfirm: boolean): string => {
    const noPrf = err instanceof Error && /did not return a PRF result/i.test(err.message);
    if (noPrf && isConfirm) return "This passkey can't be used for encryption (no PRF support).";
    if (err instanceof ApiRequestError) return err.error.message;
    if (err instanceof Error) return err.message;
    return 'Failed to enable this passkey for encryption.';
  }, []);

  // Re-throw server-answered (ApiRequestError) and ambiguous (EnrollmentCommitAmbiguousError) failures so the step-up path shows them inside the still-open StepUpModal.
  // Local failures (no PRF support, ended session, cancelled prompt) happened before any proof was sent, so "couldn't confirm it's you" would name the wrong cause; they go to the card's own sink.
  const doEnroll = useCallback(
    async (proof?: StepUpProof): Promise<void> => {
      const target = pendingEnrollTargetRef.current;
      if (!target) return;
      const sink = target.isConfirm ? onEnrollError : onError;
      try {
        await enableEncryptionCore(target.credentialId, enrollPassword, proof);
      } catch (err) {
        if (err instanceof ApiRequestError || err instanceof EnrollmentCommitAmbiguousError) {
          throw err;
        }
        sink(classifyEnrollError(err, target.isConfirm));
        resetEnroll();
        return;
      }
      sink(null);
    },
    [enableEncryptionCore, enrollPassword, onEnrollError, onError, classifyEnrollError, resetEnroll],
  );

  // Only server-answered or ambiguous failures reach this catch (doEnroll handles local ones), so a wrong password lands inline on the prompt.
  const onEnrollPasswordContinue = useCallback(async () => {
    const target = pendingEnrollTargetRef.current;
    if (!target) return;
    if (stepUpRequired) {
      setEnrollError(null);
      setShowEnrollStepUp(true);
      return;
    }
    setEnrollBusy(true);
    setEnrollError(null);
    try {
      await doEnroll();
      resetEnroll();
    } catch (err) {
      setEnrollError(classifyEnrollError(err, target.isConfirm));
    } finally {
      setEnrollBusy(false);
    }
  }, [stepUpRequired, doEnroll, classifyEnrollError, resetEnroll]);

  // Blocked while in flight so the call cannot be orphaned mid-request.
  const cancelEnroll = useCallback(() => {
    if (enrollBusy) return;
    resetEnroll();
  }, [enrollBusy, resetEnroll]);

  const enrollStepUp = useStepUp({
    purpose: 'key_envelope_replace',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => doEnroll(proof),
    onVerified: () => {
      resetEnroll();
    },
  });
  const resetEnrollStepUp = enrollStepUp.reset;
  useEffect(() => {
    if (showEnrollStepUp) resetEnrollStepUp();
  }, [showEnrollStepUp, resetEnrollStepUp]);

  const resetAdd = useCallback(() => {
    setShowAddPassword(false);
    setShowAddFactor(false);
    setAddPassword('');
    setAddError(null);
    setAddBusy(false);
    setRegistering(false);
  }, []);

  // Throws on failure so the step-up path surfaces the modal's non-retryable error; the password-only path catches below.
  const doRegister = useCallback(
    async (proof?: StepUpProof): Promise<void> => {
      setRegistering(true);
      setNotice(null);
      try {
        const { noticeSent, ...result } = await registerPasskey(addPassword, proof);
        setPasskeys((prev) => [...prev, result]);
        onError(null);
        setNotice(
          noticeSent
            ? {
                tone: 'success',
                text: "Passkey added. We emailed you, so you can undo this if it wasn't you.",
              }
            : { tone: 'warning', text: "Passkey added, but we couldn't email you about it." },
        );
        // Prompt only when unlocked and the PRF binding is positively resolved; enrolling fires only on explicit confirmation, and the dialog warns that confirming replaces another passkey's slot.
        if (isUnlocked && prfBindingResolved) {
          onEnrollError(null);
          setRegisterEnrollTarget(result);
        }
      } finally {
        setRegistering(false);
      }
    },
    [registerPasskey, addPassword, isUnlocked, prfBindingResolved, onError, onEnrollError],
  );

  const addStepUp = useStepUp({
    purpose: 'passkey_enroll',
    methods: stepUpMethods,
    // The emailed code is the floor only while the account has no enrolled factor, and the server refuses it otherwise (STEP_UP_FACTOR_NOT_ELIGIBLE), so no recoveryMethods here; removal keeps the no-lockout floor.
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => doRegister(proof),
    onVerified: () => {
      resetAdd();
    },
  });
  const resetAddStepUp = addStepUp.reset;

  useEffect(() => {
    if (showAddFactor) resetAddStepUp();
  }, [showAddFactor, resetAddStepUp]);

  const onAddPasskeyClick = useCallback(() => {
    onError(null);
    setAddError(null);
    setShowAddPassword(true);
  }, [onError]);

  const onAddPasswordContinue = useCallback(async () => {
    if (stepUpRequired) {
      setAddError(null);
      setShowAddFactor(true);
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await doRegister();
      resetAdd();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setAddError(err.error.message);
      } else if (err instanceof Error) {
        setAddError(err.message);
      } else {
        setAddError('Failed to register passkey. Please try again.');
      }
    } finally {
      setAddBusy(false);
    }
  }, [stepUpRequired, doRegister, resetAdd]);

  const cancelAdd = useCallback(() => {
    if (addBusy || registering || addStepUp.submitting) return;
    resetAdd();
  }, [addBusy, registering, addStepUp.submitting, resetAdd]);

  const resetRemove = useCallback(() => {
    setRemoveTarget(null);
    setShowRemovePassword(false);
    setShowRemoveFactor(false);
    setRemovePassword('');
    setRemoveError(null);
  }, []);

  const doRemove = useCallback(
    async (proof?: StepUpProof): Promise<void> => {
      if (!removeTarget) return;
      const { noticeSent } = await removePasskey(removeTarget.id, removePassword, proof);
      setPasskeys((prev) => prev.filter((pk) => pk.id !== removeTarget.id));
      setNotice(
        noticeSent
          ? { tone: 'success', text: 'Passkey removed. We emailed you a heads-up.' }
          : { tone: 'warning', text: "Passkey removed, but we couldn't email you a heads-up." },
      );
    },
    [removeTarget, removePassword, removePasskey],
  );

  const removeStepUp = useStepUp({
    purpose: 'passkey_remove',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: (proof) => doRemove(proof),
    onVerified: () => {
      setShowRemoveFactor(false);
      setShowRemovePassword(false);
      setRemoveTarget(null);
      setRemovePassword('');
    },
  });
  const resetRemoveStepUp = removeStepUp.reset;

  useEffect(() => {
    if (showRemoveFactor) resetRemoveStepUp();
  }, [showRemoveFactor, resetRemoveStepUp]);

  const cancelRemove = useCallback(() => {
    if (removeBusy || removeStepUp.submitting) return;
    resetRemove();
  }, [removeBusy, removeStepUp.submitting, resetRemove]);

  const onRemoveConfirm = useCallback(() => {
    setRemoveError(null);
    setNotice(null);
    setShowRemovePassword(true);
  }, []);

  const onRemovePasswordContinue = useCallback(async () => {
    if (stepUpRequired) {
      setRemoveError(null);
      setShowRemoveFactor(true);
      return;
    }
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await doRemove();
      resetRemove();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setRemoveError(err.error.message);
      } else {
        setRemoveError('Failed to delete passkey.');
      }
    } finally {
      setRemoveBusy(false);
    }
  }, [stepUpRequired, doRemove, resetRemove]);

  // Only totp and passkey can vouch: Email-OTP has no enrollment timestamp to compare with the reset, and the server rejects it.
  const restrictionConfirmMethods = useMemo(
    () => stepUpMethods.filter((m) => m === 'totp' || m === 'passkey'),
    [stepUpMethods],
  );
  // Nothing predates the reset: the escape hatch is removal, not a modal that can never succeed.
  const confirmHasNoEligibleFactor = confirmTarget !== null && restrictionConfirmMethods.length === 0;

  const confirmStepUp = useStepUp({
    purpose: 'passkey_enroll',
    methods: restrictionConfirmMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof) => {
      if (!confirmTarget) return;
      await confirmPasskeyRestriction(confirmTarget.id, proof);
      setPasskeys((prev) =>
        prev.map((pk) =>
          pk.id === confirmTarget.id ? { ...pk, restrictedPostReset: false } : pk,
        ),
      );
    },
    onVerified: () => {
      setConfirmTarget(null);
    },
  });
  const resetConfirmStepUp = confirmStepUp.reset;

  useEffect(() => {
    if (confirmTarget && !confirmHasNoEligibleFactor) resetConfirmStepUp();
  }, [confirmTarget, confirmHasNoEligibleFactor, resetConfirmStepUp]);

  const onConfirmRestriction = useCallback((pk: PasskeyInfo) => {
    setConfirmTarget(pk);
  }, []);

  const onRemoveInsteadOfConfirm = useCallback(() => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (target) setRemoveTarget(target);
  }, [confirmTarget]);

  return (
    <>
      <SettingsCard
        title="Passkeys"
        subtitle="Sign in with your device's biometrics or PIN."
      >
        {notice && (
          <Alert tone={notice.tone} data-testid="passkey-factor-notice">
            {notice.text}
          </Alert>
        )}
        {loading ? (
          <Muted as="p" className="text-sm">Loading passkeys…</Muted>
        ) : passkeys.length === 0 ? (
          <Muted as="p" className="text-sm">
            No passkeys yet. Add one to sign in with your device&apos;s
            fingerprint, face, or PIN, instead of typing a password.
          </Muted>
        ) : (
          <div className="flex flex-col gap-3">
            {passkeys.map((pk) => (
              <PasskeyRow
                key={pk.id}
                pk={pk}
                isUnlocked={isUnlocked}
                prfCredentialId={prfCredentialId}
                enrollingCredentialId={enrollingCredentialId}
                onEnableEncryption={onEnableEncryptionRequested}
                onRemove={setRemoveTarget}
                onConfirmRestriction={onConfirmRestriction}
              />
            ))}
          </div>
        )}

        <button
          type="button"
          className={`${btnPrimarySmClass} mt-3 gap-1.5`}
          onClick={onAddPasskeyClick}
          disabled={registering}
        >
          <FingerprintIcon />
          {registering ? 'Registering…' : 'Add passkey'}
        </button>
      </SettingsCard>

      <ConfirmDialog
        open={!!registerEnrollTarget}
        size="lg"
        title="Use this passkey to unlock your data?"
        message={
          registerEnrollTarget &&
          prfCredentialId !== null &&
          prfCredentialId !== registerEnrollTarget.credentialId ? (
            <>
              Your data is currently unlocked by your{' '}
              {deviceTypeLabel[
                passkeys.find((pk) => pk.credentialId === prfCredentialId)?.deviceType ?? ''
              ] ?? 'existing'}{' '}
              passkey. Using this new passkey instead will{' '}
              <strong>replace it</strong> as the passkey that unlocks your
              encrypted data on this device.
            </>
          ) : (
            'Your data is encrypted. Use this newly added passkey to unlock it on this device with a tap, instead of typing your password each time.'
          )
        }
        confirmLabel="Use for encryption"
        cancelLabel="Not now"
        // Benign: enrolling or swapping an unlocker destroys nothing, so a lime confirm, not red.
        destructive={false}
        onConfirm={onConfirmRegisterEnroll}
        onCancel={() => setRegisterEnrollTarget(null)}
      />

      <PasswordPromptModal
        open={showAddPassword && !showAddFactor}
        onClose={cancelAdd}
        title="Add a passkey"
        intro="Confirm your password before adding a new way to sign in. This stops someone who gets into your account from locking you out of it."
        error={addError}
        inputId="passkey-add-password"
        value={addPassword}
        onValueChange={setAddPassword}
        email={email}
        onContinue={() => void onAddPasswordContinue()}
        continueLabel={addBusy ? 'Working…' : 'Continue'}
        continueDisabled={addBusy || addPassword.trim() === ''}
        cancelDisabled={addBusy}
      />

      <StepUpModal
        open={showAddFactor}
        onClose={() => {
          if (addStepUp.submitting || registering) return;
          setShowAddFactor(false);
        }}
        title="Confirm it's you"
        stepUp={addStepUp}
        confirmLabel="Add passkey"
      >
        <Muted className="block text-sm">
          Before you add a new way to sign in, confirm it&apos;s you. This
          stops someone who gets into your account from locking you out of
          it. You&apos;ll be asked for your passkey twice if you confirm with
          a passkey — once to confirm it&apos;s you, and once to set up the
          new one.
        </Muted>
      </StepUpModal>

      <ConfirmDialog
        open={!!removeTarget && !showRemovePassword && !showRemoveFactor}
        size="lg"
        title="Delete passkey"
        message={`Delete the ${removeTarget ? deviceTypeLabel[removeTarget.deviceType] ?? removeTarget.deviceType : ''} passkey? You will still be able to sign in with your password or other passkeys.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={onRemoveConfirm}
        onCancel={() => setRemoveTarget(null)}
      />

      <PasswordPromptModal
        open={showRemovePassword && !showRemoveFactor}
        onClose={cancelRemove}
        title="Delete passkey"
        intro="Confirm your password to remove this passkey."
        error={removeError}
        inputId="passkey-remove-password"
        value={removePassword}
        onValueChange={setRemovePassword}
        email={email}
        onContinue={() => void onRemovePasswordContinue()}
        continueLabel={removeBusy ? 'Working…' : 'Continue'}
        continueDisabled={removeBusy || removePassword.trim() === ''}
        cancelDisabled={removeBusy}
      />

      {/* Email-OTP is the no-lockout floor, so removal stays completable even when the removed passkey is the only routine factor. */}
      <StepUpModal
        open={showRemoveFactor}
        onClose={() => {
          if (removeStepUp.submitting) return;
          setShowRemoveFactor(false);
        }}
        title="Confirm it's you"
        stepUp={removeStepUp}
        confirmLabel="Delete passkey"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before removing this passkey.
        </Muted>
      </StepUpModal>

      <PasswordPromptModal
        open={showEnrollPassword && !showEnrollStepUp}
        onClose={cancelEnroll}
        title="Use for encryption"
        intro="Confirm your password before using this passkey to unlock your encrypted data on this device."
        error={enrollError}
        inputId="passkey-enroll-password"
        value={enrollPassword}
        onValueChange={setEnrollPassword}
        email={email}
        onContinue={() => void onEnrollPasswordContinue()}
        continueLabel={enrollBusy ? 'Working…' : 'Continue'}
        continueDisabled={enrollBusy || enrollPassword.trim() === ''}
        cancelDisabled={enrollBusy}
      />

      <StepUpModal
        open={showEnrollStepUp}
        onClose={() => {
          if (enrollStepUp.submitting) return;
          setShowEnrollStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={enrollStepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before switching which
          passkey unlocks your encrypted data.
        </Muted>
      </StepUpModal>

      <StepUpModal
        open={!!confirmTarget && !confirmHasNoEligibleFactor}
        onClose={() => {
          if (confirmStepUp.submitting) return;
          setConfirmTarget(null);
        }}
        title="Confirm this passkey"
        stepUp={confirmStepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          This was added right after a password reset, so it isn&apos;t active
          yet. Confirm it with a sign-in method you already had before the
          reset.
        </Muted>
      </StepUpModal>

      <ConfirmDialog
        open={confirmHasNoEligibleFactor}
        title="Confirm this passkey"
        message="You don't have an older sign-in method to confirm this with. Remove it and add it again — you'll be able to add it normally once things settle after your password reset."
        confirmLabel="Delete passkey"
        cancelLabel="Close"
        destructive
        onConfirm={onRemoveInsteadOfConfirm}
        onCancel={() => setConfirmTarget(null)}
      />
    </>
  );
};

interface PasskeyRowProps {
  pk: PasskeyInfo;
  isUnlocked: boolean;
  prfCredentialId: string | null;
  enrollingCredentialId: string | null;
  onEnableEncryption: (pk: PasskeyInfo) => void;
  onRemove: (pk: PasskeyInfo) => void;
  onConfirmRestriction: (pk: PasskeyInfo) => void;
}

const PasskeyRow: React.FC<PasskeyRowProps> = ({
  pk,
  isUnlocked,
  prfCredentialId,
  enrollingCredentialId,
  onEnableEncryption,
  onRemove,
  onConfirmRestriction,
}) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2">
    <div>
      <div className="text-sm font-medium text-ink">
        {deviceTypeLabel[pk.deviceType] ?? pk.deviceType}
        {pk.backedUp && (
          <span className="ml-2 inline-flex items-center rounded-full border border-positive/40 bg-surface-sunken px-2 py-0.5 text-xs font-medium text-positive">
            Synced
          </span>
        )}
        {pk.restrictedPostReset && (
          <span className="ml-2 inline-flex items-center rounded-full border border-line-strong bg-surface-sunken px-2 py-0.5 text-xs font-medium text-muted">
            Needs confirmation
          </span>
        )}
      </div>
      {pk.transports && pk.transports.length > 0 && (
        <div className="text-xs text-muted">
          {pk.transports.map((t) => transportLabel[t] ?? t).join(', ')}
        </div>
      )}
      {pk.lastUsedAt && (
        <div className="text-xs text-muted">
          Last used {formatDate(pk.lastUsedAt)}
        </div>
      )}
      {pk.restrictedPostReset && (
        <div className="mt-1 max-w-md text-xs text-muted">
          This was added right after a password reset, so it isn&apos;t active
          yet. Until you confirm it with a sign-in method you already had
          before the reset, it can&apos;t be used to sign in or to approve
          changes.
        </div>
      )}
    </div>
    <div className="flex items-center gap-3">
      {pk.restrictedPostReset ? (
        <button
          type="button"
          className={btnSecondarySmClass}
          onClick={() => onConfirmRestriction(pk)}
        >
          Confirm this passkey
        </button>
      ) : (
        isUnlocked && (
          <div className="flex flex-col items-end gap-0.5">
            <ToggleSwitch
              label="Use for encryption"
              checked={prfCredentialId === pk.credentialId}
              disabled={
                enrollingCredentialId !== null ||
                prfCredentialId === pk.credentialId
              }
              onChange={(next) => {
                if (next) void onEnableEncryption(pk);
              }}
            />
            {/* A disabled control with no reason reads as broken, so say why it is locked on: switch by enabling a different passkey. */}
            {prfCredentialId === pk.credentialId && (
              <span className="text-xs text-muted">
                Currently in use for encryption
              </span>
            )}
          </div>
        )
      )}
      <button
        type="button"
        className={`${btnDangerSmClass} gap-1.5`}
        onClick={() => onRemove(pk)}
      >
        <TrashIcon />
        Delete
      </button>
    </div>
  </div>
);
