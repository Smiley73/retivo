// Header chip for live Plan stress-test status beside `SyncBadge`: running, error, and "Results ready" for 5 s.
// Copy-only (no percentage): fixed 10k-path runs finish sub-second, so a percentage only churned.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMonteCarlo } from './MonteCarloProvider';
import { CheckIcon } from '../components/icons';

const READY_DISMISS_MS = 5000;

// Pill base with per-state tones; every fg/bg pair is an AA-safe Tailwind default pair (contrast.ts).
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
