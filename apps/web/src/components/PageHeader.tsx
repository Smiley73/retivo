/**
 * Page header — the typed Tailwind-defaults replacement for the legacy
 * `.page-header` pattern.
 *
 * A flex row: a heading (+ optional subtitle) on the left, an optional
 * primary action on the right.
 *
 * BEHAVIORAL RULE — the page-header primary action is always a
 * `<button>`, never a plain text `<Link>` (see "Buttons and destructive
 * actions" in docs/ui-conventions.md). This is a
 * framework-independent UX/a11y rule. The `action` prop is therefore an `{ label, onClick }` descriptor
 * that this component renders as a styled `<button>` — call sites cannot
 * pass an arbitrary `<Link>`. Whether the action navigates a route
 * (`onClick={() => navigate('/path')}`) or opens a modal is the caller's
 * choice; either way it stays a button.
 */
import React from 'react';

interface PageHeaderAction {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Accessible name when the visible label is an icon/short glyph. */
  ariaLabel?: string;
}

/**
 * A secondary header button (Cancel / Reset). Rendered to the LEFT of the
 * primary `action`, in array order, matching the Graphite Spectrum form
 * `page-h` convention (Cancel ghost + Save primary, both top-right). The
 * primary action stays the lime `accent` fill; secondaries are the ghost
 * (`neutral`) or destructive (`danger`) variants.
 */
interface PageHeaderSecondaryAction {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Visual tone. `neutral` = ghost (Cancel); `danger` = destructive (Reset). */
  tone?: 'neutral' | 'danger';
  /**
   * Optional leading glyph rendered before the label (e.g. a trash can on
   * Delete). Mirrors the primary action's `actionIcon`; rides the button's
   * `gap-2` so icon + label stay aligned.
   */
  icon?: React.ReactNode;
  /** Stable React key (falls back to ariaLabel, then a string label). */
  key?: string;
}

interface PageHeaderProps {
  title: React.ReactNode;
  /** Optional supporting line under the title. */
  subtitle?: React.ReactNode;
  /** Optional primary action — always rendered as a `<button>`. */
  action?: PageHeaderAction;
  /**
   * Optional secondary actions (Cancel / Reset) rendered left of the
   * primary `action`, in order. Used by the form pages so Cancel + Save
   * sit together in the header (mockup `page-h`).
   */
  secondaryActions?: PageHeaderSecondaryAction[];
  /**
   * Optional leading glyph rendered inside the action button before the
   * label (e.g. a "+"). Sits in a `gap-2 inline-flex items-center` row so
   * icon + label stay baseline-aligned.
   */
  actionIcon?: React.ReactNode;
  /** Heading level for the title. Default `1`. */
  headingLevel?: 1 | 2;
  className?: string;
}

const HEADER_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.page-h` mock bottom margin (26px)
  'mb-[26px] flex flex-wrap items-start justify-between gap-6';

/**
 * Canonical Graphite Spectrum page-title class (`.page-h h1`). Exported so
 * the rare page whose header carries inline controls and so can't use the
 * full `PageHeader` (e.g. BalanceProjectionPage, with its Basis select +
 * dollars toggle) can still render its `<h1>` at the exact shared type
 * scale instead of a stale hand-rolled one.
 */
export const pageTitleClass =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.page-h h1` mock type scale (28px / -.028em tracking)
  'm-0 text-[28px] font-extrabold leading-tight tracking-[-0.028em] text-ink';

// eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.page-h .sub` mock measure cap (880px)
const SUBTITLE_CLASS = 'm-0 mt-2 max-w-[880px] text-sm text-muted';

// Primary action: the lime `accent` fill with the dark `accent-ink`
// label (7.97:1 light / 10.68:1 dark — the bright lime is too light for
// white text). Dark mode is the same tokens re-pointed by the `.dark`
// variable swap; no `dark:` twins. Registered "primary button label on
// accent" in contrast.ts.
const ACTION_GEOMETRY =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum action-button mock geometry (10px radius / 17px x 11px pad)
  'inline-flex items-center gap-2 rounded-[10px] px-[17px] py-[11px] text-sm font-medium ' +
  'transition-colors focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const ACTION_CLASS = `${ACTION_GEOMETRY} bg-accent text-accent-ink shadow-sm hover:bg-accent/90`;

// Secondary (ghost) header button — the mock's `.btn-ghost`: transparent
// fill, `line` border, `ink` label, gentle `surface-sunken` hover. AA pair
// already registered in contrast.ts (ink on surface).
const ACTION_NEUTRAL_CLASS = `${ACTION_GEOMETRY} border border-line bg-transparent text-ink hover:bg-surface-sunken`;

// Destructive header button (expense scenario-patch "Reset overrides") —
// the `negative` hue carried whenever visible, deepening on hover, matching
// the `iactDeleteClass` destructive-affordance convention.
const ACTION_DANGER_CLASS = `${ACTION_GEOMETRY} border border-negative/40 bg-transparent text-negative hover:bg-negative/10`;

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  action,
  secondaryActions,
  actionIcon,
  headingLevel = 1,
  className,
}) => {
  const Heading = headingLevel === 2 ? 'h2' : 'h1';
  const classes = className ? `${HEADER_CLASS} ${className}` : HEADER_CLASS;
  const hasActions = Boolean(action) || (secondaryActions?.length ?? 0) > 0;
  return (
    <div className={classes}>
      <div data-testid="page-header-title-wrap" className="min-w-0 flex-1">
        <Heading className={pageTitleClass}>{title}</Heading>
        {subtitle && <p className={SUBTITLE_CLASS}>{subtitle}</p>}
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-3">
          {secondaryActions?.map((a, i) => (
            <button
              key={
                a.key ??
                a.ariaLabel ??
                (typeof a.label === 'string' ? a.label : String(i))
              }
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              aria-label={a.ariaLabel}
              className={
                a.tone === 'danger' ? ACTION_DANGER_CLASS : ACTION_NEUTRAL_CLASS
              }
            >
              {a.icon && (
                <span aria-hidden="true" className="inline-flex items-center">
                  {a.icon}
                </span>
              )}
              {a.label}
            </button>
          ))}
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              aria-label={action.ariaLabel}
              className={ACTION_CLASS}
            >
              {actionIcon && (
                <span aria-hidden="true" className="inline-flex items-center">
                  {actionIcon}
                </span>
              )}
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
