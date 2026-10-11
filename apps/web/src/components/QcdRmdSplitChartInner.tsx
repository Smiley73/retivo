/**
 * Inner SVG-engine impl for the QCD → net-taxable IRA RMD split chart.
 * Uses the in-house SVG chart engine.
 *
 * One stacked bar per gift year that carries a gross IRA RMD = that year's
 * gross traditional-IRA required minimum, split into two segments:
 *  - Bottom: covered by the QCD (tax-free), amber `qcdOffset`
 *    token — deliberately NOT the gift chart's `qcd` pink, so the adjacent
 *    Charitable-distributions chart (full gift, gift basis) never reads as
 *    the same series as this capped, RMD-basis offset slice.
 *  - Top: net taxable, teal `rmdMet` token.
 *
 * Total bar height = the year's gross IRA-pool RMD (offset + net). The offset
 * slice is `min(gift, gross)` per owner, so an excess gift never overshoots
 * the bar — the gift beyond the RMD shows on the standalone QCD chart,
 * not here. Rows arrive already deflated to the page's display-dollars basis
 * (both slices on the RMD's year-end `basisDeflator`), so bar heights are
 * read verbatim with no re-deflation and each column-sum ties to its tile.
 * Mirrors `RmdChartInner` (the stacked-bar exemplar). NO recharts import.
 */
import React from 'react';
import type { QcdRmdSplitRow } from './QcdRmdSplitChart';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { adaptiveYearTicks } from '../lib/chart-markers';
import type { TooltipMember } from './tooltip-member';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, SeriesSpec } from './charts';

interface InnerProps {
  rows: ReadonlyArray<QcdRmdSplitRow>;
  members?: ReadonlyArray<TooltipMember>;
}

/** Series labels shared by the bars, legend, and tooltip. */
const OFFSET_NAME = 'Covered by QCD (tax-free)';
const NET_NAME = 'Net taxable';

function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  members: ReadonlyArray<TooltipMember>,
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as QcdRmdSplitRow;
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
    const offset = p.rmdOffsetDollars;
    const net = p.netTaxableDollars;
    const gross = offset + net;
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
        <Row label="Gross IRA RMD" value={gross} />
        {!hidden.has(OFFSET_NAME) && (
          <Row label={OFFSET_NAME} value={offset} color={colors.qcdOffset} />
        )}
        {!hidden.has(NET_NAME) && (
          <Row label={NET_NAME} value={net} color={colors.rmdMet} />
        )}
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({ rows, members }) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  // Bars map by `x` = their integer `year` (mirrors the RMD chart — every bar
  // is a full-value bar at its calendar year).
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  // Empty rows: the caller gates the chart out in practice, but guard a bare
  // empty series so the domain math never produces NaN bounds.
  const xMin = xs.length > 0 ? xs[0] : 0;
  const xLast = xs.length > 0 ? xs[xs.length - 1] : 0;
  // Inset the first/last bars from the plot edges (bars are centered on their
  // x). ~0.6yr is wider than a half bar at any zoom; mirrors the RMD chart.
  const BAR_EDGE_PAD = 0.6;
  const xMinPadded = Math.floor(xMin) - BAR_EDGE_PAD;
  const xMax = xLast + BAR_EDGE_PAD;
  const activeDomain: [number, number] = [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const seriesSpecs: SeriesSpec[] = [
    {
      kind: 'bar',
      dataKey: 'rmdOffsetDollars',
      name: OFFSET_NAME,
      color: colors.qcdOffset,
      stackId: 'split',
    },
    {
      kind: 'bar',
      dataKey: 'netTaxableDollars',
      name: NET_NAME,
      color: colors.rmdMet,
      stackId: 'split',
    },
  ];
  const tooltip = React.useMemo(
    () => makeTooltip(colors, chrome, members ?? [], hidden),
    [colors, chrome, members, hidden],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        height={320}
        ariaLabel="IRA required-withdrawal split chart"
        xDomain={activeDomain}
        yDomain={null}
        xTicks={ticks}
        xTickFormatter={(v) => String(Math.round(v))}
        yTickFormatter={formatCurrencyShort}
        hiddenSeries={hidden}
        renderTooltip={tooltip}
      />
      <ChartLegend series={seriesSpecs} hiddenSeries={hidden} onToggle={toggle} />
    </div>
  );
};

export default InnerChart;
