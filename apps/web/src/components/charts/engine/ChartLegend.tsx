/**
 * Legend for the SVG chart engine — replaces the Recharts `<Legend>`
 * that auto-collected one entry per non-hidden series. Renders a row of
 * color swatches + names below the chart. The swatch color is a runtime
 * theme-resolved series color, so it uses the SVG `<svg><rect fill>`
 * presentation attribute (not an inline style) to stay within the
 * inline-style ban.
 *
 * Interactive mode: when `onToggle` is supplied each entry renders as a
 * toggle `<button aria-pressed>` (native button → free keyboard + focus)
 * with isolate-first click semantics. A hidden entry is dimmed + struck
 * through via Tailwind utilities (no inline style). The hidden set is keyed
 * by series `name` so paired channels (Projection chart's solid/dashed)
 * toggle as one. Click passes the clicked key plus the full, de-duplicated
 * legend-key universe (`legendKeys`) to `onToggle` so the hook can isolate /
 * restore-all over the real key set. Without `onToggle` the legend stays
 * static (`<span>`s).
 */
import React from 'react';
import type { SeriesSpec } from './types';

interface ChartLegendProps {
  series: SeriesSpec[];
  /** Series names currently hidden (interactive mode). */
  hiddenSeries?: ReadonlySet<string>;
  /** When set, entries become toggle buttons that call this with the
   *  clicked series' key and the full de-duplicated legend-key universe.
   *  Omit for a static (read-only) legend. */
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
  // De-duplicated legend-key universe — each legend identity appears once, so
  // the hook's restore-all arithmetic can't be inflated by two visible entries
  // that share an identity.
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
