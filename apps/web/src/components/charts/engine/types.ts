/**
 * Shared types for the SVG time-series chart engine: numeric X axis, numeric Y axis, and stacked area, line and bar
 * series.
 */
import type React from 'react';

/**
 * One chart datum with a numeric `x`; series read values by `dataKey`, `null` makes a line gap, and
 * extra keys ride along for tooltips.
 */
export type ChartDatum = Record<string, number | null> & { x: number };

type SeriesKind = 'area' | 'line' | 'bar';

type SeriesZoneKind = 'actual' | 'carried' | 'projected';

/**
 * A per-x-range style span over a stacked-area series, rendered as its own `<path>` with
 * `data-zone`. Zones are inclusive of both ends and adjacent zones share their boundary.
 */
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

/**
 * One rendered series layer. Areas sharing a `stackId` stack; all bar series form one signed stack
 * group.
 */
export interface SeriesSpec {
  kind: SeriesKind;
  /** Key into each datum for this series' value. */
  dataKey: string;
  /**
   * Accessible series name, emitted as the `name` attribute so tests and the tooltip can address
   * it.
   */
  name: string;
  color: string;
  /** Stack group id for `kind:'area'` only; bars and lines ignore it. */
  stackId?: string;
  /** Fill opacity for areas. Default 1. */
  fillOpacity?: number;
  /**
   * Per-x-range style zones (area series only); more than one zone renders one `<path>` per zone.
   */
  zones?: ReadonlyArray<SeriesZone>;
  /** Stroke width for lines. Default 2. */
  strokeWidth?: number;
  /** Dash pattern (lines only), e.g. '5 4'. */
  strokeDasharray?: string;
  /** Stroke override for areas (defaults to `color`). */
  stroke?: string;
  /** When true, the series is excluded from the legend. */
  hideFromLegend?: boolean;
  /**
   * Legend toggle identity, default `name`. Series sharing it toggle together; set per-series keys
   * when names are not unique.
   */
  legendId?: string;
  /** Per-point dot for line series. */
  dot?: boolean | ((point: ChartDatum, cx: number, cy: number) => React.ReactNode);
  /** Optional `url(#id)` stroke for gradient-split lines (net change). */
  strokeUrl?: string;
  /**
   * Renders a line as solid segments coloured by sign, split at the zero crossing. Prefer it to a
   * `strokeUrl` gradient for lines that must survive PDF export, since svg2pdf cannot stroke a
   * gradient.
   */
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
  /** When zoomed, skip the marker outside the active x-domain instead of extending it. */
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
