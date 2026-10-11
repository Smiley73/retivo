/**
 * Shared types for the in-house SVG time-series chart engine. Pure type module — no
 * runtime, no JSX — so both the pure `scales.ts` helpers and the React
 * components import from one place.
 *
 * The engine renders a Cartesian time-series chart: a numeric X axis
 * (calendar / fractional year), a numeric Y axis (currency or percent),
 * and a stack of series specs (stacked areas, lines, stacked +/- bars).
 * Markers (retirement / life-expectancy / depletion) draw as dashed
 * vertical reference lines with labels floating in the top margin.
 */
import type React from 'react';

/** A single chart datum. Always carries a numeric `x`; series read
 *  their value by `dataKey`. Values may be `null` (line gaps — e.g. a
 *  method that depletes to zero terminates with `null`). Extra keys
 *  (year/month0/etc.) ride along for tooltips. */
export type ChartDatum = Record<string, number | null> & { x: number };

type SeriesKind = 'area' | 'line' | 'bar';

/** A semantic zone label for a per-x-range style span of a stacked area.
 *  Drives the `data-zone` attribute on the rendered `<path>` so tests can
 *  address each span as `path[name="…"][data-zone="…"]`. */
type SeriesZoneKind = 'actual' | 'carried' | 'projected';

/** A per-x-range style span over a stacked-area series. Splits one series
 *  into multiple `<path>` nodes (one per zone) so the projected region (lower
 *  opacity) and per-account carried-forward spans (dashed top-edge + muted
 *  fill) render distinct from the actual region. Zones cover `[fromX, toX]`
 *  in x-domain units, inclusive of both ends; adjacent zones share their
 *  boundary x so the rendered areas stay visually connected. */
export interface SeriesZone {
  readonly kind: SeriesZoneKind;
  /** Inclusive lower x bound (calendar/fractional year). */
  readonly fromX: number;
  /** Inclusive upper x bound (calendar/fractional year). */
  readonly toX: number;
  /** Fill opacity for this span. Defaults to the series' `fillOpacity`. */
  readonly fillOpacity?: number;
  /** Dash pattern for this span's top edge stroke, e.g. '4 3'. */
  readonly strokeDasharray?: string;
}

/** One rendered series layer. For areas, series sharing a `stackId`
 *  stack; for bars, ALL bar series form one signed stack group
 *  (stackId is ignored — mirrors `BarStack` in `Series.tsx`). */
export interface SeriesSpec {
  kind: SeriesKind;
  /** Key into each datum for this series' value. */
  dataKey: string;
  /** Accessible series name — emitted as the `name` attribute on the
   *  rendered `<path>`/`<rect>` so tests + the tooltip can address it. */
  name: string;
  /** Resolved fill/stroke color (already theme-resolved by the caller). */
  color: string;
  /** Stack group identifier. Only meaningful for `kind:'area'` — areas
   *  sharing the same id are signed-stacked together. `kind:'bar'`
   *  series ignore this field (all bars stack as one group). Lines also
   *  ignore it. */
  stackId?: string;
  /** Fill opacity for areas. Default 1. */
  fillOpacity?: number;
  /** Per-x-range style zones (area series only). When present and covering
   *  more than one zone, the series renders one `<path>` per zone (each
   *  carrying `data-zone`) instead of a single full-span path; a single zone
   *  (the common case) still renders exactly one `<path>` as today. */
  zones?: ReadonlyArray<SeriesZone>;
  /** Stroke width for lines. Default 2. */
  strokeWidth?: number;
  /** Dash pattern (lines only), e.g. '5 4'. */
  strokeDasharray?: string;
  /** Stroke override for areas (defaults to `color`). */
  stroke?: string;
  /** When true, the series is excluded from the legend. */
  hideFromLegend?: boolean;
  /** Legend toggle identity. Series sharing a `legendId` show/hide
   *  together; defaults to `name`. Use it when one legend entry must
   *  drive several specs (e.g. an invisible stack helper following its
   *  visible partner) or when `name` is not unique (e.g. two accounts
   *  with the same name must toggle independently → set per-series keys). */
  legendId?: string;
  /** Per-point dot for line series. */
  dot?: boolean | ((point: ChartDatum, cx: number, cy: number) => React.ReactNode);
  /** Optional `url(#id)` stroke for gradient-split lines (net change). */
  strokeUrl?: string;
  /** Render a line as solid green/red segments split at the zero crossing
   *  (each datum coloured by the sign of its value, with an interpolated
   *  vertex inserted where the line crosses zero). Line series only.
   *  Prefer this over a `strokeUrl` gradient for any line that must survive
   *  PDF export — svg2pdf cannot stroke a gradient, so gradient lines vanish
   *  in the PDF while these solid segments render. */
  signSplit?: { positiveColor: string; negativeColor: string };
}

/** A dashed vertical reference line with a label floating above the plot. */
export interface MarkerSpec {
  /** Fractional-year X position. */
  x: number;
  label: string;
  color: string;
  /** Vertical stagger slot (from `assignMarkerLabelSlots`). */
  slot: number;
  /** When true (zoomed), skip the marker if it falls outside the
   *  active x-domain instead of extending the domain. */
  clipToDomain?: boolean;
}

/** Pixel margins around the plot area. */
export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Resolved plot geometry: outer size, margins, inner plot rect. */
export interface ChartGeometry {
  width: number;
  height: number;
  margin: ChartMargin;
  /** Inner plot rectangle (after margins). */
  plot: { x: number; y: number; width: number; height: number };
}
