/**
 * In-memory show/hide state for an interactive chart legend. Tracks the
 * set of hidden series by their `name` (the legend identity) — not by
 * `dataKey` — so a single legend entry that maps to several specs sharing
 * a name (e.g. the Projection chart's `*Solid` + `*Dashed` channel pair)
 * toggles together.
 *
 * Click semantics are **isolate-first** (`toggle(name, allNames)`):
 * - From the pristine all-visible state (nothing hidden), a click *isolates*
 *   the clicked series — show only it, hide every other key.
 * - With some series already hidden, a click toggles individually: clicking a
 *   hidden series re-enables it; clicking a visible series hides it.
 * - Clicking the *only* remaining visible series *restores all* (clears the
 *   hidden set) — the legend UI can never reach an all-hidden state.
 *
 * Because the legend-key universe is not fixed for a chart's lifetime (e.g. the
 * Account Balance Stack rebuilds its series on `groupBy`/`showExcluded` without
 * remounting), the updater **first prunes orphan keys** — hidden keys no longer
 * in `allNames` — so the isolate / restore-all arithmetic always runs over real
 * keys and a universe change cannot trigger a spurious restore-all.
 *
 * State is deliberately ephemeral: it lives in component state and resets
 * on reload / unmount (no persistence — the legend filter is a transient
 * "focus on these series" affordance). `toggle`
 * returns a fresh `Set` each call so consumers (the frame's series filter,
 * the memoized tooltip) see a new identity and recompute.
 */
import React from 'react';

export interface SeriesVisibility {
  /** Series names currently hidden. */
  hidden: ReadonlySet<string>;
  /**
   * Apply an isolate-first click to `name`, given the full legend-key
   * universe `allNames` (supplied by `ChartLegend` at click time).
   */
  toggle: (name: string, allNames: readonly string[]) => void;
  /** Convenience predicate. */
  isHidden: (name: string) => boolean;
}

export function useSeriesVisibility(): SeriesVisibility {
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggle = React.useCallback(
    (name: string, allNames: readonly string[]) => {
      setHidden((prev) => {
        // Drop orphan keys so the state machine runs only on real keys.
        const pruned = new Set([...prev].filter((n) => allNames.includes(n)));
        if (pruned.size === 0) {
          // Pristine all-visible → isolate the clicked series.
          return new Set(allNames.filter((n) => n !== name));
        }
        if (pruned.has(name)) {
          // Re-enable a hidden series.
          pruned.delete(name);
          return pruned;
        }
        // `name` is currently visible.
        if (allNames.length - pruned.size <= 1) {
          // It is the only visible series → restore all.
          return new Set<string>();
        }
        // One of several visible → hide just it.
        pruned.add(name);
        return pruned;
      });
    },
    [],
  );
  const isHidden = React.useCallback(
    (name: string) => hidden.has(name),
    [hidden],
  );
  return { hidden, toggle, isHidden };
}
