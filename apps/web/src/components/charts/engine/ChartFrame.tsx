/**
 * ChartFrame — the SVG container + interaction surface for the bespoke
 * chart engine. Replaces the Recharts `<ResponsiveContainer><…Chart>`
 * shell. Owns:
 *   - responsive width (via `useChartGeometry`) + caller-fixed height
 *   - the inner plot rect (after margins)
 *   - pointer-move hover state (→ crosshair + HTML tooltip)
 *   - pointer down/move/up wiring to an engine-agnostic
 *     `PointerHandlers` (the reworked `useChartZoom`)
 *   - composition of Axes / Series / Markers / Crosshair / Tooltip
 *
 * Colors arrive pre-resolved on each `SeriesSpec`/`MarkerSpec`; chrome
 * (grid/axis/tooltip) is read inside the child components via
 * `useChartChrome()` so it re-flips on a `.dark` toggle.
 */
import React from 'react';
import { useChartChrome, useChartColors } from '../../../lib/use-chart-tokens';
import { PdfCaptureContext } from './pdf-capture-context';
import type {
  ChartDatum,
  ChartGeometry,
  ChartMargin,
  MarkerSpec,
  SeriesSpec,
} from './types';
import { Axes } from './Axes';
import { Series } from './Series';
import { Markers } from './Markers';
import { Crosshair } from './Crosshair';
import { ChartTooltip } from './ChartTooltip';
import { useChartGeometry } from './useChartGeometry';
import {
  defaultXDomain,
  nearestRow,
  resolveYDomain,
  rowsInDomain,
  xToPx,
  yToPx,
} from './scales';

const DEFAULT_MARGIN: ChartMargin = { top: 56, right: 16, bottom: 28, left: 72 };

/** Engine-agnostic pointer handlers (supplied by `useChartZoom`). The
 *  data-space x of the pointer is passed so the hook does the snap. */
interface PointerHandlers {
  onPointerDown: (dataX: number) => void;
  onPointerMove: (dataX: number) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
}

export interface ChartFrameProps {
  rows: ChartDatum[];
  series: SeriesSpec[];
  markers?: MarkerSpec[];
  height: number;
  /** Accessible chart description. */
  ariaLabel: string;
  xDomain: [number, number] | null;
  yDomain?: [number, number] | null;
  yScale?: 'linear' | 'log';
  /** Series names to hide (interactive legend filter). Hidden series are
   *  dropped before the stack/domain are computed, so the remaining
   *  series restack and the Y axis auto-fits to the visible data. */
  hiddenSeries?: ReadonlySet<string>;
  xTicks: number[];
  xTickFormatter?: (v: number) => string;
  yTickFormatter?: (v: number) => string;
  margin?: Partial<ChartMargin>;
  dragSelection?: [number, number] | null;
  isDragging?: boolean;
  pointerHandlers?: PointerHandlers;
  /** SVG `<defs>` (gradients) injected before the series. */
  defs?: React.ReactNode;
  /** Optional dashed horizontal reference line at this data-space y
   *  (e.g. the zero baseline on the return-% chart). */
  hLineY?: number;
  /** Render the HTML tooltip body for the hovered datum. */
  renderTooltip?: (datum: ChartDatum) => React.ReactNode;
}

function buildGeometry(
  width: number,
  height: number,
  margin: ChartMargin,
): ChartGeometry {
  return {
    width,
    height,
    margin,
    plot: {
      x: margin.left,
      y: margin.top,
      width: Math.max(0, width - margin.left - margin.right),
      height: Math.max(0, height - margin.top - margin.bottom),
    },
  };
}

/** Translate a DOM pointer event to a data-space x within the plot. */
function eventToDataX(
  evt: React.PointerEvent<SVGSVGElement>,
  geometry: ChartGeometry,
  xDomain: [number, number],
): number {
  const rect = evt.currentTarget.getBoundingClientRect();
  const px = evt.clientX - rect.left;
  const { plot } = geometry;
  const t = plot.width === 0 ? 0 : (px - plot.x) / plot.width;
  return xDomain[0] + t * (xDomain[1] - xDomain[0]);
}

