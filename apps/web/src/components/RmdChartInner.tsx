/**
 * Inner SVG-engine impl for the Required Minimum Distribution chart.
 * Uses the in-house SVG chart engine.
 *
 * Stacked bars per RMD year:
 *  - Bottom: RMD met (`rmdFloor − rmdShortfall`), neutral teal.
 *  - Top: RMD shortfall (`rmdShortfall`), red cost accent — the portion
 *    the projection could not fund.
 *
 * When any year retains surplus (`rmdRetained > 0`, "split mode"), the met
 * band itself splits into two segments — "Used for spending and taxes"
 * (teal) at the bottom and "Surplus (kept)" (green) above it — with the
 * red shortfall still on top. The retained segment is clamped to the met
 * figure (`retainedDisplay = min(max(0, rmdRetained), rmdMet)`,
 * `spentDisplay = rmdMet − retainedDisplay`) so the bar height stays
 * = the year's `rmdFloor` even on source/rounding drift.
 *
 * Total bar height = the year's `rmdFloor`.
 */
import React from 'react';
import type { RmdChartRow } from './RmdChart';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { adaptiveYearTicks, assignMarkerLabelSlots } from '../lib/chart-markers';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

interface InnerProps {
  rows: RmdChartRow[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

/** Clamp the retained surplus to the met figure so it can never inflate the
 *  bar past the required minimum. `spentDisplay = rmdMet − retainedDisplay`
 *  so spent + retained + shortfall === required. */
function splitDisplay(row: RmdChartRow): {
  retainedDisplay: number;
  spentDisplay: number;
} {
  const retainedDisplay = Math.min(Math.max(0, row.rmdRetained), row.rmdMet);
  return { retainedDisplay, spentDisplay: row.rmdMet - retainedDisplay };
}

function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  members: ReadonlyArray<TooltipMember>,
  split: boolean,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as RmdChartRow;
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
    const met = p.rmdMet;
    const shortfall = p.rmdShortfall;
    const required = met + shortfall;
    const { retainedDisplay, spentDisplay } = splitDisplay(p);
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
        <Row label="RMD required" value={required} />
        {split ? (
          <>
            {!hidden.has('Used for spending and taxes') && (
              <Row
                label="Used for spending and taxes"
                value={spentDisplay}
                color={colors.rmdMet}
              />
            )}
            {!hidden.has('Surplus (kept)') && (
              <Row
                label="Surplus (kept)"
                value={retainedDisplay}
                color={colors.rmdRetained}
              />
            )}
          </>
        ) : (
          !hidden.has('RMD met') && (
            <Row label="RMD met" value={met} color={colors.rmdMet} />
          )
        )}
        {shortfall > 0 && !hidden.has('Shortfall') && (
          <Row label="Shortfall" value={shortfall} color={colors.rmdShortfall} />
        )}
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  members,
  markers,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  // Split mode: when any year retains surplus, the met band splits into
  // used-for-spending (teal) + surplus-kept (green). Same gate as the
  // "Total RMD surplus" tile.
  const split = React.useMemo(() => rows.some((r) => r.rmdRetained > 0), [rows]);
  // Bars map by `x` = their integer `year` (mirrors the Tax Burden chart's
  // integer death-year convention — every bar is a full-value bar at its
  // calendar year). In split mode each datum also carries the clamped
  // spent/retained display heights the stacked series read.
  const data: ChartDatum[] = React.useMemo(
    () =>
      rows.map((r) => {
        const { retainedDisplay, spentDisplay } = splitDisplay(r);
        return { ...r, x: r.year, spentDisplay, retainedDisplay };
      }),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  const lastDeathFractional = markers?.length
    ? Math.max(...markers.map((m) => m.fractionalYear))
    : null;
  // Inset the first/last bars from the plot edges (bars are centered on
  // their x). ~0.6yr is wider than a half bar at any zoom; mirrors the
  // Tax Burden chart.
  const BAR_EDGE_PAD = 0.6;
  const xMinPadded = Math.floor(xMin) - BAR_EDGE_PAD;
  const xMax = Math.max(
    xs[xs.length - 1] + BAR_EDGE_PAD,
    lastDeathFractional ?? -Infinity,
  );
  const activeDomain: [number, number] = xDomain
    ? [xDomain[0] - BAR_EDGE_PAD, xDomain[1] + BAR_EDGE_PAD]
    : [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const seriesSpecs: SeriesSpec[] = split
    ? [
        { kind: 'bar', dataKey: 'spentDisplay', name: 'Used for spending and taxes', color: colors.rmdMet, stackId: 'rmd' },
        { kind: 'bar', dataKey: 'retainedDisplay', name: 'Surplus (kept)', color: colors.rmdRetained, stackId: 'rmd' },
        { kind: 'bar', dataKey: 'rmdShortfall', name: 'Shortfall', color: colors.rmdShortfall, stackId: 'rmd' },
      ]
    : [
        { kind: 'bar', dataKey: 'rmdMet', name: 'RMD met', color: colors.rmdMet, stackId: 'rmd' },
        { kind: 'bar', dataKey: 'rmdShortfall', name: 'Shortfall', color: colors.rmdShortfall, stackId: 'rmd' },
      ];
  const markerSpecs: MarkerSpec[] = assignMarkerLabelSlots(markers ?? []).map(
    (m) => ({
      x: m.fractionalYear,
      label: m.label,
      color: m.color,
      slot: m.slot,
      clipToDomain: true,
    }),
  );
  const tooltip = React.useMemo(
    () => makeTooltip(colors, chrome, members ?? [], split, hidden),
    [colors, chrome, members, split, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Required minimum distributions chart"
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
