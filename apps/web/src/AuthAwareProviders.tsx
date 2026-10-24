// Wiring between AuthProvider and the providers that need post-login state (Theme, Sync).
// Separate from main.tsx so tests can check SyncProvider gets the live `refreshAccessToken`, not a stale snapshot.
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
  // Hold `householdId` back until unlock resolves and the HDK is held (or the household is unencrypted or awaiting
  // setup): starting sync earlier would write encrypted pull responses to IndexedDB as plaintext. The server's
  // `ENCRYPTION_REQUIRED` guard, not this gate, rejects plaintext pushes.
  const syncHouseholdId =
    unlockResolved && (isUnlocked || needsKeySetup) ? householdId : null;
  return (
    <ThemeProvider userId={me?.id ?? null}>
    <BetaFeaturesProvider userId={me?.id ?? null}>
      <SyncProvider
        householdId={syncHouseholdId}
        deviceId={deviceId}
        apiBaseUrl={API_BASE_URL}
        getAccessToken={getAccessToken}
        getCsrfToken={getCsrfToken}
        refreshAccessToken={refreshAccessToken}
        getHdk={getHdk}
        // DEVICE_MISMATCH recovery, the sole auth-sync bridge: set the one-shot signout reason (LoginPage shows
        // the notice), then log out so the next /login re-binds the device id.
        onDeviceMismatch={async () => {
          setSignoutReason(SIGNOUT_REASON_DEVICE_MISMATCH);
          await logout();
        }}
        mock={SYNC_MOCK}
      >
        {/* Inside SyncProvider so it outlives route changes and its tool handlers can read useSync() and useAuth(). */}
        <AssistantProvider>{children}</AssistantProvider>
      </SyncProvider>
    </BetaFeaturesProvider>
    </ThemeProvider>
  );
};
