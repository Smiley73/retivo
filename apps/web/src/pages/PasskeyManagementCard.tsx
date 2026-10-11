/**
 * Security page: Passkeys card. Passkey sign-in, step-up and the encryption
 * unlock slots are described in docs/security.md.
 *
 * Owns the passkey list (load / register / remove), the household PRF-binding
 * read that drives the per-passkey "Use for encryption" toggle, and the
 * just-registered "Use this passkey to unlock your data?" ConfirmDialog.
 * Self-sources auth from `useAuth`. Surfaces its own list/register/enroll
 * errors at page level via the `onError` callback so the page keeps a single
 * top-of-page `<Alert>` location.
 *
 * Adding a passkey is gated: a password re-verify
 * baseline always runs first, plus a fresh step-up factor when
 * `AUTH_MFA_ENFORCED` is on — mirroring the existing remove flow's shape. A
 * restricted passkey (enrolled right after a password reset) renders a
 * "Needs confirmation" badge with its own confirm action.
 *
 * Passkey-encryption enrollment (the "Use for encryption" toggle and the
 * post-registration confirm) carries the SAME password-then-factor shape
 * as add/remove: the shared `PasswordPromptModal` opens first,
 * unconditionally, in both `AUTH_MFA_ENFORCED` states; Continue advances to
 * `StepUpModal` only when the flag is on, and the enroll call always carries
 * the password plus any collected proof in one request. The server refuses
 * the write without a correct password.
 */
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
  // Every passkey control on this card — list, register (Add passkey), remove,
  // and the "Use for encryption" key-envelope enroll — maps to a server
  // endpoint on the authenticated exemption allowlist (passkey register/finish,
  // passkey remove, key-envelopes PUT), so all of them stay enabled even while
  // the disclaimer gate is blocked: passkey/key management are account-security
  // operations a blocked user must still be able to perform.
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<PasskeyInfo | null>(null);
  // credentialBinding of the household's current passkey_prf slot (one per
  // household), or null when none is enrolled. Drives the per-passkey "Use
  // for encryption" toggle state.
  const [prfCredentialId, setPrfCredentialId] = useState<string | null>(null);
  // True only after `loadPrfBinding` actually completed a `getKeyEnvelopes()`
  // read (whether or not a PRF slot was found). Stays false while the fetch is
  // in flight or after it threw. The auto-enroll-on-registration guard keys off
  // this, NOT off `prfCredentialId === null` alone: that value is also null
  // before the fetch resolves or when it silently failed, so treating it as
  // "no PRF slot" risks a fresh enroll silently replacing an existing
  // household PRF slot (the "never silently steals the encryption role"
  // contract). Positive confirmation only.
  const [prfBindingResolved, setPrfBindingResolved] = useState(false);
  const [enrollingCredentialId, setEnrollingCredentialId] = useState<string | null>(null);
  // Registration encryption confirmation: after a passkey
  // registers while unlocked, ask whether to use it as the encryption unlocker
  // (replaces the prior silent auto-enroll). Holds the just-registered passkey;
  // null when the dialog is closed. `enrollError` carries a clear inline message
  // when the confirmed enroll fails (e.g. a PRF-unsupported authenticator).
  const [registerEnrollTarget, setRegisterEnrollTarget] = useState<PasskeyInfo | null>(null);
  // Confirmation line after a factor change — the
  // server emails the account when a passkey is added or removed, with a
  // single-use undo link, and reports `noticeSent`; the line only claims an
  // email went out when it did (a warning otherwise). Cleared at the start of
  // the next add/remove attempt so a stale line never survives a fresh action.
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(
    null,
  );

  // Passkey removal requires a password re-verify baseline (+ a fresh
  // step-up factor when `AUTH_MFA_ENFORCED` is on). `removeTarget` drives the confirm; the
  // password + factor steps follow. `removeError`/`removeBusy` are local to the
  // remove flow so a bad password surfaces on the password modal itself.
  const [removePassword, setRemovePassword] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [showRemovePassword, setShowRemovePassword] = useState(false);
  const [showRemoveFactor, setShowRemoveFactor] = useState(false);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);

  // Adding a passkey is gated the same way: a
  // password re-verify baseline always runs, plus a fresh step-up factor when
  // `AUTH_MFA_ENFORCED` is on. `registering` covers the WebAuthn ceremony
  // itself (after the gate resolves) for the button's busy label.
  const [registering, setRegistering] = useState(false);
  const [addPassword, setAddPassword] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [showAddPassword, setShowAddPassword] = useState(false);
  const [showAddFactor, setShowAddFactor] = useState(false);

  // Confirming (lifting) a restricted passkey's post-reset restriction. No
  // password baseline here — `ConfirmRestrictedFactorDto` requires only the
  // fresh factor proof itself (the whole point is proving an OLD factor).
  // `StepUpModal` renders `confirmStepUp.error` itself on a failed lift
  // (e.g. a proof that doesn't predate the reset) — no separate error state.
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
      // A status-read failure leaves the default (no factor step shown); the
      // server still enforces the factor, surfacing as an error on the call.
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
      // Silently fail — passkeys are optional
    } finally {
      setLoading(false);
    }
  }, [listPasskeys]);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys]);

  // Learn which passkey (if any) currently holds the household's passkey_prf
  // slot so the per-passkey toggle reflects the real state. Only meaningful once
  // encryption is unlocked; failures are silent (the toggles just read "off").
  const loadPrfBinding = useCallback(async () => {
    if (!isUnlocked) return;
    try {
      const envelopes = await getKeyEnvelopes();
      const prf = envelopes.slots.find((s) => s.slotType === 'passkey_prf');
      setPrfCredentialId(prf?.credentialBinding ?? null);
      // Positively confirmed the household's PRF-slot state (found or absent) —
      // the auto-enroll guard may now trust `prfCredentialId === null`.
      setPrfBindingResolved(true);
    } catch {
      // Silent — encryption-unlock state is optional UI. Leave the binding
      // UNRESOLVED so the auto-enroll guard stays conservative (no enroll).
    }
  }, [isUnlocked]);

  useEffect(() => {
    loadPrfBinding();
  }, [loadPrfBinding]);

  // Passkey-encryption enrollment gate: a
  // write into a household that already holds a slot always requires a
  // proof (there is no first-ever-enrollment exemption) —
  // AND the write always carries the account password floor, in EITHER
  // `AUTH_MFA_ENFORCED` state. Mirrors add/remove's password-then-factor
  // shape: `showEnrollPassword` opens unconditionally on either enrollment
  // entry point; Continue advances to `showEnrollStepUp` only when the flag
  // is on. `pendingEnrollTargetRef` names which write to run (the toggle vs.
  // the post-registration confirm) so both entry points share one gate.
  const pendingEnrollTargetRef = useRef<{ credentialId: string; isConfirm: boolean } | null>(null);
  const [enrollPassword, setEnrollPassword] = useState('');
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [showEnrollPassword, setShowEnrollPassword] = useState(false);
  const [showEnrollStepUp, setShowEnrollStepUp] = useState(false);

  // Reset every stage of the enroll flow (password → factor → write).
  const resetEnroll = useCallback(() => {
    pendingEnrollTargetRef.current = null;
    setShowEnrollPassword(false);
    setShowEnrollStepUp(false);
    setEnrollPassword('');
    setEnrollError(null);
    setEnrollBusy(false);
  }, []);

  // Enable a passkey as a zero-knowledge unlock method. Triggers a targeted
  // WebAuthn assertion (PRF), wraps the HDK into the passkey_prf slot, and
  // refreshes the binding so the toggle reflects the new state. No internal
  // catch — callers below classify the failure against their own error sink.
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

  // A PRF-unsupported authenticator throws KeyWrappingError "did not return a
  // PRF result" — surface a CLEAR inline message only on the post-registration
  // confirm entry point (the registration itself already succeeded and is NOT
  // rolled back; the manual toggle remains a retry). Every other failure is the
  // server's own message.
  const classifyEnrollError = useCallback((err: unknown, isConfirm: boolean): string => {
    const noPrf = err instanceof Error && /did not return a PRF result/i.test(err.message);
    if (noPrf && isConfirm) return "This passkey can't be used for encryption (no PRF support).";
    if (err instanceof ApiRequestError) return err.error.message;
    if (err instanceof Error) return err.message;
    return 'Failed to enable this passkey for encryption.';
  }, []);

  // Run the enroll write with the entered password (+ any collected proof)
  // and clear whichever error sink the target write reports to. A failure the
  // server answered (`ApiRequestError`: a wrong password, a rejected factor,
  // a real server error) or that left the factor-carrying request's outcome
  // unknown (`EnrollmentCommitAmbiguousError`) is re-thrown — matches
  // `doRegister`/`doRemove` below — so the step-up path
  // surfaces it INSIDE the still-open `StepUpModal` via
  // `useStepUp`'s own ambiguity handling, instead of a detached write
  // that tears the flow down before the server even replies. Every OTHER
  // failure happened locally BEFORE any proof was sent — an authenticator
  // with no PRF support, a locked or ended session, a cancelled WebAuthn
  // prompt — so identity was never in question: reporting "we couldn't
  // confirm it's you" and offering a fresh code would name the wrong cause
  // and a next step that can never work. Those go to
  // the card's own sink, classified exactly as the password-only path always
  // did, and the flow closes.
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

  // Password step: when the flag is on, advance to the fresh-factor step (the
  // enroll call runs from `enrollStepUp`'s `onVerify` below); otherwise run
  // the enroll with the password alone. Only a server-answered or ambiguous
  // failure reaches the catch here (`doEnroll` handles local ones itself), so
  // a wrong password lands inline on the password prompt where it belongs.
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

  // User-initiated dismissal of the enroll flow — blocked while in flight so
  // an in-flight call can't be orphaned mid-request.
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

  // Reset every stage of the add flow (password → factor → ceremony).
  const resetAdd = useCallback(() => {
    setShowAddPassword(false);
    setShowAddFactor(false);
    setAddPassword('');
    setAddError(null);
    setAddBusy(false);
    setRegistering(false);
  }, []);

  // Run the full registration ceremony + gated write with the entered
  // password (+ a fresh factor when collected). Throws on failure so the
  // step-up path surfaces the modal's non-retryable error; the
  // password-only path catches below.
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
        // Encryption confirmation (replaces the prior silent auto-enroll): when the
        // session is unlocked (the HDK is in memory to wrap) AND the PRF-binding
        // state is positively resolved (a successful key-envelope read — guards
        // against treating an in-flight / failed fetch as "no slot"), prompt the
        // user to decide whether THIS passkey should unlock encrypted data on this
        // device. The dialog warns when another passkey already holds the slot
        // (confirming replaces it). Locked or unresolved → no dialog; registration
        // completes and the explicit "Use for encryption" toggle remains the path.
        // The enroll itself fires only on explicit confirmation (onConfirmRegisterEnroll).
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
    // Enrollment: the emailed code is the floor
    // ONLY while the account has no enrolled factor — `stepUpMethods` lists
    // it exactly then — and the server refuses it otherwise
    // (`STEP_UP_FACTOR_NOT_ELIGIBLE`), so no `recoveryMethods` are offered
    // here. Removal (`removeStepUp` below) keeps the no-lockout floor.
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

  // "Add passkey" → collect the password (baseline, unconditional).
  const onAddPasskeyClick = useCallback(() => {
    onError(null);
    setAddError(null);
    setShowAddPassword(true);
  }, [onError]);

  // Password step: when the flag is on, advance to the fresh-factor step
  // (the WebAuthn ceremony + write run from the StepUpModal's onVerify);
  // otherwise run the ceremony + write with the password only.
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
        // WebAuthn errors from @simplewebauthn/browser carry a useful
        // message (NotAllowedError, ConstraintError, etc.).
        setAddError(err.message);
      } else {
        setAddError('Failed to register passkey. Please try again.');
      }
    } finally {
      setAddBusy(false);
    }
  }, [stepUpRequired, doRegister, resetAdd]);

  // User-initiated dismissal of the add flow — blocked while in flight so an
  // in-flight call can't be orphaned mid-request.
  const cancelAdd = useCallback(() => {
    if (addBusy || registering || addStepUp.submitting) return;
    resetAdd();
  }, [addBusy, registering, addStepUp.submitting, resetAdd]);

  // Reset every stage of the remove flow (confirm → password → factor).
  const resetRemove = useCallback(() => {
    setRemoveTarget(null);
    setShowRemovePassword(false);
    setShowRemoveFactor(false);
    setRemovePassword('');
    setRemoveError(null);
  }, []);

  // Perform the removal with the entered password (+ a fresh factor when
  // collected). Throws on failure so the step-up path surfaces the modal's
  // non-retryable error; the password-only path catches below.
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

  // User-initiated dismissal of the remove flow — blocked while a remove is in
  // flight so an in-flight call can't be orphaned mid-request.
  const cancelRemove = useCallback(() => {
    if (removeBusy || removeStepUp.submitting) return;
    resetRemove();
  }, [removeBusy, removeStepUp.submitting, resetRemove]);

  // Confirm-dialog "Delete" → collect the password (baseline).
  const onRemoveConfirm = useCallback(() => {
    setRemoveError(null);
    setNotice(null);
    setShowRemovePassword(true);
  }, []);

  // Password step: when the flag is on, advance to the fresh-factor step;
  // otherwise remove with the password only (the server re-verifies it).
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

  // Lift a restricted passkey's post-reset restriction. Only `totp` / `passkey`
  // can vouch (Email-OTP has no enrollment timestamp to compare against the
  // reset — the server rejects it, so it's never offered here); `stepUpMethods`
  // already excludes restricted factors (computeFactors), so this also never
  // offers the target factor (or another restricted one) back to itself.
  const restrictionConfirmMethods = useMemo(
    () => stepUpMethods.filter((m) => m === 'totp' || m === 'passkey'),
    [stepUpMethods],
  );
  // Nothing predates the reset (an Email-OTP-only account whose sole factor is
  // the one being confirmed) — the escape hatch is removal, not a modal that
  // can never succeed.
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

  // "Nothing to confirm with" → remove instead (the existing gated remove
  // flow, starting from its own "Delete passkey?" confirm).
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

        {/* Add passkey sits BELOW the list (mock places it after the
            list, not in the card header). Behavior unchanged. */}
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

      {/* Registration encryption confirmation: after a
          passkey registers while unlocked, ask whether to use it to unlock
          encrypted data on this device. Warns when another passkey already
          holds the single per-household slot (confirming replaces it). */}
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
        // Benign: enrolling a passkey as an unlocker (or swapping which passkey
        // unlocks) changes nothing destructively — lime confirm, not red.
        destructive={false}
        onConfirm={onConfirmRegisterEnroll}
        onCancel={() => setRegisterEnrollTarget(null)}
      />

      {/* Fresh-proof gate before adding a passkey:
          the account password is always re-verified; the second factor step
          only shows when `AUTH_MFA_ENFORCED` is on. */}
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

      {/* Password re-verify baseline: removal always requires the account password. */}
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

      {/* Fresh second-factor step-up: shown after
          the password step when `AUTH_MFA_ENFORCED` is on. Email-OTP is the
          no-lockout floor, so removal stays completable even when the passkey
          being removed is the only routine factor. */}
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

      {/* Password floor before passkey-encryption enrollment — opens
          unconditionally, in BOTH `AUTH_MFA_ENFORCED` states, mirroring
          add/remove above. */}
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

      {/* Fresh second-factor step-up: shown
          after the password step when `AUTH_MFA_ENFORCED` is on — a
          passkey-encryption write into a household that already holds a slot
          is never exempt, including the first-ever enrollment. */}
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

      {/* Confirm (lift) a restricted passkey's post-reset restriction.
          No password step — the proof must come
          from an already-enrolled factor that predates the reset. */}
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

      {/* Nothing predates the reset — there is no factor that could ever
          confirm this one. The escape hatch is removal, not a dead-end modal. */}
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
                // Enable only — disabling a PRF slot is out of scope
                // (one slot per household; replaced by enabling another).
                if (next) void onEnableEncryption(pk);
              }}
            />
            {/* The toggle locks ON for the active key (you switch
                encryption by enabling a different passkey, not by
                turning this one off); say so, since a disabled
                control with no reason reads as broken. */}
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
