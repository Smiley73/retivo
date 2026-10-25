/**
 * Inner SVG-engine chart for the cashflow band: stacked Essential / Discretionary / Taxes areas, a shortfall ribbon
 * lifted by an invisible `shortfallBase`, and a Total income line.
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
  // In category mode each datum's `byCategory` map is flattened to top-level `cat-${id}` keys for
  // the engine's flat dataKey binding.
  const categoryActive = expenseMode === 'category' && categoryMeta.length > 0;
  const data: ChartDatum[] = React.useMemo(
    () =>
      rows.map((r) => {
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
  // Death markers arrive as the integer `deathYear` and map to the terminal data point in the
  // active granularity (monthly: December sample); applied to the reference line and `xMax`.
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
