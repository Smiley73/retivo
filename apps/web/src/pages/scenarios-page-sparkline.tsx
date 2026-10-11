/**
 * Scenario-card balance sparkline (the Graphite Spectrum mock `.scn-spark`).
 * A tiny inline trend line of a scenario's per-year portfolio balance —
 * green when the plan still has money at the horizon (final point > $0),
 * red when it has run dry (final point at/below $0). The colour tracks the
 * at-horizon outcome, NOT the rise/fall of the line, so it matches the
 * neighbouring at-horizon dollar figure (red at/below $0) — a normal
 * spend-down that ends with money left over stays green.
 *
 * Purely decorative (`aria-hidden`): the numeric ending balance beside it
 * already carries the meaning for assistive tech, so the line adds no new
 * information — same WCAG 1.4.11 carve-out as the chart-marker glyphs.
 *
 * Geometry (104×34 viewBox, 2px stroke) mirrors the mock exactly; these
 * are SVG-coordinate primitives, not Tailwind spacing, so they live as
 * literal SVG attributes rather than utility classes.
 */
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
