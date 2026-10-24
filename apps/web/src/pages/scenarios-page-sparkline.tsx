/** Scenario-card balance sparkline: green when the final point is above $0, red at or below, tracking the at-horizon outcome like the neighbouring dollar figure, not the line's rise or fall.
* Decorative (aria-hidden): the ending balance beside it carries the meaning (same WCAG 1.4.11 carve-out as the chart-marker glyphs). */
import React from 'react';

const W = 104;
const H = 34;

export const ScenarioSparkline: React.FC<{ series: ReadonlyArray<number> }> = ({
  series,
}) => {
  if (series.length < 2) return null;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const sx = (i: number): number => (i / (series.length - 1)) * W;
  const sy = (v: number): number => H - 2 - ((v - min) / span) * (H - 4);
  const d = series
    .map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`)
    .join(' ');
  const solvent = series[series.length - 1] > 0;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="flex-shrink-0"
    >
      <path
        d={d}
        fill="none"
        className={solvent ? 'stroke-positive' : 'stroke-negative'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
