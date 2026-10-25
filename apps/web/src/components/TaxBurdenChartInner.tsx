/**
 * Inner SVG-engine chart for the Tax & Health-Cost Burden chart: federal tax and IRMAA above zero, the ACA-PTC
 * subsidy below.
 */
import React from 'react';
import type { TaxBurdenChartRow } from './TaxBurdenChart';
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
  rows: TaxBurdenChartRow[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  members: ReadonlyArray<TooltipMember>,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as TaxBurdenChartRow;
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
    const federalTax = p.federalTax;
    const irmaa = p.irmaaSurcharge;
    const ptc = p.acaPtcSubsidy;
    const creditApplied = p.acaCreditApplied;
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
        {federalTax > 0 && !hidden.has('Federal income tax') && (
          <Row label="Federal income tax" value={federalTax} color={colors.federalTax} />
        )}
        {irmaa > 0 && !hidden.has('IRMAA surcharge') && (
          <Row label="IRMAA surcharge" value={irmaa} color={colors.irmaa} />
        )}
        {ptc < 0 && !hidden.has('ACA-PTC subsidy') && (
          <Row label="ACA-PTC subsidy" value={-ptc} color={colors.acaPtc} />
        )}
        {creditApplied > 0 && (
          // Part of the ACA-PTC subsidy above, so left out of the net cost.
          <div className="flex justify-between gap-4 text-muted">
            <span>Credit applied to premiums (part of the subsidy above)</span>
            <span>{formatCurrency(creditApplied)}</span>
          </div>
        )}
        {(federalTax > 0 || irmaa > 0 || ptc < 0) && (
          <div
            className="mt-1 flex justify-between gap-4 pt-1"
            // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
            style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
          >
            <span>Net cost</span>
            <span>{formatCurrency(federalTax + irmaa + ptc)}</span>
          </div>
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
  // Bars sit on their integer `year`: death is Dec 31 of the terminal year, so there is no prorated
  // terminal bar.
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.fractionalYear ?? r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  // The rightmost marker lands on the last bar and drives `xMax` so it is not clipped.
  const lastDeathFractional = markers?.length
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
  const activeDomain: [number, number] = xDomain
    ? [xDomain[0] - BAR_EDGE_PAD, xDomain[1] + BAR_EDGE_PAD]
    : [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const seriesSpecs: SeriesSpec[] = [
    { kind: 'bar', dataKey: 'federalTax', name: 'Federal income tax', color: colors.federalTax, stackId: 'burden' },
    { kind: 'bar', dataKey: 'irmaaSurcharge', name: 'IRMAA surcharge', color: colors.irmaa, stackId: 'burden' },
    { kind: 'bar', dataKey: 'acaPtcSubsidy', name: 'ACA-PTC subsidy', color: colors.acaPtc, stackId: 'burden' },
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
    () => makeTooltip(colors, chrome, members ?? [], hidden),
    [colors, chrome, members, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Tax and health-cost burden chart"
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
