/**
 * Series renderer for the chart engine: stacked-area and line `<path>`s and stacked signed `<rect>` bars, each
 * carrying a `name` attribute. SVG presentation attributes only.
 */
import React from 'react';
import type { ChartDatum, ChartGeometry, SeriesSpec, SeriesZone } from './types';
import {
  areaPath,
  computeStackBands,
  linePath,
  xToPx,
  yToPx,
} from './scales';

interface SeriesLayerProps {
  rows: ChartDatum[];
  series: SeriesSpec[];
  geometry: ChartGeometry;
  xDomain: [number, number];
  yDomain: [number, number];
  yScale: 'linear' | 'log';
}

function groupByStack(series: SeriesSpec[]): SeriesSpec[][] {
  const byId = new Map<string, SeriesSpec[]>();
  const loose: SeriesSpec[][] = [];
  for (const s of series) {
    if (s.kind === 'area' && s.stackId) {
      const arr = byId.get(s.stackId) ?? [];
      arr.push(s);
      byId.set(s.stackId, arr);
    } else {
      loose.push([s]);
    }
  }
  return [...byId.values(), ...loose.filter((g) => g[0].kind === 'area')];
}

function AreaGroup({
  group,
  rows,
  geometry,
  xDomain,
  yDomain,
  yScale,
}: {
  group: SeriesSpec[];
} & Omit<SeriesLayerProps, 'series'>): React.ReactElement {
  const bands = computeStackBands(rows, group);
  return (
    <>
      {group.map((s) => {
        const b = bands.get(s.dataKey);
        if (!b) return null;
        const top = rows.map((d, i) => ({
          px: xToPx(d.x, xDomain, geometry.plot),
          py: yToPx(b.top[i], yDomain, geometry.plot, yScale),
        }));
        const base = rows.map((d, i) => ({
          px: xToPx(d.x, xDomain, geometry.plot),
          py: yToPx(b.base[i], yDomain, geometry.plot, yScale),
        }));
        const baseStroke = s.stroke ?? (s.color === 'none' ? 'none' : s.color);
        if (s.zones && s.zones.length > 0) {
          return (
            <React.Fragment key={s.dataKey}>
              {s.zones.map((zone, zi) =>
                renderZonePath({
                  s,
                  zone,
                  zi,
                  rows,
                  top,
                  base,
                  baseStroke,
                }),
              )}
            </React.Fragment>
          );
        }
        return (
          <path
            key={s.dataKey}
            name={s.name}
            d={areaPath(top, base)}
            fill={s.color}
            fillOpacity={s.fillOpacity ?? 1}
            stroke={baseStroke}
            strokeOpacity={0.9}
          />
        );
      })}
    </>
  );
}

// One zone span as its own `<path>` with `data-zone`; adjacent zones share a boundary row so areas
// stay connected.
function renderZonePath({
  s,
  zone,
  zi,
  rows,
  top,
  base,
  baseStroke,
}: {
  s: SeriesSpec;
  zone: SeriesZone;
  zi: number;
  rows: ChartDatum[];
  top: Array<{ px: number; py: number }>;
  base: Array<{ px: number; py: number }>;
  baseStroke: string;
}): React.ReactElement | null {
  const idx: number[] = [];
  rows.forEach((d, i) => {
    if (d.x >= zone.fromX && d.x <= zone.toX) idx.push(i);
  });
  if (idx.length === 0) return null;
  const zoneTop = idx.map((i) => top[i]);
  const zoneBase = idx.map((i) => base[i]);
  return (
    <path
      key={`${s.dataKey}-zone-${zi}`}
      name={s.name}
      data-zone={zone.kind}
      d={areaPath(zoneTop, zoneBase)}
      fill={s.color}
      fillOpacity={zone.fillOpacity ?? s.fillOpacity ?? 1}
      stroke={baseStroke}
      strokeOpacity={0.9}
      strokeDasharray={zone.strokeDasharray}
    />
  );
}

// Splits a line into same-sign runs with an interpolated vertex at the zero crossing; zero counts
// as positive.
function signSplitRuns(
  points: Array<{ px: number; py: number; v: number }>,
  zeroPy: number,
): Array<{ positive: boolean; pts: Array<{ px: number; py: number }> }> {
  const runs: Array<{ positive: boolean; pts: Array<{ px: number; py: number }> }> = [];
  if (points.length === 0) return runs;
  const isPos = (v: number): boolean => v >= 0;
  let cur = { positive: isPos(points[0].v), pts: [{ px: points[0].px, py: points[0].py }] };
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const p = points[i];
    if (isPos(prev.v) === isPos(p.v)) {
      cur.pts.push({ px: p.px, py: p.py });
      continue;
    }
    const t = prev.v / (prev.v - p.v);
    const crossing = { px: prev.px + (p.px - prev.px) * t, py: zeroPy };
    cur.pts.push(crossing);
    runs.push(cur);
    cur = { positive: isPos(p.v), pts: [crossing, { px: p.px, py: p.py }] };
  }
  runs.push(cur);
  return runs;
}

