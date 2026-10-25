/**
 * Inner SVG-engine chart for `ProjectionChart`; solid and dashed channels share a `name` so the tooltip dedupes and
 * the legend lists one entry per method.
 */
import React from 'react';
import type {
  LifeExpectancyMarker,
  ProjectionChartRow,
  ProjectionMcOverlay,
  ProjectionMethod,
  RetirementMarker,
} from './ProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { assignMarkerLabelSlots } from '../lib/chart-markers';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

interface InnerProps {
  rows: ProjectionChartRow[];
  enabledCalculatedMethods: Set<Exclude<ProjectionMethod, 'planned'>>;
  retirementMarkers: RetirementMarker[];
  lifeExpectancyMarkers: LifeExpectancyMarker[];
  tooltipMembers: TooltipMember[];
  yScale?: 'linear' | 'log';
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
  mcOverlay?: ProjectionMcOverlay | null;
  mcLine?: { color: string; label: string } | null;
}

const MC_LINE_SOLID = 'mcSolid';
const MC_LINE_DASHED = 'mcDashed';

const SERIES_LABELS: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

const MC_TYPICAL_SOLID = 'mcTypicalSolid';
const MC_TYPICAL_DASHED = 'mcTypicalDashed';
const MC_PESSIMISTIC_SOLID = 'mcPessimisticSolid';
const MC_PESSIMISTIC_DASHED = 'mcPessimisticDashed';
const MC_TYPICAL_LABEL = 'Typical';
const MC_PESSIMISTIC_LABEL = 'Pessimistic';

const DASH_PATTERN = '5 4';

interface McCell {
  typicalSolid: number | null;
  typicalDashed: number | null;
  pessimisticSolid: number | null;
  pessimisticDashed: number | null;
}

function emptyDeterministicRow(x: number): ProjectionChartRow {
  return {
    year: x - 1,
    x,
    plannedSolid: null,
    plannedDashed: null,
    twrSolid: null,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
  };
}

function applyMcCell(row: ProjectionChartRow, mc: McCell): ChartDatum {
  return {
    ...row,
    [MC_TYPICAL_SOLID]: mc.typicalSolid,
    [MC_TYPICAL_DASHED]: mc.typicalDashed,
    [MC_PESSIMISTIC_SOLID]: mc.pessimisticSolid,
    [MC_PESSIMISTIC_DASHED]: mc.pessimisticDashed,
  };
}

// Merges the per-year MC overlay onto the deterministic rows. The drawdown engine stops emitting
// rows once Planned and TWR both deplete, so MC-only years up to `domainMax` get a null carrier row
// to keep the MC lines full length.
function buildProjectionData(
  visibleRows: ProjectionChartRow[],
  mcByX: Map<number, McCell>,
  domainMax: number,
): ChartDatum[] {
  const rowByX = new Map<number, ChartDatum>();
  for (const r of visibleRows) {
    const mc = mcByX.get(r.x);
    rowByX.set(r.x, mc ? applyMcCell(r, mc) : { ...r });
  }
  for (const [x, mc] of mcByX) {
    if (rowByX.has(x) || x > domainMax) continue;
    // Skip carriers with no value (both paths depleted); they would only extend the x-domain.
    if (
      mc.typicalSolid == null &&
      mc.typicalDashed == null &&
      mc.pessimisticSolid == null &&
      mc.pessimisticDashed == null
    ) {
      continue;
    }
    rowByX.set(x, applyMcCell(emptyDeterministicRow(x), mc));
  }
  return Array.from(rowByX.values()).sort((a, b) => a.x - b.x);
}

