/**
 * Inner SVG-engine charts for the per-account history. Lazily imported
 * by AccountHistoryCharts.
 *
 * Two charts: ending balance by year (line), and return % by year (line
 * with a green→red vertical gradient split at y=0, per-point dots tinted
 * by sign, and a dashed zero reference line).
 */
import React from 'react';
import type { AccountHistoryRow } from './AccountHistoryCharts';
import type { ChartChrome, ChartColors } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { formatPercent } from './PercentInput';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import { ChartFrame } from './charts';
import type { ChartDatum, SeriesSpec } from './charts';

interface InnerProps {
  rows: AccountHistoryRow[];
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const GRADIENT_ID = 'account-return-gradient';

interface ReturnGradientBounds {
  yMin: number;
  yMax: number;
  zeroOffset: number;
}

// Exported for unit tests. See AccountHistoryChartsInner.test.ts.
export function computeReturnBounds(values: number[]): ReturnGradientBounds {
  const dataMin = values.length === 0 ? 0 : Math.min(...values);
  const dataMax = values.length === 0 ? 0 : Math.max(...values);
  const axisLow = Math.min(0, dataMin);
  const axisHigh = Math.max(0, dataMax);
  const axisRange = axisHigh - axisLow;
  const pad = axisRange === 0 ? 1 : axisRange * 0.1;
  const yMin = axisLow - pad;
  const yMax = axisHigh + pad;
  let zeroOffset: number;
  if (dataMin >= 0) {
    zeroOffset = 1;
  } else if (dataMax <= 0) {
    zeroOffset = 0;
  } else {
    zeroOffset = dataMax / (dataMax - dataMin);
  }
  return { yMin, yMax, zeroOffset: Math.max(0, Math.min(1, zeroOffset)) };
}

function buildXTicks(xMin: number, xMax: number): number[] {
  const ticks: number[] = [];
  for (let y = Math.ceil(xMin); y <= Math.floor(xMax); y += 1) ticks.push(y);
  return ticks.length > 0 ? ticks : [xMin];
}

/**
 * Hover tooltip factory shared by both sub-charts. Shows the year plus
 * one formatted metric (currency ending balance / percent return). Drag
 * suppression is owned by ChartFrame, which only renders the
 * tooltip when `hoverX !== null && !isDragging`.
 */
function makeMetricTooltip(
  chrome: ChartChrome,
  dataKey: string,
  label: string,
  format: (v: number) => string,
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const value = datum[dataKey];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
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
        <div className="mb-1 text-muted">Year {datum.x}</div>
        <div className="flex justify-between gap-4">
          <span>{label}</span>
          <span>{format(value)}</span>
        </div>
      </div>
    );
  };
}

const InnerCharts: React.FC<InnerProps> = ({
  rows,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging = false,
}) => {
  const colors: ChartColors = useChartColors();
  const chrome = useChartChrome();
  const POSITIVE_COLOR = colors.accountReturnPositive;
  const NEGATIVE_COLOR = colors.accountReturnNegative;
  const returnBounds = computeReturnBounds(rows.map((r) => r.returnPct));
  const gradientStop = `${(returnBounds.zeroOffset * 100).toFixed(2)}%`;
  const data: ChartDatum[] = React.useMemo(
    () => rows.map((r) => ({ ...r, x: r.year })),
    [rows],
  );
  const xs = rows.map((r) => r.year);
  const xMin = xs.length > 0 ? Math.min(...xs) : 0;
  const xMax = xs.length > 0 ? Math.max(...xs) : 0;
  const ticks = buildXTicks(xMin, xMax);

  const balanceSeries: SeriesSpec[] = [
    { kind: 'line', dataKey: 'endingBalance', name: 'Ending balance', color: colors.essential, strokeWidth: 2, dot: true },
  ];
  const returnSeries: SeriesSpec[] = [
    {
      kind: 'line',
      dataKey: 'returnPct',
      name: 'Return %',
      color: POSITIVE_COLOR,
      strokeUrl: `url(#${GRADIENT_ID})`,
      strokeWidth: 2,
      dot: (point, cx, cy) => {
        const color = (point.returnPct as number) >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;
        return <circle cx={cx} cy={cy} r={3} fill={color} stroke={color} />;
      },
    },
  ];

  const balanceTooltip = React.useMemo(
    () => makeMetricTooltip(chrome, 'endingBalance', 'Ending balance', formatCurrency),
    [chrome],
  );
  const returnTooltip = React.useMemo(
    () => makeMetricTooltip(chrome, 'returnPct', 'Return %', formatPercent),
    [chrome],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="m-0 mb-1 text-base font-semibold text-ink">
          Ending balance by year
        </h3>
        <ChartFrame
          rows={data}
          series={balanceSeries}
          height={256}
          margin={{ top: 8, right: 16, bottom: 28, left: 72 }}
          ariaLabel="Ending balance by year"
          xDomain={xDomain ?? null}
          yDomain={yDomain ?? null}
          xTicks={ticks}
          yTickFormatter={formatCurrencyShort}
          dragSelection={dragSelection ?? null}
          isDragging={isDragging}
          pointerHandlers={mouseHandlers}
          renderTooltip={balanceTooltip}
        />
      </div>
      <div>
        <h3 className="m-0 mb-1 text-base font-semibold text-ink">
          Return % by year
        </h3>
        <ChartFrame
          rows={data}
          series={returnSeries}
          height={256}
          margin={{ top: 8, right: 16, bottom: 28, left: 64 }}
          ariaLabel="Return percent by year"
          xDomain={xDomain ?? null}
          // The shared `yDomain` is the drag-zoom's BALANCE-dollar y-domain
          // (computed from endingBalance in account-history-section.tsx). The
          // return chart is on a percent scale, so it must ignore it and always
          // use its own returnBounds — otherwise a zoom collapses the line and
          // its zero baseline against a dollar-scale axis (port regression).
          yDomain={[returnBounds.yMin, returnBounds.yMax]}
          xTicks={ticks}
          yTickFormatter={formatPercent}
          hLineY={0}
          dragSelection={dragSelection ?? null}
          isDragging={isDragging}
          pointerHandlers={mouseHandlers}
          renderTooltip={returnTooltip}
          defs={
            <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={POSITIVE_COLOR} />
              <stop offset={gradientStop} stopColor={POSITIVE_COLOR} />
              <stop offset={gradientStop} stopColor={NEGATIVE_COLOR} />
              <stop offset="100%" stopColor={NEGATIVE_COLOR} />
            </linearGradient>
          }
        />
      </div>
    </div>
  );
};

export default InnerCharts;
