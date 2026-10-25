/**
 * Hidden-series state for an interactive legend, keyed by legend `name` so channel pairs toggle together. Clicks are
 * isolate-first; clicking the last visible series restores all.
 */
import React from 'react';

export interface SeriesVisibility {
  hidden: ReadonlySet<string>;
  /**
   * Applies an isolate-first click to `name`; orphan keys not in `allNames` are pruned first, since
   * the legend-key universe can change under a mounted chart.
   */
  toggle: (name: string, allNames: readonly string[]) => void;
  isHidden: (name: string) => boolean;
}

export function useSeriesVisibility(): SeriesVisibility {
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggle = React.useCallback(
    (name: string, allNames: readonly string[]) => {
      setHidden((prev) => {
        const pruned = new Set([...prev].filter((n) => allNames.includes(n)));
        if (pruned.size === 0) {
          return new Set(allNames.filter((n) => n !== name));
        }
        if (pruned.has(name)) {
          pruned.delete(name);
          return pruned;
        }
        if (allNames.length - pruned.size <= 1) {
          return new Set<string>();
        }
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
