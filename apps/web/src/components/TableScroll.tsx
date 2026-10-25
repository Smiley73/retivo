/**
 * Named, keyboard-scrollable region for long tables; see "Tables" in docs/ui-conventions.md. Sticky header and footer
 * classes belong to the consumer (`thStickyClass`, `rowStickyBottomClass` in `pages/accounts-page-chrome.tsx`).
 */
import React from 'react';

interface TableScrollProps {
  /**
   * Names the region by the table's contents (e.g. "Year-by-year projection table"), not
   * "scrollable table". Required so the landmark cannot be dropped.
   */
  label: string;
  children: React.ReactNode;
  className?: string;
  /**
   * `false` renders the bordered container without an overflow context or landmark. WebKit leaves a
   * row's `:hover` stuck inside an overflow container, so tables with hover-revealed `.row-actions`
   * opt out, at the cost of horizontal scrolling. Defaults to `true`.
   */
  scroll?: boolean;
  /**
   * Marks the region `aria-busy` while rows are still arriving without a live region announcing
   * them; set on the named region because `aria-busy` is inert on a role-less wrapper.
   */
  busy?: boolean;
}

const CHROME_CLASS = 'rounded-lg border shadow-sm border-line bg-surface-raised';

const WRAPPER_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- structural max-height cap from the TableScroll behavioral contract (see "Tables" in docs/ui-conventions.md)
  `max-h-[60vh] overflow-auto ${CHROME_CLASS} ` +
  'focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:-outline-offset-2 focus-visible:outline-ring';

export const TableScroll: React.FC<TableScrollProps> = ({
  label,
  children,
  className,
  scroll = true,
  busy,
}) => {
  // Non-scrolling variant: no overflow context (WebKit stuck-`:hover`) and no landmark; the inner
  // Table carries its own `aria-label`.
  if (!scroll) {
    const staticClasses = className
      ? `${CHROME_CLASS} ${className}`
      : CHROME_CLASS;
    return <div className={staticClasses}>{children}</div>;
  }
  const classes = className
    ? `${WRAPPER_CLASS} ${className}`
    : WRAPPER_CLASS;
  return (
    <div
      className={classes}
      role="region"
      tabIndex={0}
      aria-label={label}
      aria-busy={busy}
    >
      {children}
    </div>
  );
};
