/**
 * Totals row — the typed Tailwind-defaults replacement for the legacy
 * `.totals-row` > `.totals-row__item` > `.totals-row__label` /
 * `.totals-row__value` pattern.
 *
 * A fixed 3-column grid of distinct stat boxes used in the balance
 * dialogs (e.g. opening / change / closing). Exactly three `items` are
 * expected — the legacy pattern is `grid-template-columns: repeat(3,
 * 1fr)`. Each box is a centered label + value on a subtle surface.
 *
 * BEHAVIORAL RULE — values render with `tabular-nums` so the
 * three figures align (the framework-independent numeric-alignment
 * behavior), the same legibility behavior the legacy pattern relied on.
 */
import React from 'react';

interface TotalsRowItem {
  /** Stable key for the cell. */
  key: string;
  label: React.ReactNode;
  value: React.ReactNode;
}

interface TotalsRowProps {
  items: readonly TotalsRowItem[];
  className?: string;
}

const ROW_CLASS = 'mb-4 grid grid-cols-3 gap-3';

const ITEM_CLASS =
  'rounded-md px-3 py-2.5 text-center bg-surface-sunken';

const LABEL_CLASS =
  'mb-1 text-xs font-semibold text-muted';

// `font-mono tabular-nums` keeps the three figures aligned in JetBrains
// Mono — the Tabular-Money Rule, matching the `StatGrid` KPI sibling these
// totals boxes mirror (see "Typography" in docs/ui-conventions.md).
const VALUE_CLASS =
  'font-semibold font-mono tabular-nums text-ink';

export const TotalsRow: React.FC<TotalsRowProps> = ({ items, className }) => {
  const classes = className ? `${ROW_CLASS} ${className}` : ROW_CLASS;
  return (
    <div className={classes}>
      {items.map((item) => (
        <div key={item.key} className={ITEM_CLASS}>
          <div className={LABEL_CLASS}>{item.label}</div>
          <div className={VALUE_CLASS}>{item.value}</div>
        </div>
      ))}
    </div>
  );
};