function makeProjectionTooltip(
  members: TooltipMember[],
  chrome: ChartChrome,
  seriesColors: Record<ProjectionMethod, string>,
  mcColors: { typical: string; pessimistic: string },
  mcLine: { color: string; label: string } | null,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const seen = new Map<string, { value: number; color: string }>();
    const channels: Array<[string, string, string]> = [
      ['plannedSolid', seriesColors.planned, SERIES_LABELS.planned],
      ['plannedDashed', seriesColors.planned, SERIES_LABELS.planned],
      ['twrSolid', seriesColors.twr, SERIES_LABELS.twr],
      ['twrDashed', seriesColors.twr, SERIES_LABELS.twr],
      [MC_TYPICAL_SOLID, mcColors.typical, MC_TYPICAL_LABEL],
      [MC_TYPICAL_DASHED, mcColors.typical, MC_TYPICAL_LABEL],
      [MC_PESSIMISTIC_SOLID, mcColors.pessimistic, MC_PESSIMISTIC_LABEL],
      [MC_PESSIMISTIC_DASHED, mcColors.pessimistic, MC_PESSIMISTIC_LABEL],
      ...(mcLine
        ? ([
            [MC_LINE_SOLID, mcLine.color, mcLine.label],
            [MC_LINE_DASHED, mcLine.color, mcLine.label],
          ] as Array<[string, string, string]>)
        : []),
    ];
    for (const [key, color, name] of channels) {
      const v = datum[key];
      if (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        !seen.has(name) &&
        !hidden.has(name)
      ) {
        seen.set(name, { value: v, color });
      }
    }
    if (seen.size === 0) return null;
    const yearEnd = Math.round(datum.x) - 1;
    return (
      <div
        className="px-3 py-2 text-sm"
        // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip chrome from tokens.ts (useTheme); flips on dark toggle
        style={{
          background: chrome.tooltipBg,
          border: `1px solid ${chrome.tooltipBorder}`,
          color: chrome.tooltipText,
        }}
      >
        <div className="mb-1 text-muted">
          {`Year End ${yearEnd}`}
        </div>
        {members.length > 0 && (
          <div className="mb-1 text-xs text-muted">
            {members.map((m, i) => (
              <span key={m.firstName + ':' + m.birthYear}>
                {i > 0 ? ' · ' : ''}
                {m.firstName} (age {yearEnd - m.birthYear})
              </span>
            ))}
          </div>
        )}
        {Array.from(seen.entries()).map(([name, { value, color }]) => (
          <div key={name} className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime per-series color from the theme-reactive tokens.ts map */}
            <span style={{ color }}>{name}</span>
            <span>{formatCurrency(value)}</span>
          </div>
        ))}
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  enabledCalculatedMethods,
  retirementMarkers,
  lifeExpectancyMarkers,
  tooltipMembers,
  yScale = 'linear',
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
  mcOverlay = null,
  mcLine = null,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const seriesColors: Record<ProjectionMethod, string> = {
    planned: colors.plannedSeries,
    twr: colors.twr,
  };
  const mcTypicalColor = colors.mcTypical;
  const mcPessimisticColor = colors.mcPessimistic;
  // The chart plots year-end values at `x = year + 1`, so death markers move the same way and land
  // on the last data point.
  const balanceDeathMarkers = lifeExpectancyMarkers.map((m) => ({
    fractionalYear: m.fractionalYear + 1,
    label: m.label,
    color: m.color,
  }));
  const slottedMarkers = assignMarkerLabelSlots([
    ...retirementMarkers.map((m) => ({
      fractionalYear: m.fractionalYear,
      label: m.label,
      color: colors.retirementMarker,
    })),
    ...balanceDeathMarkers,
  ]);
  // The right edge is the death-year-end terminal point; the convention already moved the marker,
  // so no extra `+ 1`.
  const lastDeathFractional = balanceDeathMarkers.length
    ? Math.max(...balanceDeathMarkers.map((m) => m.fractionalYear))
    : null;
  const tailEndYear =
    lastDeathFractional !== null ? Math.ceil(lastDeathFractional) : null;
  const visibleRows =
    tailEndYear !== null ? rows.filter((r) => r.x <= tailEndYear) : rows;
  // Overlay values land on `x = firstYear + i + 1`. The MC lines turn dashed at the same boundary
  // as Planned/TWR (the year before retirement); with no retirement marker they stay solid.
  const mcRetYear = retirementMarkers.length
    ? Math.floor(retirementMarkers[0].fractionalYear)
    : null;
  const mcBoundaryYear = mcRetYear === null ? null : mcRetYear - 1;
  const mcByX = new Map<number, McCell>();
  if (mcOverlay) {
    const len = Math.min(
      mcOverlay.typical.length,
      mcOverlay.pessimistic.length,
    );
    for (let i = 0; i < len; i += 1) {
      const mcYear = mcOverlay.firstYear + i;
      const isSolid = mcBoundaryYear === null || mcYear <= mcBoundaryYear;
      const isDashed = mcBoundaryYear !== null && mcYear >= mcBoundaryYear;
      // A depleted percentile path stops at depletion rather than riding the axis; Typical and
      // Pessimistic truncate independently.
      const tv = mcOverlay.typical[i] > 0 ? mcOverlay.typical[i] : null;
      const pv = mcOverlay.pessimistic[i] > 0 ? mcOverlay.pessimistic[i] : null;
      mcByX.set(mcYear + 1, {
        typicalSolid: isSolid ? tv : null,
        typicalDashed: isDashed ? tv : null,
        pessimisticSolid: isSolid ? pv : null,
        pessimisticDashed: isDashed ? pv : null,
      });
    }
  }
  const data = buildProjectionData(
    visibleRows,
    mcByX,
    tailEndYear ?? Infinity,
  );
  // Spans the full plotted set, including MC-only rows past the last deterministic row.
  const xs = data.map((d) => d.x as number);
  const xMin = xs[0];
  const xMax = tailEndYear ?? xs[xs.length - 1];
  const dataTickSet = new Set(xs.filter(Number.isInteger));
  const xMinInt = Math.ceil(xMin);
  const xMaxInt = Math.ceil(xMax);
  for (let t = xMinInt; t <= xMaxInt; t += 1) dataTickSet.add(t);
  const xTicks = Array.from(dataTickSet).sort((a, b) => a - b);
  const seriesSpecs: SeriesSpec[] = [
    { kind: 'line', dataKey: 'plannedSolid', name: SERIES_LABELS.planned, color: seriesColors.planned, strokeWidth: 2 },
    { kind: 'line', dataKey: 'plannedDashed', name: SERIES_LABELS.planned, color: seriesColors.planned, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
  ];
  if (enabledCalculatedMethods.has('twr')) {
    seriesSpecs.push(
      { kind: 'line', dataKey: 'twrSolid', name: SERIES_LABELS.twr, color: seriesColors.twr, strokeWidth: 2 },
      { kind: 'line', dataKey: 'twrDashed', name: SERIES_LABELS.twr, color: seriesColors.twr, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
    );
  }
  // The dashed channel shares the solid's `name` and is hidden from the legend so each line shows
  // once.
  if (mcOverlay) {
    seriesSpecs.push(
      { kind: 'line', dataKey: MC_TYPICAL_SOLID, name: MC_TYPICAL_LABEL, color: mcTypicalColor, strokeWidth: 2 },
      { kind: 'line', dataKey: MC_TYPICAL_DASHED, name: MC_TYPICAL_LABEL, color: mcTypicalColor, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
      { kind: 'line', dataKey: MC_PESSIMISTIC_SOLID, name: MC_PESSIMISTIC_LABEL, color: mcPessimisticColor, strokeWidth: 2 },
      { kind: 'line', dataKey: MC_PESSIMISTIC_DASHED, name: MC_PESSIMISTIC_LABEL, color: mcPessimisticColor, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
    );
  }
  // Representative-run line for the active Monte Carlo basis; dashed channel hidden from the legend
  // as above.
  if (mcLine) {
    seriesSpecs.push(
      { kind: 'line', dataKey: MC_LINE_SOLID, name: mcLine.label, color: mcLine.color, strokeWidth: 2 },
      { kind: 'line', dataKey: MC_LINE_DASHED, name: mcLine.label, color: mcLine.color, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
    );
  }
  const markerSpecs: MarkerSpec[] = slottedMarkers.map((m) => ({
    x: m.fractionalYear,
    label: m.label,
    color: m.color,
    slot: m.slot,
    clipToDomain: xDomain != null,
  }));
  const plannedColor = seriesColors.planned;
  const twrColor = seriesColors.twr;
  const mcLineColor = mcLine?.color ?? null;
  const mcLineLabel = mcLine?.label ?? null;
  const tooltip = React.useMemo(
    () =>
      makeProjectionTooltip(
        tooltipMembers,
        chrome,
        { planned: plannedColor, twr: twrColor },
        { typical: mcTypicalColor, pessimistic: mcPessimisticColor },
        mcLineColor && mcLineLabel ? { color: mcLineColor, label: mcLineLabel } : null,
        hidden,
      ),
    [
      tooltipMembers,
      chrome,
      plannedColor,
      twrColor,
      mcTypicalColor,
      mcPessimisticColor,
      mcLineColor,
      mcLineLabel,
      hidden,
    ],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Balance projection chart"
        xDomain={xDomain ?? [xMin, xMax]}
        yDomain={yDomain ?? null}
        yScale={yScale}
        xTicks={xTicks}
        xTickFormatter={(v) => String(Math.round(v))}
        yTickFormatter={formatCurrencyShort}
        dragSelection={dragSelection ?? null}
        isDragging={isDragging}
        pointerHandlers={mouseHandlers}
        hiddenSeries={hidden}
        renderTooltip={tooltip}
      />
      <ChartLegend series={seriesSpecs} hiddenSeries={hidden} onToggle={toggle} />
    </div>
  );
};

export default InnerChart;
