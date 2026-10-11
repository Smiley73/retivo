/**
 * Inner SVG-engine chart for the cashflow band. Lazily imported.
 *
 * Three layers:
 *   1. Stacked AREA — Essential (darker) + Discretionary (lighter) +
 *      Taxes (the portfolio tax cash) expenses across the retirement
 *      window. The Taxes band sits atop essential/discretionary so the
 *      stack top is the taxes-inclusive total expenses.
 *   2. Shortfall RIBBON — translucent red fill between the total-income
 *      line and the expense stack top (now taxes-inclusive), on years
 *      where income < expenses + taxes. An invisible base
 *      (`shortfallBase` = totalIncome) lifts the red `shortfallHeight`
 *      layer up.
 *   3. LINE — Total income overlaid on top.
 *
 * Resolution: caller-driven via `granularity` ('monthly' / 'yearly').
 */
import React from 'react';
import type {
  CashflowChartMarker,
  CashflowMonthlyPoint,
} from '../lib/cashflow-chart-types';
import type { CategoryMeta } from '../lib/category-palette';
import type { TooltipMember } from './tooltip-member';
import { makeCashflowTooltip } from './CashflowProjectionChartInner.tooltip';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrencyShort } from '../lib/format-currency';
import { adaptiveYearTicks, assignMarkerLabelSlots } from '../lib/chart-markers';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

// Re-exported so the tooltip factory stays importable from the chart
// module (its test imports `makeCashflowTooltip` from here).
export { makeCashflowTooltip };

interface InnerProps {
  rows: CashflowMonthlyPoint[];
  markers: CashflowChartMarker[];
  depletionYear: number | null;
  members: TooltipMember[];
  granularity: 'monthly' | 'yearly';
  expenseMode: 'total' | 'category';
  categoryMeta: ReadonlyArray<CategoryMeta>;
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  markers,
  depletionYear,
  members,
  granularity,
  expenseMode,
  categoryMeta,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  // In category mode, flatten each datum's `byCategory` map to top-level
  // `cat-${id}` keys (mirrors `ExpensesCategoryChartInner.flattenRows`)
  // so the SVG engine's flat-key dataKey binding reads them. Total
  // mode is the untouched essential/discretionary pass.
  const categoryActive = expenseMode === 'category' && categoryMeta.length > 0;
  const data: ChartDatum[] = React.useMemo(
    () =>
      rows.map((r) => {
        // `byCategory` is a nested map, incompatible with the flat
        // `ChartDatum` (Record<string, number | null>); drop it and, in
        // category mode, project it onto top-level `cat-${id}` keys.
        const { byCategory, ...flat } = r;
        const datum: ChartDatum = { ...flat, x: r.fractionalYear };
        if (categoryActive) {
          for (const c of categoryMeta) {
            datum[`cat-${c.id}`] = byCategory?.[c.id] ?? 0;
          }
        }
        return datum;
      }),
    [rows, categoryActive, categoryMeta],
  );
  // The expense stack: in category mode one `stackId:'expenses'` area per
  // category (replacing essential/discretionary); Taxes stays stacked
  // on top. In total mode the prior essential/discretionary pair.
  const expenseSeries: SeriesSpec[] = categoryActive
    ? categoryMeta.map((c) => ({
        kind: 'area',
        dataKey: `cat-${c.id}`,
        name: c.name,
        color: c.color,
        stackId: 'expenses',
        fillOpacity: 0.55,
      }))
    : [
        { kind: 'area', dataKey: 'essential', name: 'Essential', color: colors.essential, stackId: 'expenses', fillOpacity: 0.6 },
        { kind: 'area', dataKey: 'discretionary', name: 'Discretionary', color: colors.discretionary, stackId: 'expenses', fillOpacity: 0.4 },
      ];
  const seriesSpecs: SeriesSpec[] = [
    ...expenseSeries,
    { kind: 'area', dataKey: 'taxes', name: 'Taxes', color: colors.federalTax, stackId: 'expenses', fillOpacity: 0.5 },
    { kind: 'area', dataKey: 'shortfallBase', name: 'shortfall-base', color: 'none', stroke: 'none', fillOpacity: 0, stackId: 'shortfall', hideFromLegend: true, legendId: 'Shortfall' },
    { kind: 'area', dataKey: 'shortfallHeight', name: 'Shortfall', color: colors.shortfall, stroke: colors.shortfall, fillOpacity: 0.45, stackId: 'shortfall' },
    { kind: 'line', dataKey: 'totalIncome', name: 'Total income', color: colors.cashflowIncome, strokeWidth: 3 },
  ];
  const xs = rows.map((r) => r.fractionalYear);
  const xMin = Math.floor(xs[0]);
  // Death markers (`kind: 'death'`) arrive as the integer `deathYear`.
  // Death is Dec 31 of that year, so map each to the terminal data
  // point of its death year in the active granularity so it hugs the data:
  // monthly → the December sample (`deathYear + 11/12`); yearly →
  // the integer `deathYear`. Retirement markers (a true fractional date)
  // are rendered as-is. Applied to BOTH the rendered reference line AND
  // the `xMax` derivation so December data isn't clipped by a raw integer.
  const mappedMarkers = markers.map((m) =>
    m.kind === 'death' && granularity === 'monthly'
      ? { ...m, fractionalYear: Math.floor(m.fractionalYear) + 11 / 12 }
      : m,
  );
  const lastDeathFractional = mappedMarkers.length
    ? Math.max(...mappedMarkers.map((m) => m.fractionalYear))
    : null;
  const xMax = lastDeathFractional ?? xs[xs.length - 1];
  const allMarkers = assignMarkerLabelSlots([
    ...mappedMarkers.map((m) => ({
      fractionalYear: m.fractionalYear,
      label: m.label,
      color: m.color,
    })),
    ...(depletionYear !== null
      ? [
          {
            fractionalYear: depletionYear,
            label: `Portfolio depleted ${depletionYear}`,
            color: colors.shortfall,
          },
        ]
      : []),
  ]);
  const markerSpecs: MarkerSpec[] = allMarkers.map((m) => ({
    x: m.fractionalYear,
    label: m.label,
    color: m.color,
    slot: m.slot,
    clipToDomain: xDomain != null,
  }));
  const activeDomain = xDomain ?? [xMin, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const tooltip = React.useMemo(
    () =>
      makeCashflowTooltip(members, granularity, colors, chrome, hidden, {
        expenseMode,
        categoryMeta,
      }),
    [members, granularity, colors, chrome, hidden, expenseMode, categoryMeta],
  );
  // The legend should not list the invisible shortfall-base helper.
  const legendSeries = seriesSpecs.filter((s) => !s.hideFromLegend);
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Cashflow projection chart"
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
      <ChartLegend series={legendSeries} hiddenSeries={hidden} onToggle={toggle} />
    </div>
  );
};

export default InnerChart;
