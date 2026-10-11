/**
 * Compact header chip surfacing live Plan stress-test run status.
 * Visible across all pages whenever a run is in flight or has just
 * finished. Click → opens the page. After a completed run, the
 * "Results ready" badge auto-dismisses after 5 seconds.
 *
 * Placed next to `SyncBadge` in the header.
 *
 * Status is shown as a copy-only badge (no percentage); runs at the
 * fixed 10k path count finish sub-second on modern hardware, so the
 * percentage churned for no informational benefit.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMonteCarlo } from './MonteCarloProvider';
import { CheckIcon } from '../components/icons';

const READY_DISMISS_MS = 5000;

// Header-chip pill base (legacy `.badge` re-expressed in Tailwind
// defaults). Per-state tone classes replace the deleted bespoke
// `var(--accent-*)` / `var(--danger-*)` / `var(--success)` inline
// colors. Every
// fg/bg pair is an AA-safe Tailwind-default pair (contrast.ts).
const CHIP_BASE =
  'inline-flex items-center gap-2 rounded-full border px-2 py-0.5 ' +
  'text-xs font-medium no-underline';
const CHIP_RUNNING = 'border-info/40 bg-surface-sunken text-info';
const CHIP_ERROR = 'border-negative/40 bg-surface-sunken text-negative';
const CHIP_READY = 'border-positive/40 bg-surface-sunken text-positive';

export function MonteCarloProgressChip() {
  const { status } = useMonteCarlo();
  const [showReady, setShowReady] = useState(false);

  useEffect(() => {
    if (status !== 'done') {
      setShowReady(false);
      return;
    }
    setShowReady(true);
    const t = setTimeout(() => setShowReady(false), READY_DISMISS_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (status === 'running') {
    return (
      <Link
        to="/balance-projection"
        className={`${CHIP_BASE} ${CHIP_RUNNING}`}
        aria-label="Plan stress-test crunching numbers"
      >
        Crunching numbers…
      </Link>
    );
  }

  if (status === 'error') {
    return (
      <Link
        to="/balance-projection"
        className={`${CHIP_BASE} ${CHIP_ERROR}`}
      >
        Plan stress-test · error
      </Link>
    );
  }

  if (showReady) {
    return (
      <Link
        to="/balance-projection"
        className={`${CHIP_BASE} ${CHIP_READY}`}
        aria-label="Plan stress-test results ready"
      >
        <CheckIcon />
        Results ready
      </Link>
    );
  }

  return null;
}
