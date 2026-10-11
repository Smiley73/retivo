/**
 * Scrollable long-table wrapper — the React Aria Table primitive's
 * scroll-region landmark.
 *
 * BEHAVIORAL CONTRACT (see "Tables" in docs/ui-conventions.md):
 *
 *  - Renders `role="region"` + `tabIndex={0}` + a required `aria-label`
 *    — the named, keyboard-scrollable landmark. The `label` describes
 *    the *table contents*, never "Scrollable table"; it is a required
 *    prop so the call site cannot drop the landmark trio.
 *  - Body capped at `max-height: 60vh`; vertical scrollbar on overflow,
 *    horizontal scrollbar when columns don't fit.
 *  - Carries the rounded corners / border / shadow; a `:focus-visible`
 *    ring when the wrapper itself is focused.
 *
 * Sticky-thead / sticky-tfoot positioning is NOT this component's
 * responsibility. The consumer
 * applies the sticky utility classes directly on the RA Table's
 * `<Column>` (sticky-top) and the final totals `<Row>` (sticky-bottom);
 * the canonical token vocabulary (`thStickyClass`,
 * `thStickyNumClass`, `rowStickyBottomClass`) lives in
 * `apps/web/src/pages/accounts-page-chrome.tsx`.
 */
import React from 'react';

interface TableScrollProps {
  /**
   * Names the scroll region for assistive tech. MUST describe the table
   * *contents* (e.g. "Year-by-year projection table"), not the scroll
   * mechanism. Required — the landmark cannot be omitted.
   */
  label: string;
  children: React.ReactNode;
  className?: string;
  /**
   * When `false`, render the same bordered container WITHOUT the overflow
   * scroll context (and without the focusable scroll-region landmark, since
   * there is nothing to scroll). Required for tables whose rows use the
   * hover-revealed `.row-actions` cluster: WebKit/Safari leaves a row's CSS
   * `:hover` "stuck" while the row lives inside an `overflow` container, so
   * the prior row's actions never hid. Opting those tables out of scrolling
   * removes the trigger. Trade-off: the table is no longer horizontally
   * scrollable on narrow viewports — only use this where the column set is
   * narrow enough to tolerate that. Defaults to `true` (scrollable).
   */
  scroll?: boolean;
  /**
   * Marks the scroll region `aria-busy` while its rows are still being filled
   * in. Set it on a table whose contents arrive asynchronously WITHOUT a live
   * region announcing them, so assistive tech can tell "empty" from "not
   * finished yet". Deliberately lands on the named `role="region"` landmark:
   * `aria-busy` on a role-less wrapper is inert. Omitted (not `false`) when
   * undefined, so tables that never pass it keep their exact current DOM.
   */
  busy?: boolean;
}

// Tailwind v4 utilities: rounded corners + border + shadow + the 60vh
// body cap + overflow-auto for horizontal/vertical scroll. The
// `focus-visible:outline-*` utilities replace the legacy descendant
// `.table-scroll:focus-visible` rule — utilities on the wrapper itself
// reach this; descendant cells (sticky-thead/tfoot) are styled by the
// consumer via utility classes on `<Column>`/`<Row>`.
//
// `max-h-[60vh]` is the irreducible structural cap from the
// behavioral contract (see "Tables" in docs/ui-conventions.md) — viewport
// height is a runtime layout value with no default-scale token; the
// OOTB rule's escape hatch covers this case per-line below.
// Shared visual chrome (rounded corners + hairline border + shadow + fill).
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
  // Non-scrolling variant: a plain bordered container. No `overflow` context
  // (so WebKit's stuck-`:hover` on hover-action rows can't trigger) and no
  // scroll-region landmark / tabIndex (there is nothing to scroll). The inner
  // React Aria <Table> carries its own aria-label, so the wrapper needs none.
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
