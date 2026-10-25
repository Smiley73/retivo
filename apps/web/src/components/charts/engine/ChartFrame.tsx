/**
 * SVG container and interaction surface of the chart engine: geometry, hover state, pointer wiring, and composition
 * of Axes, Series, Markers, Crosshair and Tooltip.
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
  /**
   * Series names to hide; hidden series are dropped before the stack and domain are computed, so
   * the rest restack and Y re-fits.
   */
  hiddenSeries?: ReadonlySet<string>;
  xTicks: number[];
  xTickFormatter?: (v: number) => string;
  yTickFormatter?: (v: number) => string;
  margin?: Partial<ChartMargin>;
  dragSelection?: [number, number] | null;
  isDragging?: boolean;
  pointerHandlers?: PointerHandlers;
  /** SVG `<defs>` injected before the series. */
  defs?: React.ReactNode;
  /** Dashed horizontal reference line at this data-space y. */
  hLineY?: number;
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

interface ResolvedFrame {
  margin: ChartMargin;
  geometry: ChartGeometry;
  activeX: [number, number];
  activeY: [number, number];
  visibleRows: ChartDatum[];
}

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

// Touch is ignored so a finger swiping to scroll over the chart keeps panning instead of arming a
// zoom (the `<svg>` also carries `touch-pan-y`). `onPointerCancel` shares the leave/up cleanup so a
// cancelled pointer cannot strand `isDragging` or the selection.
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

const LEGEND_ROW_H = 18;

interface LegendEntryLayout {
  name: string;
  color: string;
  x: number;
  row: number;
}

function legendEntryWidth(name: string): number {
  return 10 + 4 + name.length * 6.2 + 14;
}

// Pure layout (no DOM measure); widths are approximate, good enough for the off-screen PDF capture.
function layoutLegend(
  series: SeriesSpec[],
  width: number,
): { entries: LegendEntryLayout[]; rows: number } {
  const visible = series.filter((s) => !s.hideFromLegend);
  if (visible.length === 0) return { entries: [], rows: 0 };
  const maxRowWidth = width - 8;
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
  const entries: LegendEntryLayout[] = visible.map((s, i) => {
    const r = rowOf[i];
    const offset = Math.max(0, (width - rowWidths[r]) / 2);
    return { name: s.name, color: s.color, x: rawX[i] + offset, row: r };
  });
  return { entries, rows: row + 1 };
}

// In-SVG legend for PDF capture only: svg2pdf captures just the `<svg>`, so the HTML `ChartLegend`
// never reaches the PDF. Limited to `<rect fill>` and `<text>`, the only primitives svg2pdf
// renders.
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
            {/* Default alphabetic baseline: `dominantBaseline` is not reliably honored through
                svg2pdf. */}
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
  // Hidden series are dropped up front, so both the Y domain and `<Series>` restack and rescale;
  // they toggle by `legendId` (default `name`).
  const hiddenSeries = props.hiddenSeries;
  const isFiltering = (hiddenSeries?.size ?? 0) > 0;
  const visibleSeries = React.useMemo(
    () =>
      isFiltering
        ? props.series.filter((s) => !hiddenSeries!.has(s.legendId ?? s.name))
        : props.series,
    [props.series, hiddenSeries, isFiltering],
  );
  // An explicit zoom-fitted `yDomain` was computed from the unfiltered series; ignoring it re-fits
  // Y to the visible ones.
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

  // PDF capture only: extend the svg by a legend band so svg2pdf captures the full, unfiltered
  // legend.
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
