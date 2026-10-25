/**
 * Inner SVG-engine chart for `SwrCompositionChart`: stacked income, draw and tax areas plus two dashed rule lines,
 * over rows already resolved to the active basis and dollar mode.
 */
import React from 'react';
import type { SwrComparisonYearRow } from '../lib/safe-withdrawal-rate-chart-types';
import type { TooltipMember } from './tooltip-member';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import { useChartColors, useChartChrome } from '../lib/use-chart-tokens';
import { formatCurrency, formatCurrencyShort } from '../lib/format-currency';
import { assignMarkerLabelSlots, fiveYearTicks } from '../lib/chart-markers';
import { ChartFrame, ChartLegend, useSeriesVisibility } from './charts';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './charts';

interface InnerProps {
  rows: ReadonlyArray<SwrComparisonYearRow>;
  depletionYear: number | null;
  members: ReadonlyArray<TooltipMember>;
}

const RULE_DASH_PATTERN = '5 4';

const GUARANTEED_NAME = 'Guaranteed income';
const OTHER_INCOME_NAME = 'Other income';
const DRAW_NAME = 'Portfolio withdrawal (after tax)';
const TAX_NAME = 'Tax on that withdrawal';
const FOUR_PCT_NAME = '4% rule';
const FOUR_HALF_PCT_NAME = '4.5% rule';

const DEPLETION_LABEL = 'Portfolio depleted';
const COMPARISON_START_LABEL = 'Comparison starts';

// Stable identity for "nothing hidden", so reconciling does not hand the memoized tooltip a fresh
// `Set` every render.
const NOTHING_HIDDEN: ReadonlySet<string> = new Set<string>();

// The legend-key universe changes under a mounted chart (conditional layers drop out), while
// `useSeriesVisibility` prunes orphan keys only on the next click. A stale hidden set could then
// cover every remaining key and leave a blank `ChartFrame` under a fully struck-through legend, so
// drop dead keys and fall back to all-visible.
function reconcileHidden(
  hidden: ReadonlySet<string>,
  legendKeys: readonly string[],
): ReadonlySet<string> {
  if (hidden.size === 0) return hidden;
  const live = new Set([...hidden].filter((n) => legendKeys.includes(n)));
  if (live.size === 0 || live.size >= legendKeys.length) return NOTHING_HIDDEN;
  return live.size === hidden.size ? hidden : live;
}

const PARTIAL_YEAR_NOTE =
  "This year is a part-year total and isn't compared against the rules.";
const POST_DEPLETION_NOTE =
  "These layers are the year's planned spending, not spending the portfolio can fund.";

interface FlatRow extends ChartDatum {
  year: number;
  guaranteedIncome: number;
  otherIncome: number;
  afterTaxDraw: number;
  tax: number;
  socialSecurity: number;
  pension: number;
  guaranteedIncomeSurplus: number;
  fourPercentRuleValue: number | null;
  fourPointFivePercentRuleValue: number | null;
  // Booleans are not valid `ChartDatum` values, so this is encoded 0/1.
  isPartialYear: 0 | 1;
}

function flattenRows(rows: ReadonlyArray<SwrComparisonYearRow>): FlatRow[] {
  return rows.map((r) => ({
    x: r.year,
    year: r.year,
    guaranteedIncome: r.guaranteedIncome,
    otherIncome: r.otherIncome,
    afterTaxDraw: r.afterTaxDraw,
    tax: r.tax,
    socialSecurity: r.guaranteedIncomeSplit.socialSecurity,
    pension: r.guaranteedIncomeSplit.pension,
    guaranteedIncomeSurplus: r.guaranteedIncomeSurplus,
    fourPercentRuleValue: r.fourPercentRuleValue,
    fourPointFivePercentRuleValue: r.fourPointFivePercentRuleValue,
    isPartialYear: r.isPartialYear ? 1 : 0,
  }));
}

