// `useAggregates(type)`: the non-deleted aggregates of one type, re-read on any write to that store, so a read-only page
// cannot go stale. Not for draft-seeding load effects: a re-read would clobber unsaved edits, so those read once at mount.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { listAggregates, STORE_BY_TYPE, subscribeToStoreChanges, getStoreVersion } from '../db/store';
import type { Aggregate, AggregateType } from '../db/types';
import { WORKSPACE_CHANGED_EVENT } from './workspace-events';

export interface UseAggregatesResult {
  /** Empty until the first read settles; `ready` tells an empty workspace from first paint. */
  readonly aggregates: ReadonlyArray<Aggregate>;
  readonly ready: boolean;
  readonly error: Error | null;
}

// Module-level because `WORKSPACE_CHANGED_EVENT` (the coarse bulk-fill wake, also fired by sync, the demo loader and
// the categories bootstrap) wakes every reader: one window listener bumps it and each snapshot folds it in.
let coarseRevision = 0;
const coarseListeners = new Set<() => void>();
let coarseWindowListener: (() => void) | null = null;

function ensureCoarseWindowListener(): void {
  if (coarseWindowListener || typeof window === 'undefined') return;
  coarseWindowListener = () => {
    coarseRevision += 1;
    coarseListeners.forEach((listener) => listener());
  };
  // App-lifetime singleton, installed on first subscribe and never removed; per-consumer add/delete is on `coarseListeners`.
  window.addEventListener(WORKSPACE_CHANGED_EVENT, coarseWindowListener);
}

const EMPTY_AGGREGATES: ReadonlyArray<Aggregate> = [];

export function useAggregates(type: AggregateType): UseAggregatesResult {
  const store = STORE_BY_TYPE[type];

  // Fine per-store version plus the coarse revision: the read effect re-runs on either channel.
  const snapshot = useSyncExternalStore(
    (onChange) => {
      ensureCoarseWindowListener();
      const unsubscribeFine = subscribeToStoreChanges(store, onChange);
      coarseListeners.add(onChange);
      return () => {
        unsubscribeFine();
        coarseListeners.delete(onChange);
      };
    },
    () => getStoreVersion(store) + coarseRevision,
    () => 0,
  );

  const [aggregates, setAggregates] = useState<ReadonlyArray<Aggregate>>(
    EMPTY_AGGREGATES,
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const rows = await listAggregates(type);
        if (cancelled) return;
        setAggregates(rows);
        setError(null);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setReady(true);
      }
    };
    void read();
    return () => {
      // Cancel-stale: a newer snapshot abandons this read, so a burst of writes settles to one render.
      cancelled = true;
    };
  }, [type, snapshot]);

  return { aggregates, ready, error };
}
