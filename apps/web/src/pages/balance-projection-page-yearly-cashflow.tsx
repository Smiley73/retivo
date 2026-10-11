/**
 * Balance Projection page — "Expected cashflow" band (cashflow chart +
 * granularity toggle + disclaimer). Extracted from
 * `balance-projection-page-yearly.tsx` to keep the yearly section
 * file under the 400-ln file shape cap.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { CashflowProjectionChart } from '../components/CashflowProjectionChart';
import type {
  CashflowChartMarker,
  CashflowMonthlyPoint,
} from '../components/CashflowProjectionChart';
import type { CategoryMeta } from '../lib/category-palette';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import type { CashflowGranularity } from '../lib/view-deflator';
import type { TooltipMember } from '../components/tooltip-member';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { CARD_SECTION_CLASS } from './balance-projection-page-constants';

const SECTION_H3_CLASS =
  'm-0 text-base font-semibold text-ink';

export interface YearlyCashflowBandProps {
  readonly cashflowGranularity: CashflowGranularity;
  readonly onGranularityChange: (g: CashflowGranularity) => void;
  readonly cashflowChartRows: ReadonlyArray<CashflowMonthlyPoint>;
  /** Retirement + life-expectancy markers (the canonical teal
   *  `Retires <Mon YYYY>` retirement line plus the death lines). */
  readonly chartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly depletionYear: number | null;
  /** Active deterministic method label (Planned / TWR) suffixed onto the
   *  card title so the user can tell which basis this chart reflects. */
  readonly methodLabel: string;
  /** Active expense categories for the "by category" expense-mode toggle.
   *  Empty ⇒ the expense-mode group is disabled (Total-only). */
  readonly categoryMeta: ReadonlyArray<CategoryMeta>;
}

/** Cashflow expense-stack mode: total (essential/discretionary) vs the
 *  per-category breakdown. Ephemeral, like the granularity toggle. */
type ExpenseMode = 'total' | 'category';

export const YearlyCashflowBand: React.FC<YearlyCashflowBandProps> = ({
  cashflowGranularity,
  onGranularityChange,
  cashflowChartRows,
  chartMarkers,
  tooltipMembers,
  depletionYear,
  methodLabel,
  categoryMeta,
}) => {
  // Expense-mode toggle is ephemeral `useState` (not persisted),
  // default Total. When no category carries a non-zero expense in
  // range (`categoryMeta` empty) the WHOLE group is disabled — the
  // component supports only a whole-group `disabled`, so a forced "Total"
  // is the degrade path.
  const [expenseMode, setExpenseMode] = useState<ExpenseMode>('total');
  const categoryAvailable = categoryMeta.length > 0;
  // Guard against a stale 'category' selection if categories disappear
  // (e.g. scenario / dollars flip leaves the set empty).
  const effectiveExpenseMode: ExpenseMode = categoryAvailable
    ? expenseMode
    : 'total';
  // Hook lives here (section), not in the lazy Inner.
  const xDomainFull = useMemo((): [number, number] => {
    if (cashflowChartRows.length === 0) return [0, 0];
    return [
      cashflowChartRows[0].fractionalYear,
      cashflowChartRows[cashflowChartRows.length - 1].fractionalYear,
    ];
  }, [cashflowChartRows]);

  // Normalise fractionalYear → x for the hook.
  const rowsForY = useMemo(
    () => cashflowChartRows.map((r) => ({ x: r.fractionalYear })),
    [cashflowChartRows],
  );

  // Y-range for visible cashflow values so the y-axis auto-fits on zoom.
  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = cashflowChartRows.filter((r) => xs.has(r.fractionalYear));
      if (visible.length < 2) return null;
      const vals = visible.flatMap((r) => [r.total, r.totalIncome]);
      const yMin = Math.min(0, ...vals);
      const yMax = Math.max(...vals);
      if (yMin === yMax) return null;
      return [yMin, yMax];
    },
    [cashflowChartRows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section className={CARD_SECTION_CLASS} aria-label="Expected cashflow">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className={SECTION_H3_CLASS}>Expected cashflow ({methodLabel})</h3>
          <ChartInfoPopover label="About the Expected cashflow chart">
            <p className="m-0">
              The stacked area is essential and discretionary expenses plus a
              Taxes band (federal income tax + IRMAA Medicare surcharge minus any
              ACA subsidy) for the currently-selected scenario (inflation +
              discretionary adjustment applied); the green line is total income,
              Social Security + pensions + part-time + one-off plus portfolio
              withdrawals under the selected method tab above. In funded years
              the line tracks the top of the expense stack; if the portfolio runs
              out, the line dips below and a red shortfall ribbon fills the gap.
            </p>
          </ChartInfoPopover>
        </div>
        <div className="report-print-hide flex items-center gap-2">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          {/* Expense-mode toggle: Total vs By category. Distinct
              `ariaLabel` from the granularity group so the name-scoped
              `balance-projection-radiogroup` e2e is unaffected. Disabled
              (whole group → forced Total) when no category is active. */}
          <SegmentedRadioGroup<ExpenseMode>
            size="sm"
            ariaLabel="Cashflow expense breakdown"
            value={effectiveExpenseMode}
            onChange={setExpenseMode}
            disabled={!categoryAvailable}
            options={[
              {
                value: 'total',
                label: 'Total',
                title: 'Essential and discretionary expense bands.',
              },
              {
                value: 'category',
                label: 'By category',
                title:
                  'Break the expense stack into one band per expense category.',
              },
            ]}
          />
          {/* The cashflow card owns its own granularity toggle; the
              income-breakdown card carries an independent one. */}
          <SegmentedRadioGroup<CashflowGranularity>
            size="sm"
            ariaLabel="Cashflow chart granularity"
            value={cashflowGranularity}
            onChange={onGranularityChange}
            options={[
              {
                value: 'yearly',
                label: 'Yearly',
                title:
                  'One point per year (December anchor), flat streams read constant and match the year-by-year table.',
              },
              {
                value: 'monthly',
                label: 'Monthly',
                title:
                  'Month-precise detail, intra-year timing, deflated per month.',
              },
            ]}
          />
        </div>
      </div>
      <CashflowProjectionChart
        rows={[...cashflowChartRows]}
        markers={[...chartMarkers]}
        depletionYear={depletionYear}
        members={[...tooltipMembers]}
        granularity={cashflowGranularity}
        expenseMode={effectiveExpenseMode}
        categoryMeta={categoryMeta}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </section>
  );
};
