/**
 * Inner SVG-engine chart for the QCD / net-taxable RMD split: amber covered slice (deliberately not the gift chart's
 * pink) under a teal taxable slice; the offset caps at `min(gift, gross)`.
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
  // Bars sit on their integer `year`.
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  // The caller gates out empty rows; guard a bare empty series so the domain stays finite.
  const xMin = xs.length > 0 ? xs[0] : 0;
  const xLast = xs.length > 0 ? xs[xs.length - 1] : 0;
  // Inset the edge bars, which are centred on x.
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
