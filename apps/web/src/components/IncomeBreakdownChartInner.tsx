/**
 * Inner SVG-engine chart for the income breakdown band: six stacked sources and Total income, with no expense overlay
 * or Shortfall row.
 */
import React from 'react';
import type {
  IncomeBreakdownMarker,
  IncomeBreakdownPoint,
} from './IncomeBreakdownChart';
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
  rows: IncomeBreakdownPoint[];
  markers: IncomeBreakdownMarker[];
  depletionYear: number | null;
  members: TooltipMember[];
  granularity: 'monthly' | 'yearly';
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

interface TooltipRow {
  label: string;
  value: number;
  color: string;
}

export function makeIncomeTooltip(
  members: TooltipMember[],
  granularity: 'monthly' | 'yearly' = 'monthly',
  colors: ChartColors,
  chrome: ChartChrome,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as IncomeBreakdownPoint;
    const rows: TooltipRow[] = [
      { label: 'Social Security', value: p.ss, color: colors.incomeSs },
      { label: 'Pension annuity', value: p.pensionAnnuity, color: colors.incomePension },
      { label: 'Part-time / earned', value: p.partTime, color: colors.incomePartTime },
      { label: 'One-off (spendable)', value: p.oneOff, color: colors.incomeOneOff },
      { label: 'Portfolio additions', value: p.portfolioAdd, color: colors.portfolioAdd },
      { label: 'Portfolio withdrawal', value: p.withdrawal, color: colors.incomeWithdrawal },
    ].filter((r) => !hidden.has(r.label));
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
          {granularity === 'yearly'
            ? p.year
            : `${SHORT_MONTHS[p.month0]} ${p.year}`}
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
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
            <span style={{ color: r.color }}>{r.label}</span>
            <span>{formatCurrency(r.value)}</span>
          </div>
        ))}
        <div
          className="mt-1 flex justify-between gap-4 pt-1"
          // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
          style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
        >
          <span>Total income</span>
          <span>{formatCurrency(p.total)}</span>
        </div>
      </div>
    );
  };
}

function fiveYearTicks(min: number, max: number): number[] {
  const start = Math.ceil(min / 5) * 5;
  const ticks: number[] = [];
  for (let y = start; y <= max; y += 5) ticks.push(y);
  return ticks;
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  markers,
  depletionYear,
  members,
  granularity,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const seriesSpecs: SeriesSpec[] = [
    { kind: 'area', dataKey: 'ss', name: 'Social Security', color: colors.incomeSs, stackId: 'income', fillOpacity: 0.6 },
    { kind: 'area', dataKey: 'pensionAnnuity', name: 'Pension annuity', color: colors.incomePension, stackId: 'income', fillOpacity: 0.55 },
    { kind: 'area', dataKey: 'partTime', name: 'Part-time / earned', color: colors.incomePartTime, stackId: 'income', fillOpacity: 0.55 },
    { kind: 'area', dataKey: 'oneOff', name: 'One-off (spendable)', color: colors.incomeOneOff, stackId: 'income', fillOpacity: 0.55 },
    { kind: 'area', dataKey: 'portfolioAdd', name: 'Portfolio additions', color: colors.portfolioAdd, stackId: 'income', fillOpacity: 0.55 },
    { kind: 'area', dataKey: 'withdrawal', name: 'Portfolio withdrawal', color: colors.incomeWithdrawal, stackId: 'income', fillOpacity: 0.45 },
  ];
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.fractionalYear })),
    [rows],
  );
  const xs = rows.map((r) => r.fractionalYear);
  const xMin = Math.floor(xs[0]);
  // Death markers arrive as the integer `deathYear` and map to the terminal data point (monthly:
  // December sample; yearly: integer). Applied to the reference line and `xMax` so December data is
  // not clipped.
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
  const ticks = fiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const tooltip = React.useMemo(
    () => makeIncomeTooltip(members, granularity, colors, chrome, hidden),
    [members, granularity, colors, chrome, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Income breakdown chart"
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