function LineSeries({
  s,
  rows,
  geometry,
  xDomain,
  yDomain,
  yScale,
}: { s: SeriesSpec } & Omit<SeriesLayerProps, 'series'>): React.ReactElement {
  const points = rows
    .map((d) => ({ d, v: d[s.dataKey] }))
    .filter((e): e is { d: ChartDatum; v: number } => typeof e.v === 'number' && Number.isFinite(e.v))
    .map(({ d, v }) => ({
      px: xToPx(d.x, xDomain, geometry.plot),
      py: yToPx(v, yDomain, geometry.plot, yScale),
      v,
      datum: d,
    }));
  // Sign-split lines stroke solid runs because svg2pdf cannot stroke a `strokeUrl` gradient.
  const lineNodes = s.signSplit
    ? signSplitRuns(points, yToPx(0, yDomain, geometry.plot, yScale)).map((run, i) => (
        <path
          key={i}
          name={s.name}
          d={linePath(run.pts)}
          fill="none"
          stroke={run.positive ? s.signSplit!.positiveColor : s.signSplit!.negativeColor}
          strokeWidth={s.strokeWidth ?? 2}
          strokeDasharray={s.strokeDasharray}
        />
      ))
    : (
      <path
        name={s.name}
        d={linePath(points)}
        fill="none"
        stroke={s.strokeUrl ?? s.color}
        strokeWidth={s.strokeWidth ?? 2}
        strokeDasharray={s.strokeDasharray}
      />
    );
  return (
    <g>
      {lineNodes}
      {s.dot &&
        points.map((p, i) =>
          typeof s.dot === 'function' ? (
            <React.Fragment key={i}>{s.dot(p.datum, p.px, p.py)}</React.Fragment>
          ) : (
            <circle key={i} cx={p.px} cy={p.py} r={3} fill={s.color} stroke={s.color} />
          ),
        )}
    </g>
  );
}

// Caps bar width so zooming in does not balloon bars into each other.
const MAX_BAR_PX = 48;

function barWidth(rows: ChartDatum[], geometry: ChartGeometry, xDomain: [number, number]): number {
  if (rows.length < 2) return 12;
  const step =
    Math.abs(
      xToPx(rows[1].x, xDomain, geometry.plot) - xToPx(rows[0].x, xDomain, geometry.plot),
    ) || 24;
  return Math.max(2, Math.min(step * 0.6, MAX_BAR_PX));
}

function BarStack({
  bars,
  rows,
  geometry,
  xDomain,
  yDomain,
  yScale,
}: { bars: SeriesSpec[] } & Omit<SeriesLayerProps, 'series'>): React.ReactElement {
  const w = barWidth(rows, geometry, xDomain);
  const zeroPy = yToPx(0, yDomain, geometry.plot, yScale);
  const bands = computeStackBands(rows, bars);
  return (
    <>
      {bars.map((s) => {
        const segs = bands.get(s.dataKey);
        if (!segs) return null;
        return (
          <g key={s.dataKey} name={s.name}>
            {rows.map((d, i) => {
              const v = d[s.dataKey] ?? 0;
              if (v === 0) return null;
              const cx = xToPx(d.x, xDomain, geometry.plot);
              const topPy = yToPx(segs.top[i], yDomain, geometry.plot, yScale);
              const basePy = yToPx(segs.base[i], yDomain, geometry.plot, yScale);
              const y = Math.min(topPy, basePy);
              const h = Math.max(1, Math.abs(basePy - topPy));
              return (
                <rect
                  key={i}
                  name={s.name}
                  x={cx - w / 2}
                  y={y}
                  width={w}
                  height={h}
                  fill={s.color}
                />
              );
            })}
          </g>
        );
      })}
      <line
        data-testid="chart-bar-zero"
        x1={geometry.plot.x}
        y1={zeroPy}
        x2={geometry.plot.x + geometry.plot.width}
        y2={zeroPy}
        stroke="currentColor"
        strokeOpacity={0.4}
      />
    </>
  );
}

export const Series: React.FC<SeriesLayerProps> = (props) => {
  const { series, rows, geometry, xDomain, yDomain, yScale } = props;
  const areaGroups = groupByStack(series);
  const bars = series.filter((s) => s.kind === 'bar');
  const lines = series.filter((s) => s.kind === 'line');
  return (
    <g>
      {areaGroups.map((g, i) => (
        <AreaGroup
          key={`area-${i}`}
          group={g}
          rows={rows}
          geometry={geometry}
          xDomain={xDomain}
          yDomain={yDomain}
          yScale={yScale}
        />
      ))}
      {bars.length > 0 && (
        <BarStack
          bars={bars}
          rows={rows}
          geometry={geometry}
          xDomain={xDomain}
          yDomain={yDomain}
          yScale={yScale}
        />
      )}
      {lines.map((s) => (
        <LineSeries
          key={s.dataKey}
          s={s}
          rows={rows}
          geometry={geometry}
          xDomain={xDomain}
          yDomain={yDomain}
          yScale={yScale}
        />
      ))}
    </g>
  );
};
