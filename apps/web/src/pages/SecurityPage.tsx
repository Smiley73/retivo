/**
 * Security settings view (Settings → Security). Route shell + card layout only;
 * each settings card is its own component (see the `*Card` siblings in this
 * directory). The page owns the three top-of-page notice slots (error /
 * enroll-error / password-changed) and the paired-card grid; behavior lives in
 * the cards.
 *
 * Hosts the credential + account cards: password, passkeys, recovery key &
 * encryption, two-factor auth, and the full-width Delete-account danger card.
 * Data + Workspace tools live on the Workspace page.
 */
import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { PageHeader } from '../components/PageHeader';
import { CardPair, SuccessNotice } from './profile-page-chrome';
import { AccountCard } from './AccountCard';
import { PasskeyManagementCard } from './PasskeyManagementCard';
import { PasswordChangeCard } from './PasswordChangeCard';
import { RecoveryKeyEncryptionCard } from './RecoveryKeyEncryptionCard';
import { TwoFactorCard } from './TwoFactorCard';
import { DeleteAccountCard } from './DeleteAccountCard';

export const SecurityPage: React.FC = () => {
  const {
    me,
    householdId,
    isAuthenticated,
    isUnlocked,
    needsKeySetup,
    unlockResolved,
  } = useAuth();

  // Top-of-page notice slots, shared by the cards that surface them: the generic
  // action error, the passkey-enroll error, and the password-changed success
  // notice. Kept on the page so they render above the card rows.
  const [error, setError] = useState<React.ReactNode>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  // "locked with no way to unlock" — authenticated, the unlock state has
  // resolved, the household has a key envelope (so this isn't first-run
  // setup), and the in-memory key never materialised.
  const isLockedNoUnlock =
    isAuthenticated && unlockResolved && !isUnlocked && !needsKeySetup;

  if (!me) return null;

  const email = me.email ?? '';

  return (
    <section aria-labelledby="security-heading">
      <PageHeader
        title={<span id="security-heading">Security</span>}
        subtitle="Passwords, passkeys, encryption, and your account."
      />


      {error && <Alert tone="error">{error}</Alert>}

      {enrollError && <Alert tone="error">{enrollError}</Alert>}

      {pwSuccess && (
        <SuccessNotice className="mb-4">
          Password changed successfully. Other devices have been signed out.
        </SuccessNotice>
      )}

      <CardPair>
        <AccountCard email={email} onError={setError} />

        <PasswordChangeCard
          email={email}
          onError={(message) => {
            // The card reports onError(null) at the start of every submit;
            // clear the success notice on the same signal so a failed
            // follow-up attempt inside the 4s window can't show
            // "changed successfully" next to the new error.
            setError(message);
            setPwSuccess(false);
          }}
          onSuccess={() => {
            setPwSuccess(true);
            setTimeout(() => setPwSuccess(false), 4000);
          }}
        />
      </CardPair>

      {/* Passkeys paired with recovery key & encryption — both are
          sign-in/key-protection cards, shown side by side; they stack to
          one column on narrow viewports. */}
      <CardPair>
        <PasskeyManagementCard onError={setError} onEnrollError={setEnrollError} />

        <RecoveryKeyEncryptionCard
          email={email}
          isUnlocked={isUnlocked}
          isLockedNoUnlock={isLockedNoUnlock}
        />
      </CardPair>

      {/* Two-factor authentication gets its own full-width row. */}
      <TwoFactorCard />

      <DeleteAccountCard householdId={householdId} email={email} />
    </section>
  );
};
