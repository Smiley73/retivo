/**
 * Inner SVG-engine chart, lazily imported by `ProjectionChart`.
 *
 * Each method has two line channels (solid pre-retirement + dashed
 * through the retirement year) sharing a `name`; the tooltip dedupes by
 * name and the legend lists one entry per method.
 *
 * Death markers: this chart plots year-end balances at `x = year + 1`.
 * The life-expectancy markers arrive as the integer `deathYear`;
 * the chart applies its `+ 1` convention so each death marker lands at
 * `deathYear + 1` — the death-year-end balance point — hugging the last
 * data point. `tailEndYear = ceil(deathYear + 1) = deathYear + 1`, so the
 * right edge (and the MC overlay) ends at `deathYear + 1`.
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

/** Representative-run channel keys (one line, solid pre-retirement / dashed
 *  post). Populated on the chart rows when a Monte Carlo basis is active. */
const MC_LINE_SOLID = 'mcSolid';
const MC_LINE_DASHED = 'mcDashed';

const SERIES_LABELS: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

/** Per-year overlay channel keys + legend labels for the optional
 *  Monte-Carlo lines layered over the deterministic projection. Each
 *  line splits into a `*Solid` (pre-retirement) and `*Dashed` (the
 *  retirement year onward) channel, mirroring the Planned/TWR lines, so
 *  the post-retirement stretch reads as dashed. */
const MC_TYPICAL_SOLID = 'mcTypicalSolid';
const MC_TYPICAL_DASHED = 'mcTypicalDashed';
const MC_PESSIMISTIC_SOLID = 'mcPessimisticSolid';
const MC_PESSIMISTIC_DASHED = 'mcPessimisticDashed';
const MC_TYPICAL_LABEL = 'Typical';
const MC_PESSIMISTIC_LABEL = 'Pessimistic';

const DASH_PATTERN = '5 4';

/** Per-year overlay sample, split into solid (pre-retirement) and dashed
 *  (retirement-onward) channels for each of the two MC lines. */
export interface McCell {
  typicalSolid: number | null;
  typicalDashed: number | null;
  pessimisticSolid: number | null;
  pessimisticDashed: number | null;
}

/** Deterministic-null carrier row at chart-x `x` — holds an MC-only
 *  overlay point for a year past where the deterministic lines end. */
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

/**
 * Merge the per-year MC overlay (`mcByX`) onto the deterministic rows and
 * — crucially — keep the MC lines going past where the deterministic rows
 * stop. The drawdown engine stops emitting rows once BOTH Planned and TWR
 * deplete, so without this the Typical/Pessimistic lines get clipped to the
 * deterministic domain even though their data runs out to the MC horizon
 * (the household's life expectancy). MC-only years with no deterministic
 * row, up to `domainMax` (the chart's death+tail edge), get a
 * deterministic-null carrier row so the two MC lines render full length.
 */
