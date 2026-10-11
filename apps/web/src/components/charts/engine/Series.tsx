/**
 * Series renderer for the SVG chart engine. Turns a `SeriesSpec[]` +
 * data rows into stacked-area `<path>`s, line `<path>`s, and stacked
 * signed `<rect>` bars. Each rendered series node carries a `name`
 * attribute (the series' accessible name) so the shared `seriesColor()`
 * test helper and the tooltip can address it — preserving the Recharts
 * `path[name="…"]` contract the tests assert.
 *
 * SVG presentation attributes only (`d`, `fill`, `stroke`, `x`, `y`,
 * `width`, `height`) — no inline `style`.
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

/** Group series by stackId (lines have no stack → one-each groups). */
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
        // Zone-split rendering: one `<path>` per zone (each carrying
        // `data-zone`) so the projected region + carried-forward spans read
        // distinct. A single zone (the common case) renders exactly one path
        // as before — no behavior change for existing charts.
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

/** Render one zone span of a stacked-area series as its own `<path>`,
 *  carrying the series `name` plus a `data-zone` attribute. The span covers
 *  every row whose x falls inside `[fromX, toX]` (inclusive); adjacent zones
 *  share their boundary row so the areas stay visually connected. */
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

/** Split a line's points into runs of consecutive same-sign values, inserting
 *  an interpolated vertex at `zeroPy` wherever the value crosses zero, so each
 *  run can stroke a solid sign colour. Zero counts as positive. */
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
    // Sign change: interpolate the x where the value hits zero (the y there is
    // the plot's zero line) and split the run at that crossing vertex.
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
  // Sign-split lines stroke solid green/red runs (PDF-safe); the gradient
  // `strokeUrl` form is invisible in the PDF (svg2pdf can't stroke a gradient).
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

/** Widest a single bar may render, in px. Without a cap, zooming in
 *  stretches the per-year pixel `step` so far that bars balloon to fill
 *  the plot (and visually collide); the cap keeps them reading as bars at
 *  any zoom level while leaving the un-zoomed view (small step) untouched. */
const MAX_BAR_PX = 48;

/** Bar width in px, derived from row spacing and capped so deep zoom
 *  doesn't balloon the bars. */
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
