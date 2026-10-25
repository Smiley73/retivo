/**
 * Inner SVG-engine stacked-area chart of projected account balances; the caller orders `series` (excluded accounts
 * last, muted on top) and groups them.
 */
import React from 'react';
import type { ChartChrome } from '../lib/tokens';
import { useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { assignMarkerLabelSlots } from '../lib/chart-markers';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec, SeriesZone } from './charts';

export interface AccountBalanceStackSeries {
  readonly dataKey: string;
  readonly name: string;
  readonly color: string;
  /**
   * Style zones for the projected region and carried-forward spans; each renders its own `<path>`
   * with `data-zone`.
   */
  readonly zones?: ReadonlyArray<SeriesZone>;
}

/** Dashed vertical boundary between the actual and projected regions, at the last actual year. */
export interface AccountBalanceStackBoundary {
  readonly year: number;
  readonly label: string;
  readonly color: string;
}

export type AccountBalanceStackRow = {
  readonly year: number;
  readonly [dataKey: string]: number;
};

interface InnerProps {
  rows: AccountBalanceStackRow[];
  series: AccountBalanceStackSeries[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  boundary?: AccountBalanceStackBoundary | null;
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

function TooltipBody({
  datum,
  series,
  chrome,
  members,
  hidden,
}: {
  datum: ChartDatum;
  series: AccountBalanceStackSeries[];
  chrome: ChartChrome;
  members: ReadonlyArray<TooltipMember>;
  hidden: ReadonlySet<string>;
}): React.ReactElement {
  const total = series.reduce((sum, s) => sum + (datum[s.dataKey] ?? 0), 0);
  const year = datum.year ?? 0;
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
      <div className="mb-1 text-muted">{year}</div>
      {members.length > 0 && (
        <div className="mb-1 text-xs text-muted">
          {members.map((m, i) => (
            <span key={m.firstName + ':' + m.birthYear}>
              {i > 0 ? ' · ' : ''}
              {m.firstName} (age {year - m.birthYear})
            </span>
          ))}
        </div>
      )}
      {series.map((s) => {
        const val = datum[s.dataKey] ?? 0;
        // Gate by dataKey to match the per-account `legendId`, since names are not unique.
        if (val === 0 || hidden.has(s.dataKey)) return null;
        return (
          <div key={s.dataKey} className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
            <span style={{ color: s.color }}>{s.name}</span>
            <span>{formatCurrency(val)}</span>
          </div>
        );
      })}
      <div
        className="mt-1 flex justify-between gap-4 pt-1"
        // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
        style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
      >
        <span>Total</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

const InnerChart: React.FC<InnerProps> = ({
  rows,
  series,
  members,
  markers,
  boundary,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const seriesSpecs: SeriesSpec[] = series.map((s) => ({
    kind: 'area',
    dataKey: s.dataKey,
    name: s.name,
    color: s.color,
    stackId: 'balances',
    fillOpacity: 0.55,
    // Account names are not unique, so toggle by the unique dataKey or same-named accounts hide
    // together.
    legendId: s.dataKey,
    zones: s.zones,
  }));
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const activeDomain = xDomain ?? [xMin, xMax];
  const ticks = fiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const allMarkers = boundary
    ? [
        ...(markers ?? []),
        {
          fractionalYear: boundary.year,
          label: boundary.label,
          color: boundary.color,
        },
      ]
    : (markers ?? []);
  const markerSpecs: MarkerSpec[] = assignMarkerLabelSlots(allMarkers).map(
    (m) => ({
      x: m.fractionalYear,
      label: m.label,
      color: m.color,
      slot: m.slot,
      clipToDomain: true,
    }),
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Account balance stack chart"
        xDomain={xDomain ?? null}
        yDomain={yDomain ?? null}
        xTicks={ticks}
        yTickFormatter={formatCurrencyShort}
        dragSelection={dragSelection ?? null}
        isDragging={isDragging}
        pointerHandlers={mouseHandlers}
        hiddenSeries={hidden}
        renderTooltip={(datum) => (
          <TooltipBody
            datum={datum}
            series={series}
            chrome={chrome}
            members={members ?? []}
            hidden={hidden}
          />
        )}
      />
      <ChartLegend series={seriesSpecs} hiddenSeries={hidden} onToggle={toggle} />
    </div>
  );
};

export default InnerChart;