export function buildProjectionData(
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
    // Skip carrier rows that hold no value (both paths already depleted) —
    // they'd contribute nothing and needlessly extend the x-domain.
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

/** Tooltip: dedupe solid+dashed channels by series name. The optional
 *  Monte-Carlo overlay lines (Typical / Pessimistic) append after the
 *  deterministic methods when their per-year value is present. */
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
  // Balance-chart death markers. The life-expectancy markers arrive as
  // the integer `deathYear`. This chart plots year-end values at
  // `x = year + 1`, so apply that SAME convention to the death markers it
  // renders — each lands at `deathYear + 1`, the death-year-end balance
  // point, hugging the last data point (no floating gap). Retirement
  // markers carry a true fractional date and are rendered as-is.
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
  // Derived from the `+1`-mapped death markers (= `deathYear + 1`), so the
  // right edge lands on the death-year-end terminal point: `tailEndYear =
  // ceil(deathYear + 1) = deathYear + 1` (no extra `+ 1` — the convention
  // already moved the marker), and the `visibleRows` filter keeps the
  // terminal point at `x = deathYear + 1`.
  const lastDeathFractional = balanceDeathMarkers.length
    ? Math.max(...balanceDeathMarkers.map((m) => m.fractionalYear))
    : null;
  const tailEndYear =
    lastDeathFractional !== null ? Math.ceil(lastDeathFractional) : null;
  const visibleRows =
    tailEndYear !== null ? rows.filter((r) => r.x <= tailEndYear) : rows;
  // Merge the optional Monte-Carlo overlay onto the chart's x convention:
  // the chart plots year-end values at `x = year + 1`, so the overlay value
  // for `firstYear + i` lands on `x = firstYear + i + 1`. The two MC lines
  // span every year the overlay covers — including years past where the
  // deterministic lines deplete (see `buildProjectionData`).
  //
  // Each MC line splits into a solid + dashed channel exactly like
  // Planned/TWR. The deterministic split's boundary is the year BEFORE
  // retirement (it carries both channels so the sub-paths join), making
  // the lines turn dashed at `x = retirementYear` — just left of the
  // mid-year retirement marker. Use the SAME boundary here so the MC
  // dashes start at the same x, not a year later. With no retirement
  // marker the whole overlay stays solid.
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
      // Once a percentile path depletes (≤ $0) its line should simply STOP,
      // not ride along the axis — drop those samples to `null` so the line
      // ends at depletion. Typical + Pessimistic truncate independently.
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
  // x range spans the full plotted set — including any MC-only rows that
  // extend past the last deterministic row (so the domain doesn't clip the
  // Typical/Pessimistic lines short).
  const xs = data.map((d) => d.x as number);
  const xMin = xs[0];
  const xMax = tailEndYear ?? xs[xs.length - 1];
  const dataTickSet = new Set(xs.filter(Number.isInteger));
  const xMinInt = Math.ceil(xMin);
  const xMaxInt = Math.ceil(xMax);
  for (let t = xMinInt; t <= xMaxInt; t += 1) dataTickSet.add(t);
  // One integer tick per calendar year. The shared Axes renderer thins a
  // dense year set (the Dashboard mini-chart + long horizons) down to
  // multiples of 5 + endpoints so the labels don't overwrite each other.
  const xTicks = Array.from(dataTickSet).sort((a, b) => a - b);
  // The full-domain x range extends to the last marker; legend builds
  // one entry per enabled method (solid channel only, dashed hidden).
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
  // Monte-Carlo overlay: two extra lines (Typical = P50, Pessimistic =
  // P25) with their own legend entries — no bands. Each is a solid +
  // dashed channel pair (dashed past retirement, like Planned/TWR); the
  // dashed channel shares the solid's `name` and is hidden from the
  // legend so one entry per line shows. Only drawn with an overlay.
  if (mcOverlay) {
    seriesSpecs.push(
      { kind: 'line', dataKey: MC_TYPICAL_SOLID, name: MC_TYPICAL_LABEL, color: mcTypicalColor, strokeWidth: 2 },
      { kind: 'line', dataKey: MC_TYPICAL_DASHED, name: MC_TYPICAL_LABEL, color: mcTypicalColor, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
      { kind: 'line', dataKey: MC_PESSIMISTIC_SOLID, name: MC_PESSIMISTIC_LABEL, color: mcPessimisticColor, strokeWidth: 2 },
      { kind: 'line', dataKey: MC_PESSIMISTIC_DASHED, name: MC_PESSIMISTIC_LABEL, color: mcPessimisticColor, strokeWidth: 2, strokeDasharray: DASH_PATTERN, hideFromLegend: true },
    );
  }
  // Representative-run line (the active Monte Carlo basis): one line drawn
  // ALONGSIDE Planned + TWR, solid pre-retirement / dashed through the
  // drawdown, in the tier color. The dashed channel shares the solid's `name`
  // and is hidden from the legend so one legend entry shows.
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
