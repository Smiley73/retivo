/**
 * Reactive IndexedDB live-query read hook.
 *
 * `useAggregates(type)` returns the current non-deleted aggregates of one
 * type and re-renders on **any** write to that type's store — so a read-only
 * page can never silently regress to stale-after-bulk-fill data by forgetting
 * to wire a manual revision dependency. Freshness is guaranteed by
 * construction; "forgetting" is impossible.
 *
 * How it works:
 * - A `useSyncExternalStore` subscription combines two channels (union):
 *   the per-store FINE signal (`subscribeToStoreChanges` — single-row writes
 *   via `putAggregate` / `deleteAggregateLocally` / `clearAllStores`, per-type
 *   isolated) AND the coarse `WORKSPACE_CHANGED_EVENT` (the end-of-loop bulk-
 *   fill wake some writers still fire — sync bootstrap/pull, demo loader,
 *   expense-categories bootstrap — intentionally waking every reader once).
 *   Bulk fills now wrap their write loop in `withBatchedStoreSignals`, so they
 *   emit **one** fine signal per touched store on scope exit (not one per row);
 *   either channel re-reads the same rows. The snapshot is
 *   `fineVersion + coarseRevision`, a sync number; the rows are read async below.
 * - An effect keyed on that combined snapshot runs `listAggregates(type)` and
 *   commits the rows into state. The read is **cancel-stale**: a newer signal
 *   abandons an in-flight read so the few batched signals a bulk fill emits
 *   (or any back-to-back single writes) collapse to one correct final render.
 *
 * Tombstones are filtered by `listAggregates` (never returned here).
 *
 * NOT for draft-seeding load effects. Form pages and explicit-Save editors with
 * an unsaved-change guard must stay mount-only — auto-re-reading on a store
 * write would clobber the user's in-progress unsaved edits. They keep reading
 * via direct `listAggregates` at mount.
 *
 * SSR-guarded: with no `window` it returns an empty, not-ready result and
 * never touches IndexedDB.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { listAggregates, STORE_BY_TYPE, subscribeToStoreChanges, getStoreVersion } from '../db/store';
import type { Aggregate, AggregateType } from '../db/types';
import { WORKSPACE_CHANGED_EVENT } from './workspace-events';

export interface UseAggregatesResult {
  /** Current non-deleted aggregates of the type. Empty until the first read
   *  settles (use `ready` to tell "empty workspace" from "first paint"). */
  readonly aggregates: ReadonlyArray<Aggregate>;
  /** True once the first read settled (success or empty). */
  readonly ready: boolean;
  /** Non-null when the most recent read threw. */
  readonly error: Error | null;
}

/**
 * Coarse-event revision counter, shared across all `useAggregates` consumers.
 * `WORKSPACE_CHANGED_EVENT` fires once per bulk fill (the end-of-loop coarse
 * wake some writers still keep alongside the batched fine signals) and
 * intentionally wakes every reader, so the counter lives at module
 * scope: one window listener increments it and every subscribed snapshot folds
 * it in.
 */
let coarseRevision = 0;
const coarseListeners = new Set<() => void>();
let coarseWindowListener: (() => void) | null = null;

function ensureCoarseWindowListener(): void {
  if (coarseWindowListener || typeof window === 'undefined') return;
  coarseWindowListener = () => {
    coarseRevision += 1;
    coarseListeners.forEach((listener) => listener());
  };
  // Deliberate app-lifetime singleton: exactly one window listener, installed
  // lazily on first subscribe and never removed by design. It never grows
  // (the guard above is idempotent) and the per-consumer add/delete happens on
  // `coarseListeners`, not here — so this is bounded, not an unbounded-growth
  // or per-mount-leak concern.
  window.addEventListener(WORKSPACE_CHANGED_EVENT, coarseWindowListener);
}

const EMPTY_AGGREGATES: ReadonlyArray<Aggregate> = [];

export function useAggregates(type: AggregateType): UseAggregatesResult {
  const store = STORE_BY_TYPE[type];

  // Combined sync snapshot: per-store fine version + coarse bulk-fill revision.
  // useSyncExternalStore subscribes to BOTH channels and recomputes the number
  // whenever either fires, so the read effect below re-runs on the union.
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
    // SSR snapshot: no window, so both counters are 0.
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
      // Cancel-stale: a newer snapshot abandons this in-flight read so a burst
      // of per-row writes settles to one correct final render.
      cancelled = true;
    };
  }, [type, snapshot]);

  return { aggregates, ready, error };
}
