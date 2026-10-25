// Per-user "Show beta features" preference; `isBetaFeatureVisible(id)` = offered by the build and switched on.
// Stored like the theme preference (localStorage, keyed by userId, off by default).
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  BETA_FEATURES,
  OFFERED_BETA_FEATURE_IDS,
  type BetaFeature,
  type BetaFeatureId,
} from '../lib/feature-flags';

interface BetaFeaturesContextValue {
  /** The user's "Show beta features" switch. */
  showBetaFeatures: boolean;
  setShowBetaFeatures: (next: boolean) => void;
  /** Beta features this build offers (the config list), in registry order. */
  offeredBetaFeatures: readonly BetaFeature[];
  /** Offered by the build AND switched on by the user. */
  isBetaFeatureVisible: (id: BetaFeatureId) => boolean;
  /** Offered by the build, regardless of the user's switch. */
  isBetaFeatureOffered: (id: BetaFeatureId) => boolean;
}

const BetaFeaturesContext = createContext<BetaFeaturesContextValue | null>(null);

const STORAGE_KEY_PREFIX = 'retivo.betaFeatures.';
const ANON_KEY = `${STORAGE_KEY_PREFIX}anonymous`;

function storageKey(userId: string | null): string {
  return userId ? `${STORAGE_KEY_PREFIX}${userId}` : ANON_KEY;
}

function readPreference(userId: string | null): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(storageKey(userId)) === 'on';
}

function writePreference(userId: string | null, show: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(storageKey(userId), show ? 'on' : 'off');
}

interface BetaFeaturesProviderProps {
  children: React.ReactNode;
  /** Switches the storage key after login. Pass null when logged out. */
  userId?: string | null;
  /** Overrides the build's offered set; tests only. */
  offeredIds?: ReadonlySet<BetaFeatureId>;
}

interface PreferenceState {
  readonly forUserId: string | null;
  readonly show: boolean;
}

export const BetaFeaturesProvider: React.FC<BetaFeaturesProviderProps> = ({
  children,
  userId = null,
  offeredIds = OFFERED_BETA_FEATURE_IDS,
}) => {
  const [stored, setStored] = useState<PreferenceState>(() => ({
    forUserId: userId,
    show: readPreference(userId),
  }));

  // Re-read during render on an identity change: an effect would paint one frame with the anonymous default
  // and flash the beta gate notice.
  if (stored.forUserId !== userId) {
    setStored({ forUserId: userId, show: readPreference(userId) });
  }
  const showBetaFeatures =
    stored.forUserId === userId ? stored.show : readPreference(userId);

  const setShowBetaFeatures = useCallback(
    (next: boolean) => {
      setStored({ forUserId: userId, show: next });
      writePreference(userId, next);
    },
    [userId],
  );

  const value = useMemo<BetaFeaturesContextValue>(() => {
    const offeredBetaFeatures = BETA_FEATURES.filter((f) => offeredIds.has(f.id));
    const isBetaFeatureOffered = (id: BetaFeatureId): boolean => offeredIds.has(id);
    return {
      showBetaFeatures,
      setShowBetaFeatures,
      offeredBetaFeatures,
      isBetaFeatureOffered,
      isBetaFeatureVisible: (id) => showBetaFeatures && isBetaFeatureOffered(id),
    };
  }, [showBetaFeatures, setShowBetaFeatures, offeredIds]);

  return <BetaFeaturesContext.Provider value={value}>{children}</BetaFeaturesContext.Provider>;
};

export function useBetaFeatures(): BetaFeaturesContextValue {
  const ctx = useContext(BetaFeaturesContext);
  if (!ctx) throw new Error('useBetaFeatures must be used within a BetaFeaturesProvider');
  return ctx;
}
