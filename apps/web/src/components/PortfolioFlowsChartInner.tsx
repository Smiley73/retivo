/**
 * Inner SVG-engine chart for portfolio flows: inflows stacked above zero, withdrawals below, and a sign-split
 * net-change line (`signSplit`, so it survives PDF export).
 */
import React from 'react';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { PortfolioFlowsChartRow } from './PortfolioFlowsChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { adaptiveYearTicks, assignMarkerLabelSlots } from '../lib/chart-markers';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

interface InnerProps {
  rows: PortfolioFlowsChartRow[];
  markers: CashflowChartMarker[];
  depletionYear: number | null;
  members: TooltipMember[];
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

function makeTooltip(
  members: TooltipMember[],
  colors: ChartColors,
  chrome: ChartChrome,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as PortfolioFlowsChartRow;
    const withdrawalsAbs = -p.withdrawals;
    const qcdAbs = -p.qcd;
    const Row: React.FC<{ label: string; value: number; color?: string }> = ({
      label,
      value,
      color,
    }) => (
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
        <div className="mb-1 text-muted">{p.year}</div>
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
        {p.contributions > 0 && !hidden.has('Contributions') && (
          <Row label="Contributions" value={p.contributions} color={colors.incomePartTime} />
        )}
        {p.gains !== 0 && !hidden.has('Investment gains') && (
          <Row label="Investment gains" value={p.gains} color={colors.twr} />
        )}
        {p.deposits > 0 && !hidden.has('Income deposits') && (
          <Row label="Income deposits" value={p.deposits} color={colors.incomeOneOff} />
        )}
        {withdrawalsAbs > 0 && !hidden.has('Withdrawals') && (
          <Row label="Withdrawals" value={-withdrawalsAbs} color={colors.incomeWithdrawal} />
        )}
        {qcdAbs > 0 && !hidden.has('Charitable (QCD)') && (
          <Row label="Charitable (QCD)" value={-qcdAbs} color={colors.qcd} />
        )}
        {/* Net change is the summary total of the visible flows, so it stays when its line is
            hidden. */}
        <div
          className="mt-1 flex justify-between gap-4 pt-1"
          // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
          style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
        >
          <span>Net change</span>
          <span
            // eslint-disable-next-line no-restricted-syntax -- runtime net-change sign color (positive/negative/zero) from the theme-reactive tokens.ts map
            style={{
              color:
                p.netChange < 0
                  ? colors.netChangeNegative
                  : p.netChange > 0
                    ? colors.netChangePositive
                    : undefined,
            }}
          >
            {formatCurrency(p.netChange)}
          </span>
        </div>
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  markers,
  depletionYear,
  members,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  // Bars sit on their integer `year`; death is Dec 31 of the terminal year, so there is no prorated
  // terminal bar.
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.fractionalYear ?? r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  // The rightmost marker lands on the last bar and drives `xMax` so it is not clipped.
  const lastDeathFractional = markers.length
    ? Math.max(...markers.map((m) => m.fractionalYear))
    : null;
  // Bars are centred on x, so inset the edges or the first bar lands on the Y-axis; the right edge
  // still reaches a later death marker.
  const BAR_EDGE_PAD = 0.6;
  const xMinPadded = Math.floor(xMin) - BAR_EDGE_PAD;
  const xMax = Math.max(
    xs[xs.length - 1] + BAR_EDGE_PAD,
    lastDeathFractional ?? -Infinity,
  );
  const allMarkers = assignMarkerLabelSlots([
    ...markers.map((m) => ({
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
  const seriesSpecs: SeriesSpec[] = [
    { kind: 'bar', dataKey: 'contributions', name: 'Contributions', color: colors.incomePartTime, stackId: 'flows' },
    { kind: 'bar', dataKey: 'gains', name: 'Investment gains', color: colors.twr, stackId: 'flows' },
    { kind: 'bar', dataKey: 'deposits', name: 'Income deposits', color: colors.incomeOneOff, stackId: 'flows' },
    { kind: 'bar', dataKey: 'withdrawals', name: 'Withdrawals', color: colors.incomeWithdrawal, stackId: 'flows' },
    { kind: 'bar', dataKey: 'qcd', name: 'Charitable (QCD)', color: colors.qcd, stackId: 'flows' },
    { kind: 'line', dataKey: 'netChange', name: 'Net change', color: colors.netChangePositive, signSplit: { positiveColor: colors.netChangePositive, negativeColor: colors.netChangeNegative }, strokeWidth: 3 },
  ];
  const activeDomain: [number, number] = xDomain
    ? [xDomain[0] - BAR_EDGE_PAD, xDomain[1] + BAR_EDGE_PAD]
    : [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const tooltip = React.useMemo(
    () => makeTooltip(members, colors, chrome, hidden),
    [members, colors, chrome, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Portfolio flows chart"
        xDomain={activeDomain}
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
