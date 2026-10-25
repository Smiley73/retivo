/**
 * Inner SVG-engine chart for Expenses-by-Category: one stacked-area layer per category at monthly resolution, sharing
 * the total-view chart's axis and tooltip.
 */
import React from 'react';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';
import type { CategoryMeta } from '../lib/category-palette';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import { assignMarkerLabelSlots } from '../lib/chart-markers';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import type { ChartChrome } from '../lib/tokens';
import { useChartChrome } from '../lib/use-chart-tokens';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export type { CategoryMeta };

interface InnerProps {
  rows: ExpenseCategoryMonthlyPoint[];
  categories: ReadonlyArray<CategoryMeta>;
  markers: CashflowChartMarker[];
  members: TooltipMember[];
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

interface FlatRow extends ChartDatum {
  fractionalYear: number;
  year: number;
  month0: number;
  total: number;
}

function flattenRows(
  rows: ExpenseCategoryMonthlyPoint[],
  categories: ReadonlyArray<CategoryMeta>,
): FlatRow[] {
  return rows.map((r) => {
    const flat: FlatRow = {
      x: r.fractionalYear,
      fractionalYear: r.fractionalYear,
      year: r.year,
      month0: r.month0,
      total: r.total,
    };
    for (const c of categories) {
      flat[`cat-${c.id}`] = r.byCategoryId[c.id] ?? 0;
    }
    return flat;
  });
}

export function makeTooltip(
  categories: ReadonlyArray<CategoryMeta>,
  members: TooltipMember[],
  chrome: ChartChrome,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as FlatRow;
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
        {[...categories]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => {
            const v = p[`cat-${c.id}`] ?? 0;
            if (v === 0 || hidden.has(c.name)) return null;
            return (
              <div key={c.id} className="flex justify-between gap-4">
                {/* eslint-disable-next-line no-restricted-syntax -- runtime per-category color from the theme-reactive tokens.ts palette */}
                <span style={{ color: c.color }}>{c.name}</span>
                <span>{formatCurrency(v)}</span>
              </div>
            );
          })}
        <div
          className="mt-1 flex justify-between gap-4 pt-1"
          // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
          style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
        >
          <span>Total</span>
          <span>{formatCurrency(p.total)}</span>
        </div>
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  categories,
  markers,
  members,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const data = React.useMemo(() => flattenRows(rows, categories), [rows, categories]);
  const xs = data.map((r) => r.fractionalYear);
  const xMin = Math.floor(xs[0]);
  // Death markers arrive as the integer `deathYear` and map to the December sample; applied to the
  // reference line and `xMax`.
  const mappedMarkers = markers.map((m) =>
    m.kind === 'death'
      ? { ...m, fractionalYear: Math.floor(m.fractionalYear) + 11 / 12 }
      : m,
  );
  const lastDeathFractional = mappedMarkers.length
    ? Math.max(...mappedMarkers.map((m) => m.fractionalYear))
    : null;
  const xMax = lastDeathFractional ?? xs[xs.length - 1];
  const chrome: ChartChrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const seriesSpecs: SeriesSpec[] = categories.map((c) => ({
    kind: 'area',
    dataKey: `cat-${c.id}`,
    name: c.name,
    color: c.color,
    stackId: 'expense-categories',
    fillOpacity: 0.55,
  }));
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
    () => makeTooltip(categories, members, chrome, hidden),
    [categories, members, chrome, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Expenses by category chart"
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
