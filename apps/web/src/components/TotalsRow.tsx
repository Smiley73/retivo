/**
 * Fixed 3-column grid of centred stat boxes for the balance dialogs (opening / change / closing); values use
 * `tabular-nums` so figures align.
 */
import React from 'react';

interface TotalsRowItem {
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
