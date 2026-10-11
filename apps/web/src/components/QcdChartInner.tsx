/**
 * Inner SVG-engine impl for the charitable-distributions (QCD) chart.
 * Uses the in-house SVG chart engine.
 *
 * One bar per year — the amount given directly from a traditional IRA to
 * charity that year (`useChartColors().qcd`, pink, distinct from the RMD
 * band's teal/red/green). The rows arrive already deflated to the page's
 * display-dollars basis, so bar heights are read verbatim with no
 * re-deflation, keeping the bars summing to the adjacent "QCD distributed"
 * tile. Mirrors `RothConversionsChartInner`.
 */
import React from 'react';
import type { QcdChartRow } from './QcdChart';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { adaptiveYearTicks } from '../lib/chart-markers';
import type { TooltipMember } from './tooltip-member';
import { ChartFrame } from './charts';
import type { ChartDatum, SeriesSpec } from './charts';

interface InnerProps {
  rows: ReadonlyArray<QcdChartRow>;
  members?: ReadonlyArray<TooltipMember>;
}

/** Single-series legend/series label shared by the bars + tooltip. */
const SERIES_NAME = 'Charitable distribution (QCD)';

function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  members: ReadonlyArray<TooltipMember>,
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as QcdChartRow;
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
        <div className="flex justify-between gap-4">
          {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
          <span style={{ color: colors.qcd }}>{SERIES_NAME}</span>
          <span>{formatCurrency(p.dollars)}</span>
        </div>
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({ rows, members }) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  // Bars map by `x` = their integer `year` (mirrors the RMD chart — every
  // bar is a full-value bar at its calendar year).
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  // Empty rows: the caller gates the chart out in practice, but guard a bare
  // empty series so the domain math never produces NaN bounds.
  const xMin = xs.length > 0 ? xs[0] : 0;
  const xLast = xs.length > 0 ? xs[xs.length - 1] : 0;
  // Inset the first/last bars from the plot edges (bars are centered on
  // their x). ~0.6yr is wider than a half bar at any zoom; mirrors the
  // RMD chart.
  const BAR_EDGE_PAD = 0.6;
  const xMinPadded = Math.floor(xMin) - BAR_EDGE_PAD;
  const xMax = xLast + BAR_EDGE_PAD;
  const activeDomain: [number, number] = [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const seriesSpecs: SeriesSpec[] = [
    {
      kind: 'bar',
      dataKey: 'dollars',
      name: SERIES_NAME,
      color: colors.qcd,
    },
  ];
  const tooltip = React.useMemo(
    () => makeTooltip(colors, chrome, members ?? []),
    [colors, chrome, members],
  );
  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        height={320}
        ariaLabel="Charitable distributions chart"
        xDomain={activeDomain}
        yDomain={null}
        xTicks={ticks}
        xTickFormatter={(v) => String(Math.round(v))}
        yTickFormatter={formatCurrencyShort}
        renderTooltip={tooltip}
      />
    </div>
  );
};

export default InnerChart;
