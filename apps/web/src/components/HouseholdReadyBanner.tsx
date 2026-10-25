/**
 * First-login "Household ready" banner offering the demo dataset. Two per-household localStorage keys, `pending`
 * (show on reload) and `dismissed` (block re-display), hold the id only and are wiped by the local-data clear.
 */
import React, { useState } from 'react';
import { Alert } from './Alert';
import { btnPrimaryClass, btnSecondarySmClass } from './dialog-chrome';
import { loadDemoData } from '../lib/demo-data-loader';

const BANNER_PENDING_KEY_PREFIX = 'retivo:household-ready-banner-pending:';
const BANNER_DISMISSED_KEY_PREFIX = 'retivo:household-ready-banner-dismissed:';

export function bannerPendingKey(householdId: string): string {
  return `${BANNER_PENDING_KEY_PREFIX}${householdId}`;
}

export function bannerDismissedKey(householdId: string): string {
  return `${BANNER_DISMISSED_KEY_PREFIX}${householdId}`;
}

/** True when a successful seed wrote the pending key and the user has not dismissed it. */
export function shouldShowReadyBanner(householdId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  return (
    !!localStorage.getItem(bannerPendingKey(householdId)) &&
    !localStorage.getItem(bannerDismissedKey(householdId))
  );
}

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
    // Written before the slow load so a reload during it does not reshow the banner.
    markBannerDismissed(householdId);
    setLoading(true);
    setError(null);
    try {
      await loadDemoData({ householdId, email, displayName });
      onDismiss();
      // Hard reload so every mounted page re-reads the demo aggregates; the workspaceChanged event
      // alone misses edges.
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