// Omits any layer the legend has hidden.
function makeTooltip(
  colors: ChartColors,
  chrome: ChartChrome,
  depletionYear: number | null,
  members: ReadonlyArray<TooltipMember> = [],
  hidden: ReadonlySet<string> = new Set(),
): (datum: ChartDatum) => React.ReactNode {
  return (datum: ChartDatum): React.ReactNode => {
    const p = datum as unknown as FlatRow;
    const isPartial = p.isPartialYear === 1;
    const isPostDepletion = depletionYear !== null && p.year >= depletionYear;
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
        {!hidden.has(GUARANTEED_NAME) && (
          <>
            <div className="flex justify-between gap-4">
              {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
              <span style={{ color: colors.income }}>{GUARANTEED_NAME}</span>
              <span>{formatCurrency(p.guaranteedIncome)}</span>
            </div>
            <div className="flex justify-between gap-4 pl-3 text-xs text-muted">
              <span>Social Security</span>
              <span>{formatCurrency(p.socialSecurity)}</span>
            </div>
            <div className="flex justify-between gap-4 pl-3 text-xs text-muted">
              <span>Pension</span>
              <span>{formatCurrency(p.pension)}</span>
            </div>
            {p.guaranteedIncomeSurplus !== 0 && (
              <div className="flex justify-between gap-4 pl-3 text-xs text-muted">
                <span>Surplus (not needed that year)</span>
                <span>{formatCurrency(p.guaranteedIncomeSurplus)}</span>
              </div>
            )}
          </>
        )}
        {p.otherIncome !== 0 && !hidden.has(OTHER_INCOME_NAME) && (
          <div className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
            <span style={{ color: colors.incomePartTime }}>{OTHER_INCOME_NAME}</span>
            <span>{formatCurrency(p.otherIncome)}</span>
          </div>
        )}
        {!hidden.has(DRAW_NAME) && (
          <div className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
            <span style={{ color: colors.incomeWithdrawal }}>{DRAW_NAME}</span>
            <span>{formatCurrency(p.afterTaxDraw)}</span>
          </div>
        )}
        {p.tax !== 0 && !hidden.has(TAX_NAME) && (
          <div className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
            <span style={{ color: colors.federalTax }}>{TAX_NAME}</span>
            <span>{formatCurrency(p.tax)}</span>
          </div>
        )}
        {p.fourPercentRuleValue !== null && !hidden.has(FOUR_PCT_NAME) && (
          <div className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
            <span style={{ color: colors.essential }}>{FOUR_PCT_NAME}</span>
            <span>{formatCurrency(p.fourPercentRuleValue)}</span>
          </div>
        )}
        {p.fourPointFivePercentRuleValue !== null && !hidden.has(FOUR_HALF_PCT_NAME) && (
          <div className="flex justify-between gap-4">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color arg sourced from the theme-reactive tokens.ts map */}
            <span style={{ color: colors.twr }}>{FOUR_HALF_PCT_NAME}</span>
            <span>{formatCurrency(p.fourPointFivePercentRuleValue)}</span>
          </div>
        )}
        {isPartial && (
          <div className="mt-1 text-xs text-muted">{PARTIAL_YEAR_NOTE}</div>
        )}
        {isPostDepletion && (
          <div className="mt-1 text-xs text-muted">{POST_DEPLETION_NOTE}</div>
        )}
      </div>
    );
  };
}

