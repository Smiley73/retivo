/**
 * Inner SVG-engine chart for the Account Balance Stack chart.
 *
 * Stacked-area chart visualizing projected account balances over time.
 * The section wrapper (`balance-projection-page-account-balance-stack`)
 * computes the grouping (per-tier, per-AccountType fallback, or per-account)
 * and passes a flat `series` + `rows` pair. This component only renders.
 *
 * Series layering (bottom to top): the caller orders series meaningful for
 * the active grouping. Excluded accounts — shown only when the "Show
 * excluded accounts" toggle is on — are passed as the last series so they
 * render on top in a muted color.
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

/** One rendered series layer in the stack. */
export interface AccountBalanceStackSeries {
  /** Data key — must match a key in each `AccountBalanceStackRow`. */
  readonly dataKey: string;
  /** Legend + tooltip label. */
  readonly name: string;
  /** Hex fill / stroke color (from `CHART_COLORS` via the section wrapper). */
  readonly color: string;
  /** Optional per-x-range style zones (projected region + carried-forward
   *  spans). When present, the series renders one `<path>` per zone carrying a
   *  `data-zone` attribute; absent → a single full-span path as before. */
  readonly zones?: ReadonlyArray<SeriesZone>;
}

/** Dashed vertical boundary between the historical (actual) region and the
 *  projected region, drawn at the last actual year. */
export interface AccountBalanceStackBoundary {
  readonly year: number;
  readonly label: string;
  readonly color: string;
}

/** One year's worth of per-series account balance data. */
export type AccountBalanceStackRow = {
  readonly year: number;
  readonly [dataKey: string]: number;
};

interface InnerProps {
  rows: AccountBalanceStackRow[];
  series: AccountBalanceStackSeries[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  /** Dashed actual→projected boundary marker (last actual year). Absent on the
   *  historical-only accounts-page surface. */
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
        // Gate by dataKey to match the per-account `legendId` (names dup).
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
    // Account names aren't unique (two "Checking" accounts), so toggle by
    // the unique dataKey — otherwise same-named accounts hide together.
    legendId: s.dataKey,
    zones: s.zones,
  }));
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const activeDomain = xDomain ?? [xMin, xMax];
  const ticks = fiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  // The boundary marker joins the retirement/death markers in the shared
  // label-slot assignment so its label never overlaps theirs.
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
