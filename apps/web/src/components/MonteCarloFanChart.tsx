/**
 * Monte Carlo fan chart: translucent P10→P25 and P25→P50 bands over an invisible p10 baseline, a median line, and a
 * Planned-method overlay.
 */
import React from 'react';
import type { MonteCarloSummary } from '../lib/monte-carlo';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { assignMarkerLabelSlots } from '../lib/chart-markers';
import type { ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

interface LifeMarker {
  fractionalYear: number;
  label: string;
  color: string;
}

interface Props {
  result: MonteCarloSummary;
  real: boolean;
  retirementYear: number | null;
  retirementLabel?: string | null;
  lifeMarkers?: LifeMarker[];
  yScale?: 'linear' | 'log';
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

interface Row extends ChartDatum {
  year: number;
  x: number;
  p10: number;
  p25: number;
  p50: number;
  band_p10_to_p25: number;
  band_p25_to_p50: number;
}

function makeTooltipContent(
  chrome: ChartChrome,
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const row = datum as Row;
    const rowsToShow: Array<{ label: string; value: number; bold?: boolean }> = [
      { label: 'Typical', value: row.p50, bold: true },
      { label: 'Pessimistic', value: row.p25 },
      { label: 'Bad-luck', value: row.p10 },
    ];
    return (
      <div
        className="px-3 py-2 text-sm"
        // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip chrome from tokens.ts (useTheme); flips on dark toggle
        style={{
          background: chrome.tooltipBg,
          color: chrome.tooltipText,
          border: `1px solid ${chrome.tooltipBorder}`,
        }}
      >
        <div className="mb-1 text-muted">
          Year {row.year}
        </div>
        {rowsToShow.map((r) => (
          <div
            key={r.label}
            className={`flex justify-between gap-4 ${r.bold ? 'font-semibold' : ''}`}
          >
            <span>{r.label}</span>
            <span>{formatCurrency(r.value)}</span>
          </div>
        ))}
      </div>
    );
  };
}

export function MonteCarloFanChart({
  result,
  real,
  retirementYear,
  retirementLabel,
  lifeMarkers,
  yScale = 'linear',
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}: Props) {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const pcts = real ? result.percentilesReal : result.percentilesNominal;
  const rows: Row[] = pcts.p50.map((_, i) => {
    const year = result.firstYear + i;
    const p10 = pcts.p10[i];
    const p25 = pcts.p25[i];
    const p50 = pcts.p50[i];
    return {
      year,
      x: year + 1,
      p10,
      p25,
      p50,
      band_p10_to_p25: p25 - p10,
      band_p25_to_p50: p50 - p25,
    };
  });
  const xDomainMin = rows[0]?.x ?? result.firstYear + 1;
  const xDataMax = rows[rows.length - 1]?.x ?? xDomainMin;
  const xDomainMax = Math.max(
    xDataMax,
    Math.ceil(
      Math.max(
        retirementYear ?? -Infinity,
        ...(lifeMarkers ?? []).map((m) => m.fractionalYear),
        -Infinity,
      ),
    ),
  );
  const activeDomain = xDomain ?? [xDomainMin, xDomainMax];
  const xTickLo = Math.ceil(activeDomain[0]);
  const xTickHi = Math.ceil(activeDomain[1]);
  const xTicks: number[] = [];
  for (let t = xTickLo; t <= xTickHi; t += 1) {
    xTicks.push(t);
  }
  const seriesSpecs: SeriesSpec[] = [
    { kind: 'area', dataKey: 'p10', name: 'p10-base', color: 'none', stroke: 'none', fillOpacity: 0, stackId: 'bands', hideFromLegend: true },
    { kind: 'area', dataKey: 'band_p10_to_p25', name: 'Bad to pessimistic', color: colors.mcBandOuter, stroke: 'none', fillOpacity: 1, stackId: 'bands', hideFromLegend: true },
    { kind: 'area', dataKey: 'band_p25_to_p50', name: 'Pessimistic to typical', color: colors.mcBandInner, stroke: 'none', fillOpacity: 1, stackId: 'bands', hideFromLegend: true },
    { kind: 'line', dataKey: 'p50', name: 'Typical', color: colors.mcMedian, strokeWidth: 2.5 },
  ];
  const slotted = assignMarkerLabelSlots([
    ...(retirementYear != null
      ? [
          {
            fractionalYear: retirementYear,
            label: retirementLabel ?? 'Retire',
            color: colors.retirementMarker,
          },
        ]
      : []),
    ...(lifeMarkers ?? []),
  ]);
  const markerSpecs: MarkerSpec[] = slotted.map((m) => ({
    x: m.fractionalYear,
    label: m.label,
    color: m.color,
    slot: m.slot,
    clipToDomain: xDomain != null,
  }));
  const tooltip = React.useMemo(() => makeTooltipContent(chrome), [chrome]);
  return (
    <ChartFrame
      rows={rows}
      series={seriesSpecs}
      markers={markerSpecs}
      height={320}
      ariaLabel="Plan stress-test fan chart showing the range of projected portfolio value over time"
      xDomain={xDomain ?? [xDomainMin, xDomainMax]}
      yDomain={yDomain ?? null}
      yScale={yScale}
      xTicks={xTicks}
      xTickFormatter={(v) => String(Math.round(v))}
      yTickFormatter={formatCurrencyShort}
      dragSelection={dragSelection ?? null}
      isDragging={isDragging}
      pointerHandlers={mouseHandlers}
      renderTooltip={tooltip}
    />
  );
}
