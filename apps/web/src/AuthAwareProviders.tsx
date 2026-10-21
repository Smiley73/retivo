/**
 * Wiring layer between AuthProvider and the providers that need
 * post-login state (Theme, Sync). Lives outside main.tsx so tests can
 * mount it directly to verify the prop chain — in particular, that
 * SyncProvider receives the live `refreshAccessToken` from AuthContext
 * (not a stale snapshot of api/client's module-level binding).
 */
import React from 'react';
import { useAuth } from './auth/AuthContext';
import {
  setSignoutReason,
  SIGNOUT_REASON_DEVICE_MISMATCH,
} from './auth/IdleTimer';
import { ThemeProvider } from './contexts/ThemeContext';
import { BetaFeaturesProvider } from './contexts/BetaFeaturesContext';
import { AssistantProvider } from './assistant/AssistantContext';
import { SyncProvider } from './sync/SyncContext';
import { getCurrentAccessToken } from './api/client';
import { API_BASE_URL } from './lib/api-base-url';

const SYNC_MOCK = (import.meta.env.VITE_SYNC_MOCK as string | undefined) === 'true';

function getAccessToken(): string | null {
  return getCurrentAccessToken();
}

function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|; )csrf-token=([^;]*)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export const AuthAwareProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    me,
    householdId,
    deviceId,
    refreshAccessToken,
    logout,
    getHdk,
    unlockResolved,
    isUnlocked,
    needsKeySetup,
  } = useAuth();
  // Gate the householdId handed to SyncProvider on the unlock check
  // (initializeUnlockState). Sync must not start before we know whether this
  // household is encrypted: for an activated household with no cached
  // HDK, sync starting early gets getHdk()=null and would write encrypted pull
  // responses to IndexedDB as-if-plaintext (data corruption). Only release the
  // householdId once unlock has resolved AND we either hold the HDK (isUnlocked)
  // or the household is unencrypted/awaiting setup (needsKeySetup). A resolved
  // "encrypted, locked" state (isUnlocked=false, needsKeySetup=false) keeps
  // householdId null → sync paused until the user unlocks.
  //
  // `needsKeySetup=true` deliberately
  // still releases householdId so an unkeyed, pre-setup household can sync its
  // plaintext bootstrap. Once the household has key envelopes (slots exist),
  // the server-side `ENCRYPTION_REQUIRED` guard — NOT a web-side sync gate — is
  // the enforcement boundary that rejects any plaintext push. No gating change
  // here is correct.
  const syncHouseholdId =
    unlockResolved && (isUnlocked || needsKeySetup) ? householdId : null;
  return (
    <ThemeProvider userId={me?.id ?? null}>
    {/* Per-user "Show beta features" switch — a localStorage preference keyed
        like the theme, so it sits beside ThemeProvider. */}
    <BetaFeaturesProvider userId={me?.id ?? null}>
      <SyncProvider
        householdId={syncHouseholdId}
        deviceId={deviceId}
        apiBaseUrl={API_BASE_URL}
        getAccessToken={getAccessToken}
        getCsrfToken={getCsrfToken}
        refreshAccessToken={refreshAccessToken}
        getHdk={getHdk}
        // DEVICE_MISMATCH recovery: the sole auth↔sync bridge, so
        // the host supplies the forced re-login. Set the one-shot signout
        // reason (LoginPage renders the "session reset" notice) then log
        // out; the next mount lands on a clean /login that re-binds the
        // device id.
        onDeviceMismatch={async () => {
          setSignoutReason(SIGNOUT_REASON_DEVICE_MISMATCH);
          await logout();
        }}
        mock={SYNC_MOCK}
      >
        {/* The AI assistant session: inside SyncProvider so it outlives route
            changes and the tool handlers can read useSync() and useAuth(). */}
        <AssistantProvider>{children}</AssistantProvider>
      </SyncProvider>
    </BetaFeaturesProvider>
    </ThemeProvider>
  );
};
