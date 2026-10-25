/**
 * Legend row for the chart engine; with `onToggle` entries are `<button aria-pressed>` with isolate-first clicks,
 * keyed by series `name` so paired channels toggle as one.
 */
import React from 'react';
import type { SeriesSpec } from './types';

interface ChartLegendProps {
  series: SeriesSpec[];
  hiddenSeries?: ReadonlySet<string>;
  /**
   * Makes entries toggle buttons, called with the clicked key and the de-duplicated legend-key
   * universe; omit for a static legend.
   */
  onToggle?: (name: string, allNames: readonly string[]) => void;
}

const Swatch: React.FC<{ color: string }> = ({ color }) => (
  <svg width={12} height={12} aria-hidden="true">
    <rect width={12} height={12} rx={2} fill={color} />
  </svg>
);

export const ChartLegend: React.FC<ChartLegendProps> = ({
  series,
  hiddenSeries,
  onToggle,
}) => {
  const entries = series.filter((s) => !s.hideFromLegend);
  if (entries.length === 0) return null;
  // De-duplicated so two visible entries sharing an identity cannot inflate the restore-all
  // arithmetic.
  const legendKeys = Array.from(new Set(entries.map((e) => e.legendId ?? e.name)));
  return (
    <ul className="m-0 flex list-none flex-wrap justify-center gap-4 p-0 pt-2 text-xs text-muted">
      {entries.map((s) => {
        if (!onToggle) {
          return (
            <li key={s.dataKey} className="flex items-center gap-1">
              <Swatch color={s.color} />
              <span>{s.name}</span>
            </li>
          );
        }
        const key = s.legendId ?? s.name;
        const hidden = hiddenSeries?.has(key) ?? false;
        return (
          <li key={s.dataKey} className="flex">
            <button
              type="button"
              aria-pressed={hidden}
              onClick={() => onToggle(key, legendKeys)}
              className={`flex cursor-pointer items-center gap-1 rounded ${
                hidden ? 'line-through opacity-40' : 'hover:opacity-80'
              }`}
            >
              <Swatch color={s.color} />
              <span>{s.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};
