/**
 * Inner SVG-engine implementation for the Expenses-page projection chart.
 * Lazy-imported by `ExpensesProjectionChart`.
 *
 * Two stacked area bands: Essential (baseline) + Discretionary (above),
 * with Total implied by the combined stack height — over per-month rows.
 * Y is annualized run-rate ($/yr); X is `fractionalYear` so transitions
 * land on the actual start/end month. When `singleSeriesLabel` is set,
 * only the `total` line renders.
 *
 * Marker labels float in the top margin, slot-staggered.
 */
import React from 'react';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { assignMarkerLabelSlots } from '../lib/chart-markers';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

interface InnerProps {
  rows: ExpenseProjectionMonthlyPoint[];
  markers: CashflowChartMarker[];
  members: TooltipMember[];
  singleSeriesLabel?: string;
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

function fiveYearTicks(min: number, max: number): number[] {
  const start = Math.ceil(min / 5) * 5;
  const ticks: number[] = [];
  for (let y = start; y <= max; y += 5) ticks.push(y);
  return ticks;
}

function makeExpensesTooltip(
  members: TooltipMember[],
  colors: ChartColors,
  chrome: ChartChrome,
  singleSeriesLabel?: string,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  const TOTAL_COLOR = colors.expenseTotal;
  const ESSENTIAL_COLOR = colors.essential;
  const DISCRETIONARY_COLOR = colors.discretionary;
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as ExpenseProjectionMonthlyPoint;
    const row = (label: string, color: string, value: number): React.ReactNode => (
      <div className="flex justify-between gap-4">
        {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
        <span style={{ color }}>{label}</span>
        <span>{formatCurrency(value)}</span>
      </div>
    );
    return (
      <div
        role="tooltip"
        className="px-3 py-2 text-sm"
        // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip chrome from tokens.ts (useTheme); flips on dark toggle
        style={{
          background: chrome.tooltipBg,
          border: `1px solid ${chrome.tooltipBorder}`,
          color: chrome.tooltipText,
        }}
      >
        <div className="mb-1 text-muted">
          {SHORT_MONTHS[p.month0]} {p.year}
        </div>
        {members.length > 0 && (
          <div className="mb-1 text-xs text-muted">
            {members.map((m, i) => (
              <span key={m.firstName + ':' + m.birthYear}>
                {i > 0 ? ' · ' : ''}
                {m.firstName} (age {p.year - m.birthYear})
              </span>
            ))}
          </div>
        )}
        {singleSeriesLabel
          ? (hidden.has(singleSeriesLabel)
              ? null
              : row(singleSeriesLabel, TOTAL_COLOR, p.total))
          : (
            <>
              {row('Total', chrome.tooltipText, p.total)}
              {!hidden.has('Essential') && row('Essential', ESSENTIAL_COLOR, p.essential)}
              {!hidden.has('Discretionary') && row('Discretionary', DISCRETIONARY_COLOR, p.discretionary)}
            </>
          )}
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  markers,
  members,
  singleSeriesLabel,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.fractionalYear })),
    [rows],
  );
  const xs = rows.map((r) => r.fractionalYear);
  const xMin = Math.floor(xs[0]);
  // Always-monthly chart. Death markers (`kind: 'death'`) arrive as the
  // integer `deathYear`; map each to the December sample
  // (`deathYear + 11/12`) — the last monthly data point — so the marker
  // hugs the data. Retirement markers (a true fractional date) are
  // rendered as-is. Applied to BOTH the reference line AND the `xMax`
  // derivation so December data isn't clipped by a raw integer x.
  const mappedMarkers = markers.map((m) =>
    m.kind === 'death'
      ? { ...m, fractionalYear: Math.floor(m.fractionalYear) + 11 / 12 }
      : m,
  );
  const lastDeathFractional = mappedMarkers.length
    ? Math.max(...mappedMarkers.map((m) => m.fractionalYear))
    : null;
  const xMax = lastDeathFractional ?? xs[xs.length - 1];
  const seriesSpecs: SeriesSpec[] = singleSeriesLabel
    ? [{ kind: 'line', dataKey: 'total', name: singleSeriesLabel, color: colors.expenseTotal, strokeWidth: 2 }]
    : [
        { kind: 'area', dataKey: 'essential', name: 'Essential', color: colors.essential, stackId: 'expenses', fillOpacity: 0.6 },
        { kind: 'area', dataKey: 'discretionary', name: 'Discretionary', color: colors.discretionary, stackId: 'expenses', fillOpacity: 0.4 },
      ];
  const markerSpecs: MarkerSpec[] = assignMarkerLabelSlots(mappedMarkers).map((m) => ({
    x: m.fractionalYear,
    label: m.label,
    color: m.color,
    slot: m.slot,
    clipToDomain: xDomain != null,
  }));
  const activeDomain = xDomain ?? [xMin, xMax];
  const ticks = fiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const tooltip = React.useMemo(
    () => makeExpensesTooltip(members, colors, chrome, singleSeriesLabel, hidden),
    [members, colors, chrome, singleSeriesLabel, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Expenses projection chart"
        xDomain={xDomain ?? [xMin, xMax]}
        yDomain={yDomain ?? null}
        xTicks={ticks}
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