/** Resolved domains + geometry + visible rows for the current render. */
interface ResolvedFrame {
  margin: ChartMargin;
  geometry: ChartGeometry;
  activeX: [number, number];
  activeY: [number, number];
  visibleRows: ChartDatum[];
}

/** Pure resolution of margins, geometry, and active x/y domains. */
function resolveFrame(props: ChartFrameProps, width: number): ResolvedFrame {
  const margin: ChartMargin = { ...DEFAULT_MARGIN, ...props.margin };
  const geometry = buildGeometry(width, props.height, margin);
  const activeX = props.xDomain ?? defaultXDomain(props.rows);
  const visibleRows = props.xDomain
    ? rowsInDomain(props.rows, props.xDomain)
    : props.rows;
  const activeY = resolveYDomain(
    visibleRows,
    props.series,
    props.yDomain ?? null,
    props.yScale ?? 'linear',
  );
  return { margin, geometry, activeX, activeY, visibleRows };
}

/** SVG pointer handler set, wired to the engine-agnostic hook.
 *
 *  Touch is deliberately ignored (the zoom gesture is mouse + pen only —
 *  see use-chart-zoom.ts): a `pointerType: 'touch'` down/move never
 *  starts or continues a drag, so a finger swiping to scroll the page over
 *  the chart keeps panning instead of arming a zoom selection (the `<svg>`
 *  also carries `touch-pan-y` so vertical scroll is preserved). The
 *  recharts port wired raw pointer events with no such guard. `onPointer
 *  Cancel` shares the leave/up cleanup path so a browser-cancelled pointer
 *  can't strand `isDragging`/the selection. */
function buildPointerHandlers(
  geometry: ChartGeometry,
  activeX: [number, number],
  setHoverX: (x: number | null) => void,
  pointerHandlers: PointerHandlers | undefined,
): Pick<
  React.SVGProps<SVGSVGElement>,
  | 'onPointerMove'
  | 'onPointerDown'
  | 'onPointerUp'
  | 'onPointerLeave'
  | 'onPointerCancel'
> {
  const leave = (): void => {
    setHoverX(null);
    pointerHandlers?.onPointerLeave();
  };
  return {
    onPointerMove: (evt) => {
      if (evt.pointerType === 'touch') return;
      const dataX = eventToDataX(evt, geometry, activeX);
      setHoverX(dataX);
      pointerHandlers?.onPointerMove(dataX);
    },
    onPointerDown: (evt) => {
      if (evt.pointerType === 'touch') return;
      pointerHandlers?.onPointerDown(eventToDataX(evt, geometry, activeX));
    },
    onPointerUp: () => pointerHandlers?.onPointerUp(),
    onPointerLeave: leave,
    onPointerCancel: leave,
  };
}

/** The composed SVG markup tree (axes, optional ref line, series, markers,
 *  crosshair). Chrome/colors are read here so they re-flip on a dark
 *  toggle without re-resolving the parent frame. */
function ChartCanvas(props: {
  frame: ResolvedFrame;
  series: SeriesSpec[];
  markers: MarkerSpec[];
  xTicks: number[];
  yScale: 'linear' | 'log';
  xTickFormatter?: (v: number) => string;
  yTickFormatter?: (v: number) => string;
  hLineY?: number;
  hoverX: number | null;
  dragSelection: [number, number] | null;
}): React.ReactElement {
  const { geometry, activeX, activeY, visibleRows } = props.frame;
  const colors = useChartColors();
  const chrome = useChartChrome();
  const refLineY = props.hLineY;
  return (
    <>
      <Axes
        geometry={geometry}
        xDomain={activeX}
        yDomain={activeY}
        xTicks={props.xTicks}
        yScale={props.yScale}
        xTickFormatter={props.xTickFormatter}
        yTickFormatter={props.yTickFormatter}
      />
      {refLineY !== undefined && (
        <line
          data-testid="chart-hline"
          x1={geometry.plot.x}
          y1={yToPx(refLineY, activeY, geometry.plot, props.yScale)}
          x2={geometry.plot.x + geometry.plot.width}
          y2={yToPx(refLineY, activeY, geometry.plot, props.yScale)}
          stroke={chrome.axis}
          strokeDasharray="2 2"
        />
      )}
      <Series
        rows={visibleRows}
        series={props.series}
        geometry={geometry}
        xDomain={activeX}
        yDomain={activeY}
        yScale={props.yScale}
      />
      <Markers markers={props.markers} geometry={geometry} xDomain={activeX} />
      <Crosshair
        hoverX={props.hoverX}
        geometry={geometry}
        xDomain={activeX}
        dragSelection={props.dragSelection}
        marqueeFill={colors.mcBandInner}
        marqueeStroke={colors.mcMedian}
      />
    </>
  );
}

