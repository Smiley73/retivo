/**
 * Inner SVG-engine impl for the Balance Projection page's spending
 * composition chart, lazy-imported by `SwrCompositionChart`.
 *
 * Up to four `kind:'area'` series sharing one `stackId`, bottom to top:
 * guaranteed income, other income (conditional), the after-tax portfolio
 * draw, and the tax that draw funds (conditional) — plus two `kind:'line'`
 * rule series (never `ChartFrameProps.hLineY`, which cannot express two
 * lines, is excluded from the legend/tooltip, and would let a rule line
 * outside the plotted domain render invisibly). Legend toggling is load-
 * bearing, not decorative: `ChartFrame` drops hidden series before the
 * stack and Y domain are computed, so hiding both income layers restacks
 * the after-tax draw onto the baseline and makes the rule-vs-draw
 * comparison directly geometric. Because the conditional layers make the
 * legend-key universe change under a mounted chart, the hidden set is
 * reconciled against the emitted series every render (`reconcileHidden`)
 * — see its docblock for the blank-chart case that guards.
 *
 * Each rule series plots the value its OWN row carries, measured from the
 * axis; this module enforces no flatness. The row builder holds the rule
 * flat in REAL terms and re-expresses it into each row's active dollar mode, so the
 * line is level under Today's-dollars and rises with inflation under
 * Future-dollars — where the draw, the income layers and the portfolio
 * figure beside the chart are all nominal too. Clamping it level there
 * would read a later year's nominal draw against a retirement-year rule
 * figure, the "flat NOMINAL" error `pages/balance-projection-swr-derivation.ts`
 * records as already rejected.
 *
 * Every row already carries its layer dollars, already resolved to the
 * active basis and dollar mode (`SwrComparisonYearRow`) — this module
 * does no arithmetic of its own beyond flattening the row for the chart
 * engine's flat `ChartDatum` shape.
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

/** Reference lines are dashed in this codebase (reused from
 *  `SafeWithdrawalRateChartInner`) so both rule lines read as a published
 *  heuristic, not a forecast of this household. */
const RULE_DASH_PATTERN = '5 4';

const GUARANTEED_NAME = 'Guaranteed income';
const OTHER_INCOME_NAME = 'Other income';
const DRAW_NAME = 'Portfolio withdrawal (after tax)';
const TAX_NAME = 'Tax on that withdrawal';
const FOUR_PCT_NAME = '4% rule';
const FOUR_HALF_PCT_NAME = '4.5% rule';

const DEPLETION_LABEL = 'Portfolio depleted';
const COMPARISON_START_LABEL = 'Comparison starts';

/** Stable identity for "nothing hidden", so reconciling a set that needs no
 *  pruning doesn't hand the memoized tooltip a fresh `Set` every render. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set<string>();

/**
 * Reconcile the legend's hidden set against the series actually emitted
 * this render.
 *
 * The legend-key universe here is not fixed for the component's lifetime:
 * the two conditional layers drop out whenever no row carries a non-zero
 * value, which a still-mounted chart can hit when the parent swaps in rows
 * for another basis. `useSeriesVisibility` prunes orphan keys only when the
 * next legend click arrives, so a hidden set captured while an isolated
 * conditional series was still emitted can, once that series disappears,
 * cover every key that remains — and `ChartFrame` drops hidden series
 * before it draws, which would leave a blank frame under a legend with
 * every entry struck through.
 *
 * So each render: drop keys no longer emitted, and fall back to all-visible
 * when what is left would hide everything. Returning `hidden` unchanged
 * where nothing needed pruning keeps the common case identity-stable.
 */
function reconcileHidden(
  hidden: ReadonlySet<string>,
  legendKeys: readonly string[],
): ReadonlySet<string> {
  if (hidden.size === 0) return hidden;
  const live = new Set([...hidden].filter((n) => legendKeys.includes(n)));
  // Nothing left to hide, or nothing left visible — all-visible either way.
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
  /** Booleans aren't valid `ChartDatum` values — encoded as 0/1 so the
   *  tooltip can still read it off the flattened datum. */
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

/** Exported (mirrors `SafeWithdrawalRateChartInner.makeTooltip`) so a
 *  component test can render the tooltip body directly off a `ChartDatum`
 *  without simulating a pointer hover. Does no arithmetic — every dollar is
 *  read straight off the datum — and omits any layer the legend has
 *  hidden, so the tooltip can never contradict the legend's own feedback. */
export function makeTooltip(
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
  // Empty rows: the caller gates the chart out before mounting it (< 2
  // plotted years, mirroring the current SWR chart's own gate), but guard a
  // bare empty series so the domain math never produces a NaN bound.
  const xMin = years.length > 0 ? years[0] : 0;
  const xMax = years.length > 0 ? years[years.length - 1] : 0;
  const activeDomain: [number, number] = [xMin, xMax];
  const ticks = fiveYearTicks(activeDomain[0], activeDomain[1]);

  // The two thin layers are conditional: when no row carries a non-zero
  // value, the series isn't emitted at all — no area, no legend entry, no
  // tooltip line (the tooltip's own zero-value guard handles the tooltip
  // side; this guards the stack + legend).
  const hasOtherIncome = rows.some((r) => r.otherIncome !== 0);
  const hasTax = rows.some((r) => r.tax !== 0);

  // The settled order, bottom to top — array order IS stack order
  // (`computeStackBands` accumulates the group as given), so the two
  // conditional layers are spliced in rather than reordered afterward.
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

  // The legend keys exactly as `ChartLegend` derives them, so the
  // reconciliation below can never disagree with what the legend renders.
  const legendKeys = seriesSpecs
    .filter((s) => !s.hideFromLegend)
    .map((s) => s.legendId ?? s.name);
  const visibleHidden = reconcileHidden(hidden, legendKeys);

  // Markers: a dashed vertical at depletion (when supplied), and one at the
  // first compared year when the leading row is partial — both derived
  // from `rows`/`depletionYear`, never passed in separately, so they can
  // never disagree with the rule lines' own null-at-the-partial-year gap.
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
