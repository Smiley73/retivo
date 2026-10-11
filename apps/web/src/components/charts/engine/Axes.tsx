/**
 * X/Y axes, gridlines and tick labels for the SVG chart engine. Reads
 * the theme-reactive `CHART_CHROME` neutrals via `useChartChrome()`
 * (grid / axis stroke / tick text) so chrome re-flips on a `.dark`
 * toggle exactly like the series palette. SVG presentation attributes
 * only — no inline `style`.
 */
import React from 'react';
import { useChartChrome } from '../../../lib/use-chart-tokens';
import type { ChartGeometry } from './types';
import { xToPx, yToPx } from './scales';

interface AxesProps {
  geometry: ChartGeometry;
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yScale: 'linear' | 'log';
  xTickFormatter?: (v: number) => string;
  yTickFormatter?: (v: number) => string;
}

const AXIS_FONT = 12;

/** Above this count, a per-tick label set is too dense for the axis width
 *  and the labels overwrite each other — trigger calendar-year thinning. */
const DENSE_X_TICK_THRESHOLD = 12;

/**
 * Adaptive x-tick thinning. The time-series charts emit one tick per
 * integer calendar year; on narrow hosts (the Dashboard mini-chart) and
 * even on long projection horizons the year labels collide. When the tick
 * set is dense (> ~12 ticks) AND every tick looks like a calendar year
 * (an integer), keep only multiples of 5 plus the first + last tick;
 * otherwise render every tick unchanged. Non-integer / sparse axes (e.g.
 * the few y-derived or fractional sets) are never thinned.
 */
function thinXTicks(xTicks: number[]): number[] {
  if (xTicks.length <= DENSE_X_TICK_THRESHOLD) return xTicks;
  const allYears = xTicks.every((t) => Number.isInteger(t));
  if (!allYears) return xTicks;
  const last = xTicks.length - 1;
  return xTicks.filter(
    (t, i) => t % 5 === 0 || i === 0 || i === last,
  );
}

/** Build ~5 evenly spaced y ticks across the domain. */
function buildYTicks(
  yDomain: [number, number],
  scale: 'linear' | 'log',
): number[] {
  const [lo, hi] = yDomain;
  if (scale === 'log') {
    const ticks: number[] = [];
    const start = Math.ceil(Math.log10(Math.max(1, lo)));
    const end = Math.floor(Math.log10(Math.max(10, hi)));
    for (let e = start; e <= end; e += 1) ticks.push(10 ** e);
    return ticks.length > 0 ? ticks : [lo, hi];
  }
  const count = 4;
  const step = (hi - lo) / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i += 1) ticks.push(lo + step * i);
  return ticks;
}

export const Axes: React.FC<AxesProps> = ({
  geometry,
  xDomain,
  yDomain,
  xTicks,
  yScale,
  xTickFormatter,
  yTickFormatter,
}) => {
  const chrome = useChartChrome();
  const { plot } = geometry;
  const yTicks = buildYTicks(yDomain, yScale);
  const shownXTicks = thinXTicks(xTicks);
  const bottom = plot.y + plot.height;
  return (
    <g aria-hidden="true">
      {yTicks.map((t) => {
        const py = yToPx(t, yDomain, plot, yScale);
        return (
          <g key={`y-${t}`}>
            <line
              className="chart-grid-line"
              x1={plot.x}
              y1={py}
              x2={plot.x + plot.width}
              y2={py}
              stroke={chrome.grid}
              strokeDasharray="3 3"
            />
            <text
              x={plot.x - 6}
              y={py}
              fill={chrome.axis}
              fontSize={AXIS_FONT}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {yTickFormatter ? yTickFormatter(t) : String(Math.round(t))}
            </text>
          </g>
        );
      })}
      {shownXTicks.map((t) => {
        const px = xToPx(t, xDomain, plot);
        return (
          <text
            key={`x-${t}`}
            x={px}
            y={bottom + 16}
            fill={chrome.axis}
            fontSize={AXIS_FONT}
            textAnchor="middle"
          >
            {xTickFormatter ? xTickFormatter(t) : String(Math.round(t))}
          </text>
        );
      })}
      <line
        x1={plot.x}
        y1={bottom}
        x2={plot.x + plot.width}
        y2={bottom}
        stroke={chrome.axis}
      />
      <line
        x1={plot.x}
        y1={plot.y}
        x2={plot.x}
        y2={bottom}
        stroke={chrome.axis}
      />
    </g>
  );
};