/** Vertical pitch (px) between wrapped legend rows in the PDF-capture band.
 *  Holds the 10px swatch + the 11px label with a little breathing room. */
const LEGEND_ROW_H = 18;

/** One laid-out legend entry: its swatch color + name, positioned at `x`
 *  within the row at index `row`. */
interface LegendEntryLayout {
  name: string;
  color: string;
  x: number;
  row: number;
}

/** Approximate the rendered width of one legend entry (swatch + gap + label
 *  + trailing item gap), used to wrap entries into centered rows. */
function legendEntryWidth(name: string): number {
  return 10 + 4 + name.length * 6.2 + 14;
}

/** Lay legend entries out as centered horizontal rows that wrap within
 *  `width`. Pure (no DOM measure) — the per-entry width is an approximation,
 *  good enough for the off-screen PDF capture. Returns the positioned entries
 *  plus the row count so the caller can size the legend band. */
function layoutLegend(
  series: SeriesSpec[],
  width: number,
): { entries: LegendEntryLayout[]; rows: number } {
  const visible = series.filter((s) => !s.hideFromLegend);
  if (visible.length === 0) return { entries: [], rows: 0 };
  const maxRowWidth = width - 8;
  // First pass: assign each entry to a row + its running x within that row.
  const rowOf: number[] = [];
  const rawX: number[] = [];
  const rowWidths: number[] = [];
  let row = 0;
  let runningX = 0;
  for (const s of visible) {
    const w = legendEntryWidth(s.name);
    if (runningX > 0 && runningX + w > maxRowWidth) {
      rowWidths[row] = runningX;
      row += 1;
      runningX = 0;
    }
    rowOf.push(row);
    rawX.push(runningX);
    runningX += w;
  }
  rowWidths[row] = runningX;
  // Second pass: center each row by offsetting its entries by the row's slack.
  const entries: LegendEntryLayout[] = visible.map((s, i) => {
    const r = rowOf[i];
    const offset = Math.max(0, (width - rowWidths[r]) / 2);
    return { name: s.name, color: s.color, x: rawX[i] + offset, row: r };
  });
  return { entries, rows: row + 1 };
}

/** In-SVG legend band rendered ONLY during PDF capture (svg2pdf captures just
 *  the `<svg>`, so the on-screen HTML `ChartLegend` sibling never reaches the
 *  PDF). Reads the active chrome for a theme-correct (forced-light under the
 *  PDF host) text color. Kept to `<rect fill>` + `<text>` — the only primitives
 *  svg2pdf renders. */
