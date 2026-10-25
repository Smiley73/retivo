/**
 * Tooltip and currency-format helpers for the cashflow band chart, split out of `CashflowProjectionChartInner.tsx`,
 * which re-exports `makeCashflowTooltip`.
 */
import React from 'react';
import type { CashflowMonthlyPoint } from '../lib/cashflow-chart-types';
import type { CategoryMeta } from '../lib/category-palette';
import type { TooltipMember } from './tooltip-member';
import type { ChartColors, ChartChrome } from '../lib/tokens';
import type { ChartDatum } from './charts';
import { formatCurrency } from '../lib/format-currency';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function makeCashflowTooltip(
  members: TooltipMember[],
  granularity: 'monthly' | 'yearly' = 'monthly',
  colors: ChartColors,
  chrome: ChartChrome,
  hidden: ReadonlySet<string> = new Set(),
  category: {
    expenseMode: 'total' | 'category';
    categoryMeta: ReadonlyArray<CategoryMeta>;
  } = { expenseMode: 'total', categoryMeta: [] },
): (datum: ChartDatum) => React.ReactNode {
  const ESSENTIAL_COLOR = colors.essential;
  const DISCRETIONARY_COLOR = colors.discretionary;
  const TAXES_COLOR = colors.federalTax;
  const INCOME_COLOR = colors.cashflowIncome;
  const categoryActive =
    category.expenseMode === 'category' && category.categoryMeta.length > 0;
  return (datum: ChartDatum): React.ReactNode => {
    const point = datum as unknown as CashflowMonthlyPoint;
    // Hide sub-dollar floats — rounding artifacts, not real need.
    const rawShortfall = Math.max(0, point.total - point.totalIncome);
    const shortfall = rawShortfall >= 1 ? rawShortfall : 0;
    const shortfallColor = shortfall > 0 ? colors.shortfall : undefined;
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
        <div className="mb-1 text-muted">
          {granularity === 'yearly'
            ? point.year
            : `${SHORT_MONTHS[point.month0]} ${point.year}`}
        </div>
        {members.length > 0 && (
          <div className="mb-1 text-xs text-muted">
            {members.map((m, i) => (
              <span key={m.firstName + ':' + m.birthYear}>
                {i > 0 ? ' · ' : ''}
                {m.firstName} (age {point.year - m.birthYear})
              </span>
            ))}
          </div>
        )}
        {!hidden.has('Total income') && (
          <>
            <div className="flex justify-between gap-4">
              {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
              <span style={{ color: INCOME_COLOR }}>Total income</span>
              <span>{formatCurrency(point.totalIncome)}</span>
            </div>
            <div className="flex justify-between gap-4 pl-3">
              <span className="text-muted">Earned</span>
              <span className="text-muted">
                {formatCurrency(point.earned)}
              </span>
            </div>
            <div className="flex justify-between gap-4 pl-3">
              <span className="text-muted">Withdrawal</span>
              <span className="text-muted">
                {formatCurrency(point.withdrawal)}
              </span>
            </div>
          </>
        )}
        <div className="mt-1 flex justify-between gap-4">
          <span>Total expenses</span>
          <span>{formatCurrency(point.total)}</span>
        </div>
        {categoryActive
          ? category.categoryMeta.map((c) => {
              if (hidden.has(c.name)) return null;
              // The engine hands over the flattened datum, so read the flat `cat-${id}` key, not
              // `point.byCategory`.
              const v = (datum[`cat-${c.id}`] as number | null) ?? 0;
              if (v === 0) return null;
              return (
                <div key={c.id} className="flex justify-between gap-4 pl-3">
                  {/* eslint-disable-next-line no-restricted-syntax -- runtime per-category color from the theme-reactive tokens.ts palette */}
                  <span style={{ color: c.color }}>{c.name}</span>
                  <span>{formatCurrency(v)}</span>
                </div>
              );
            })
          : (
              <>
                {!hidden.has('Essential') && (
                  <div className="flex justify-between gap-4 pl-3">
                    {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
                    <span style={{ color: ESSENTIAL_COLOR }}>Essential</span>
                    <span>{formatCurrency(point.essential)}</span>
                  </div>
                )}
                {!hidden.has('Discretionary') && (
                  <div className="flex justify-between gap-4 pl-3">
                    {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
                    <span style={{ color: DISCRETIONARY_COLOR }}>Discretionary</span>
                    <span>{formatCurrency(point.discretionary)}</span>
                  </div>
                )}
              </>
            )}
        {!hidden.has('Taxes') && (
          <div className="flex justify-between gap-4 pl-3">
            {/* eslint-disable-next-line no-restricted-syntax -- runtime series color from the theme-reactive tokens.ts map */}
            <span style={{ color: TAXES_COLOR }}>
              {point.taxes < 0 ? 'Credit applied to premiums' : 'Taxes'}
            </span>
            <span>{formatCurrency(Math.abs(point.taxes))}</span>
          </div>
        )}
        {!hidden.has('Shortfall') && (
          <div
            className="mt-1 flex justify-between gap-4 pt-1"
            // eslint-disable-next-line no-restricted-syntax -- runtime theme-reactive tooltip divider color from tokens.ts
            style={{ borderTop: `1px solid ${chrome.tooltipBorder}` }}
          >
            {/* eslint-disable-next-line no-restricted-syntax -- runtime shortfall color computed at render (present only when shortfall > 0) */}
            <span style={{ color: shortfallColor }}>Shortfall</span>
            {/* eslint-disable-next-line no-restricted-syntax -- runtime shortfall color computed at render (present only when shortfall > 0) */}
            <span style={{ color: shortfallColor }}>
              {shortfall > 0 ? formatCurrency(shortfall) : '—'}
            </span>
          </div>
        )}
      </div>
    );
  };
}
