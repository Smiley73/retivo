/**
 * Inner SVG-engine chart for Roth conversions: one bar per year, rows already deflated to the display basis so bars
 * sum to the "Total Roth converted" tile.
 */
import React from 'react';
import type { RothConversionsChartRow } from './RothConversionsChart';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { adaptiveYearTicks } from '../lib/chart-markers';
import type { TooltipMember } from './tooltip-member';
import { ChartFrame } from './charts';
import type { ChartDatum, SeriesSpec } from './charts';

interface InnerProps {
  rows: ReadonlyArray<RothConversionsChartRow>;
  members?: ReadonlyArray<TooltipMember>;
}

function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  members: ReadonlyArray<TooltipMember>,
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as RothConversionsChartRow;
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
          <span style={{ color: colors.acctRoth }}>Roth converted</span>
          <span>{formatCurrency(p.dollars)}</span>
        </div>
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({ rows, members }) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  // Bars sit on their integer `year`.
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  const xMin = xs[0];
  // Inset the edge bars, which are centred on x.
  const BAR_EDGE_PAD = 0.6;
  const xMinPadded = Math.floor(xMin) - BAR_EDGE_PAD;
  const xMax = xs[xs.length - 1] + BAR_EDGE_PAD;
  const activeDomain: [number, number] = [xMinPadded, xMax];
  const ticks = adaptiveYearTicks(activeDomain[0], Math.ceil(activeDomain[1]));
  const seriesSpecs: SeriesSpec[] = [
    {
      kind: 'bar',
      dataKey: 'dollars',
      name: 'Roth converted',
      color: colors.acctRoth,
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
        ariaLabel="Roth conversions chart"
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