function SvgLegend(props: {
  entries: LegendEntryLayout[];
  top: number;
}): React.ReactElement {
  const chrome = useChartChrome();
  return (
    <g transform={`translate(0, ${props.top})`}>
      {props.entries.map((e, i) => {
        const rowTop = e.row * LEGEND_ROW_H;
        return (
          <g key={`${e.name}-${i}`}>
            {/* Swatch + label share a vertical center: the swatch spans
                rowTop..rowTop+10 (center rowTop+5); the text baseline sits at
                rowTop+9 so its visual middle lands on the same center. The
                default (alphabetic) baseline is used — `dominantBaseline` is
                not reliably honored through svg2pdf. */}
            <rect x={e.x} y={rowTop} width={10} height={10} rx={2} fill={e.color} />
            <text x={e.x + 14} y={rowTop + 9} fontSize={11} fill={chrome.axis}>
              {e.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export const ChartFrame: React.FC<ChartFrameProps> = (props) => {
  const pdfCapture = React.useContext(PdfCaptureContext);
  const { ref, width } = useChartGeometry();
  const [hoverX, setHoverX] = React.useState<number | null>(null);
  // Drop hidden series up front: both the Y-domain (`resolveYDomain`) and
  // the renderer (`<Series>`) read only this array, so filtering here
  // restacks + rescales the chart with no further wiring. `null` markers/
  // x-domain/ticks are series-independent and untouched. Series toggle by
  // `legendId` (defaults to `name`) so an invisible stack helper can follow
  // its visible partner and duplicate names can still toggle independently.
  const hiddenSeries = props.hiddenSeries;
  const isFiltering = (hiddenSeries?.size ?? 0) > 0;
  const visibleSeries = React.useMemo(
    () =>
      isFiltering
        ? props.series.filter((s) => !hiddenSeries!.has(s.legendId ?? s.name))
        : props.series,
    [props.series, hiddenSeries, isFiltering],
  );
  // While filtering, ignore an explicit (zoom-fitted) yDomain — it was
  // computed from the UNFILTERED series, so honoring it would leave the Y
  // axis scaled to now-hidden data. Passing `null` re-fits Y to the visible
  // series within the current x-window (the zoom's x stays intact).
  const yDomainForFrame = isFiltering ? null : props.yDomain;
  const frame = resolveFrame(
    { ...props, series: visibleSeries, yDomain: yDomainForFrame },
    width,
  );
  const { geometry, activeX, visibleRows } = frame;
  const handlers = buildPointerHandlers(
    geometry,
    activeX,
    setHoverX,
    props.pointerHandlers,
  );
  const hovered =
    hoverX !== null && !props.isDragging
      ? nearestRow(visibleRows, hoverX)
      : null;
  const tooltipPx = hovered ? xToPx(hovered.x, activeX, geometry.plot) : 0;

  // PDF capture only: lay the (full, unfiltered) series legend out as wrapped
  // centered rows and extend the svg by a legend band so svg2pdf captures it.
  // On screen `pdfCapture` is false → `legendBandH` is 0 and the svg is
  // byte-identical to before (the on-screen HTML `ChartLegend` sibling stays
  // the only legend).
  const legend = pdfCapture
    ? layoutLegend(props.series, width)
    : { entries: [], rows: 0 };
  const legendBandH = pdfCapture ? legend.rows * LEGEND_ROW_H + 8 : 0;
  const svgH = props.height + legendBandH;

  return (
    <div
      ref={ref}
      className="relative w-full select-none"
      role="img"
      aria-label={props.ariaLabel}
    >
      <svg
        width="100%"
        height={svgH}
        viewBox={`0 0 ${width} ${svgH}`}
        preserveAspectRatio="none"
        className="touch-pan-y select-none"
        {...handlers}
      >
        {props.defs && <defs>{props.defs}</defs>}
        {pdfCapture && legend.entries.length > 0 && (
          <SvgLegend entries={legend.entries} top={props.height + 4} />
        )}
        <ChartCanvas
          frame={frame}
          series={visibleSeries}
          markers={props.markers ?? []}
          xTicks={props.xTicks}
          yScale={props.yScale ?? 'linear'}
          xTickFormatter={props.xTickFormatter}
          yTickFormatter={props.yTickFormatter}
          hLineY={props.hLineY}
          hoverX={hovered ? hovered.x : null}
          dragSelection={props.dragSelection ?? null}
        />
      </svg>
      {hovered && props.renderTooltip && (
        <ChartTooltip px={tooltipPx} containerWidth={width}>
          {props.renderTooltip(hovered)}
        </ChartTooltip>
      )}
    </div>
  );
};
