/**
 * "Show beta features" preference — the per-user half of the feature-flag
 * gate (the build-time half is `lib/feature-flags.ts`).
 *
 * Persisted in localStorage per user, exactly like the theme preference
 * (`ThemeContext`): read synchronously so the sidebar renders the right
 * entries on first paint, keyed by userId after login. Off by default — a
 * person opts INTO beta features from Settings → Preferences.
 *
 * The stored value is re-read SYNCHRONOUSLY when `userId` changes (state is
 * keyed by the userId it was read for, and re-derived during render on a
 * mismatch) rather than in an effect — an effect would let one frame paint
 * with the anonymous default before an opted-in user's preference lands, and
 * that frame would briefly hide the beta sidebar entries / flash the gate
 * notice.
 *
 * `isBetaFeatureVisible(id)` is the single question every gated surface asks
 * (sidebar item, route gate, PDF export): offered by this build AND switched
 * on by this user.
 */
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
  /**
   * Overrides the build's offered set — for tests only (production always
   * reads the Vite-baked `OFFERED_BETA_FEATURE_IDS`).
   */
  offeredIds?: ReadonlySet<BetaFeatureId>;
}

/** The preference together with the userId it was read for. */
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

  // Identity changed (login / logout) → re-read for the new key during THIS
  // render, so the first paint under the new identity is already correct.
  // React's documented "adjusting state when a prop changes" pattern: the
  // setState during render schedules an immediate re-render before commit.
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
