/**
 * Non-blocking "Household ready" banner shown once on the first login of a
 * new signup, after the primary HouseholdMember was silently seeded from the
 * signup name + birthdate. Offers the demo dataset without blocking the
 * new account.
 *
 * Two localStorage keys (keyed by householdId, hold only the id — no PII):
 *   - `retivo:household-ready-banner-pending:<householdId>` — written by
 *     App.tsx after a successful seed; signals "show on reload". Cleared on
 *     dismiss or demo load.
 *   - `retivo:household-ready-banner-dismissed:<householdId>` — written on
 *     dismiss or demo load; permanently blocks re-display.
 *
 * "Load demo data" clears the pending key + writes the dismissed key BEFORE
 * starting the (possibly slow) demo load, so a mid-load reload can't bring the
 * banner back. Both keys are wiped by the wholesale local-data nuke
 * (localStorage.clear).
 */
import React, { useState } from 'react';
import { Alert } from './Alert';
import { btnPrimaryClass, btnSecondarySmClass } from './dialog-chrome';
import { loadDemoData } from '../lib/demo-data-loader';

const BANNER_PENDING_KEY_PREFIX = 'retivo:household-ready-banner-pending:';
const BANNER_DISMISSED_KEY_PREFIX = 'retivo:household-ready-banner-dismissed:';

/** localStorage key signalling the banner should show on reload (per household). */
export function bannerPendingKey(householdId: string): string {
  return `${BANNER_PENDING_KEY_PREFIX}${householdId}`;
}

/** localStorage key permanently suppressing the banner (per household). */
export function bannerDismissedKey(householdId: string): string {
  return `${BANNER_DISMISSED_KEY_PREFIX}${householdId}`;
}

/**
 * True when the banner should be shown on mount: a successful seed wrote the
 * pending key and the user has not yet dismissed it. Used by App.tsx's
 * reload-visibility check.
 */
export function shouldShowReadyBanner(householdId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  return (
    !!localStorage.getItem(bannerPendingKey(householdId)) &&
    !localStorage.getItem(bannerDismissedKey(householdId))
  );
}

/** Two-key write: clear pending, set dismissed — the permanent suppression. */
function markBannerDismissed(householdId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(bannerPendingKey(householdId));
  localStorage.setItem(bannerDismissedKey(householdId), '1');
}

interface HouseholdReadyBannerProps {
  householdId: string;
  email: string;
  displayName: string;
  onDismiss(): void;
}

export const HouseholdReadyBanner: React.FC<HouseholdReadyBannerProps> = ({
  householdId,
  email,
  displayName,
  onDismiss,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDismissClick = () => {
    markBannerDismissed(householdId);
    onDismiss();
  };

  const onLoadDemo = async () => {
    // Clear pending + set dismissed BEFORE the (slow) load so a reload during
    // the load does not reshow the banner.
    markBannerDismissed(householdId);
    setLoading(true);
    setError(null);
    try {
      await loadDemoData({ householdId, email, displayName });
      onDismiss();
      // Hard reload so every mounted page re-reads demo aggregates — the
      // workspaceChanged event alone misses edges in practice (sidebar picker,
      // projection page). Matches FirstRunDemoModal.onLoaded behavior.
      window.location.reload();
    } catch {
      setError('Failed to load demo data. Please try again.');
      setLoading(false);
    }
  };

  return (
    <Alert tone="success" role="status" className="mb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ink">Your household is set up.</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onLoadDemo}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load demo data'}
          </button>
          <button
            type="button"
            className={btnSecondarySmClass}
            onClick={onDismissClick}
            disabled={loading}
            aria-label="Dismiss"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-negative">
          {error}
        </p>
      ) : null}
    </Alert>
  );
};