const InnerChart: React.FC<InnerProps> = ({ rows, depletionYear, members }) => {
  const colors = useChartColors();
  const chrome = useChartChrome();
  const { hidden, toggle } = useSeriesVisibility();
  const data = React.useMemo(() => flattenRows(rows), [rows]);
  const years = rows.map((r) => r.year);
  // The caller gates the chart out below two plotted years; guard a bare empty series so the domain
  // stays finite.
  const xMin = years.length > 0 ? years[0] : 0;
  const xMax = years.length > 0 ? years[years.length - 1] : 0;
  const activeDomain: [number, number] = [xMin, xMax];
  const ticks = fiveYearTicks(activeDomain[0], activeDomain[1]);

  // The thin layers are emitted only when some row has a non-zero value.
  const hasOtherIncome = rows.some((r) => r.otherIncome !== 0);
  const hasTax = rows.some((r) => r.tax !== 0);

  // Array order is stack order (`computeStackBands`), so the conditional layers are spliced in.
  const stackSeries: SeriesSpec[] = [
    {
      kind: 'area',
      dataKey: 'guaranteedIncome',
      name: GUARANTEED_NAME,
      color: colors.income,
      stackId: 'spending',
      fillOpacity: 0.55,
    },
  ];
  if (hasOtherIncome) {
    stackSeries.push({
      kind: 'area',
      dataKey: 'otherIncome',
      name: OTHER_INCOME_NAME,
      color: colors.incomePartTime,
      stackId: 'spending',
      fillOpacity: 0.55,
    });
  }
  stackSeries.push({
    kind: 'area',
    dataKey: 'afterTaxDraw',
    name: DRAW_NAME,
    color: colors.incomeWithdrawal,
    stackId: 'spending',
    fillOpacity: 0.55,
  });
  if (hasTax) {
    stackSeries.push({
      kind: 'area',
      dataKey: 'tax',
      name: TAX_NAME,
      color: colors.federalTax,
      stackId: 'spending',
      fillOpacity: 0.55,
    });
  }
  const seriesSpecs: SeriesSpec[] = [
    ...stackSeries,
    {
      kind: 'line',
      dataKey: 'fourPercentRuleValue',
      name: FOUR_PCT_NAME,
      color: colors.essential,
      strokeWidth: 2,
      strokeDasharray: RULE_DASH_PATTERN,
    },
    {
      kind: 'line',
      dataKey: 'fourPointFivePercentRuleValue',
      name: FOUR_HALF_PCT_NAME,
      color: colors.twr,
      strokeWidth: 2,
      strokeDasharray: RULE_DASH_PATTERN,
    },
  ];

  const legendKeys = seriesSpecs
    .filter((s) => !s.hideFromLegend)
    .map((s) => s.legendId ?? s.name);
  const visibleHidden = reconcileHidden(hidden, legendKeys);

  // Markers derive from `rows` / `depletionYear` so they cannot disagree with the rule lines' null
  // at a partial year.
  const firstRow = rows[0];
  const firstComparedRow = firstRow?.isPartialYear
    ? rows.find((r) => !r.isPartialYear)
    : undefined;
  const rawMarkers: Array<{ fractionalYear: number; label: string; color: string }> = [];
  if (depletionYear !== null) {
    rawMarkers.push({ fractionalYear: depletionYear, label: DEPLETION_LABEL, color: colors.depletionMarker });
  }
  if (firstComparedRow) {
    rawMarkers.push({
      fractionalYear: firstComparedRow.year,
      label: COMPARISON_START_LABEL,
      color: colors.retirementMarker,
    });
  }
  const markerSpecs: MarkerSpec[] = assignMarkerLabelSlots(rawMarkers).map((m) => ({
    x: m.fractionalYear,
    label: m.label,
    color: m.color,
    slot: m.slot,
    clipToDomain: true,
  }));

  const tooltip = React.useMemo(
    () => makeTooltip(colors, chrome, depletionYear, members, visibleHidden),
    [colors, chrome, depletionYear, members, visibleHidden],
  );

  return (
    <div>
      <ChartFrame
        rows={data}
        series={seriesSpecs}
        markers={markerSpecs}
        height={320}
        ariaLabel="Spending composition and safe withdrawal rate chart"
        xDomain={activeDomain}
        yDomain={null}
        xTicks={ticks}
        xTickFormatter={(v) => String(Math.round(v))}
        yTickFormatter={formatCurrencyShort}
        hiddenSeries={visibleHidden}
        renderTooltip={tooltip}
      />
      <ChartLegend series={seriesSpecs} hiddenSeries={visibleHidden} onToggle={toggle} />
    </div>
  );
};

export default InnerChart;
