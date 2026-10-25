/**
 * X/Y axes, gridlines and tick labels for the chart engine, using `useChartChrome()` neutrals so chrome re-flips on a
 * `.dark` toggle. SVG presentation attributes only.
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

const DENSE_X_TICK_THRESHOLD = 12;

// Thins dense year axes (more than ~12 integer ticks) to multiples of 5 plus the endpoints; sparse
// or non-integer axes are untouched.
function thinXTicks(xTicks: number[]): number[] {
  if (xTicks.length <= DENSE_X_TICK_THRESHOLD) return xTicks;
  const allYears = xTicks.every((t) => Number.isInteger(t));
  if (!allYears) return xTicks;
  const last = xTicks.length - 1;
  return xTicks.filter(
    (t, i) => t % 5 === 0 || i === 0 || i === last,
  );
}

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
