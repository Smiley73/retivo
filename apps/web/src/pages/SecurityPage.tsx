/** Security settings view: route shell and card layout. It owns the top-of-page notice slots (error, enroll error, password changed) and the paired-card grid; behavior lives in the *Card siblings. */
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

  const [error, setError] = useState<React.ReactNode>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  // Locked with no way to unlock: authenticated, unlock resolved, a key envelope exists (so not first-run setup), and the in-memory key never materialised.
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
            // The card reports onError(null) at the start of every submit; clear the success notice on the same signal so a failed follow-up inside the 4s window can't show "changed successfully" beside the new error.
            setError(message);
            setPwSuccess(false);
          }}
          onSuccess={() => {
            setPwSuccess(true);
            setTimeout(() => setPwSuccess(false), 4000);
          }}
        />
      </CardPair>

      <CardPair>
        <PasskeyManagementCard onError={setError} onEnrollError={setEnrollError} />

        <RecoveryKeyEncryptionCard
          email={email}
          isUnlocked={isUnlocked}
          isLockedNoUnlock={isLockedNoUnlock}
        />
      </CardPair>

      <TwoFactorCard />

      <DeleteAccountCard householdId={householdId} email={email} />
    </section>
  );
};
