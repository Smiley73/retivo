/**
 * Shared chrome for the scenarios / expenses / income area (Graphite Spectrum
 * semantic tokens). The
 * semantic-token replacement for the legacy `.card` / `.field` /
 * `.field-group` / `.section-card-*` / `.banner` / `.muted` / `.error`
 * markup these pages leaned on.
 *
 * Why a chrome module (not inline strings everywhere): these
 * pages share one control vocabulary — the scenario subsection summary
 * card (title + body + Configure/Reset actions, with an "overridden"
 * tint), a WAI-ARIA labelled field group (the preserved
 * `<div role="group">` + `<header>` pattern, NOT `<fieldset>`), and a
 * status banner. Centralising the class strings keeps the code DRY and
 * — critically — keeps the already-oversized `ScenarioDetailPage`
 * and the other large
 * pages from growing as legacy classes are replaced by longer utility
 * strings. Mirrors the established `accounts-page-chrome.tsx` /
 * `auth-page-chrome.tsx` pattern; the control classes (buttons, inputs,
 * selects, tables) are re-exported from `accounts-page-chrome.tsx` so
 * there is one source of truth for the shared form vocabulary.
 *
 * Visual style only — no behavioral contract. Every fg/bg pair is an
 * AA-safe Graphite Spectrum pair from apps/web/src/lib/contrast.ts.
 */
import React from 'react';
import { Muted } from '../components/Muted';
import { RefreshIcon, SlidersIcon } from '../components/icons';
// Internal use by the chrome components below (the re-export block makes
// the same strings available to call sites).
import {
  btnSecondarySmClass as btnSecondarySmClassInternal,
  btnDangerSmClass as btnDangerSmClassInternal,
} from './accounts-page-chrome';

// Re-export the shared form-control vocabulary so these call sites
// import everything from one chrome module (single source of truth —
// these strings live in accounts-page-chrome.tsx).
export {
  btnPrimaryClass,
  btnSecondaryClass,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  inputClass,
  tableClass,
  thClass,
  tdClass,
  tdNumClass,
  thNumClass,
  thStickyClass,
  thStickyNumClass,
  breadcrumbNavClass,
} from './accounts-page-chrome';

/**
 * Success button at the small size (row actions). A **standalone** class
 * string — not a full-size success class with `px-2.5 py-1 text-xs`
 * appended — because Tailwind v4 emits same-specificity utilities in
 * numeric source order, so a role class's `px-4 py-2` would beat the
 * appended `px-2.5 py-1` regardless of className order (the concat path
 * silently rendered the full-size padding). Compact sizing
 * (`px-2.5 py-1 text-xs`, no `font-medium`); AA-safe pair unchanged.
 * See "Buttons and destructive actions" in docs/ui-conventions.md.
 */
export const btnSuccessSmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-positive px-2.5 py-1 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-positive/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** Inline error line (legacy `.error`). */
export const errorTextClass =
  'my-2 text-sm font-medium text-negative';

/**
 * Footer summary line below an overrides screen (the mock `.foot-note`):
 * a muted, slightly-undersized count line ("N disabled · N modified · N
 * scenario-only." / "N of M accounts overridden."). Sits below the
 * content card / table with the mock's 18px top margin. The 12.5px size
 * and 18px margin are exact mock values with no nearest-token equivalent
 * (`text-xs`=12px / `text-sm`=14px both miss 12.5px; `mt-4`=16px /
 * `mt-5`=20px both miss 18px), so they ride arbitrary-value utilities.
 */
export const footNoteClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .foot-note geometry (12.5px text, 18px top margin) has no nearest-token equivalent
  'mt-[18px] text-[12.5px] text-muted';

/**
 * Bordered explanation callout (the mock `.note`): a sunken-surface block
 * with a hairline border, used for the intro explanation above the
 * Contributions / Returns override tables instead of plain muted
 * paragraphs. The 14px radius, 16px/18px padding, 13.5px text, and 22px
 * bottom margin are exact mock values with no nearest-token equivalent,
 * so they ride arbitrary-value utilities. The `line` border on the
 * `surface-sunken` fill is decorative (the fill + padding convey the
 * block — WCAG 1.4.11-exempt, same carve-out as `<Card>`); the
 * `muted`-on-`surface-sunken` text pair is an AA pair in contrast.ts.
 */
export const noteClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .note geometry (14px radius, 16px/18px pad, 13.5px text, 22px margin) has no nearest-token equivalent
  'mb-[22px] rounded-[14px] border border-line bg-surface-sunken px-[18px] py-[16px] text-[13.5px] leading-relaxed text-muted';

/**
 * Status banner (legacy `.banner` / `.banner--warn`). A soft-tinted
 * informational block; `tone="warn"` is the amber variant.
 */
export function bannerClass(tone: 'neutral' | 'warn' = 'neutral'): string {
  const base = 'my-2 rounded-md border px-3.5 py-2.5 text-sm';
  return tone === 'warn'
    ? `${base} border-warning/40 bg-surface-sunken text-warning`
    : `${base} border-line bg-surface-sunken text-ink`;
}

/**
 * WAI-ARIA labelled field group — the preserved
 * `<div role="group">` + `<header>` pattern (NOT a `<fieldset>`; see
 * AGENTS UI coding standards: native fieldset has
 * first-paint flex/grid sizing quirks). Deterministic flex layout from
 * the first paint; the header text is the accessible group name.
 */
interface FieldGroupProps {
  /** Visible header text — also the accessible group name. */
  legend: React.ReactNode;
  /** Stable id for the header (wired as `aria-labelledby`). */
  id: string;
  children: React.ReactNode;
  className?: string;
  /** Announces the whole group as disabled to assistive tech. */
  ariaDisabled?: boolean;
}

const FIELD_GROUP_CLASS =
  'mb-3 flex min-w-0 flex-col gap-2 rounded-md border p-3 border-line';

const FIELD_GROUP_LEGEND_CLASS =
  'text-sm font-medium text-muted';

export const FieldGroup: React.FC<FieldGroupProps> = ({
  legend,
  id,
  children,
  className,
  ariaDisabled,
}) => {
  const classes = className
    ? `${FIELD_GROUP_CLASS} ${className}`
    : FIELD_GROUP_CLASS;
  return (
    <div
      role="group"
      aria-labelledby={id}
      aria-disabled={ariaDisabled ? 'true' : undefined}
      className={classes}
    >
      <header id={id} className={FIELD_GROUP_LEGEND_CLASS}>
        {legend}
      </header>
      {children}
    </div>
  );
};

/**
 * Scenario subsection summary card — the legacy
 * `.card.stack[.card--overridden]` + `.section-card-row` /
 * `.section-card-body` / `.section-card-actions` pattern, re-expressed
 * in Tailwind defaults. Title above a two-column row: body copy on the
 * left, stacked action buttons (Configure + optional Reset) on the
 * right. `overridden` applies a soft accent wash surfacing the
 * "customised" state without shifting layout.
 *
 * The card flexes to fill a row and never shrinks below 280px (the
 * legacy `flex: 1; min-width: 280px`).
 */
interface SummarySectionCardProps {
  /** Visible card title — also the accessible section name. */
  title: React.ReactNode;
  /** Stable id for the title (wired as `aria-labelledby`). */
  headingId: string;
  /** Soft-tint the card when the scenario overrides this section. */
  overridden?: boolean;
  /** Body content (typically a muted summary line). */
  children: React.ReactNode;
  /** Action column (Configure / Reset buttons). */
  actions?: React.ReactNode;
  className?: string;
}

const SUMMARY_CARD_BASE =
  'mb-0 flex min-w-72 flex-1 flex-col gap-2 rounded-2xl border p-5 shadow-sm ' +
  'border-line';

const SUMMARY_CARD_TONE = {
  default: 'bg-surface-raised',
  // Soft accent wash for the "this section is customised" state — the
  // legacy `.card--overridden` accent tint, AA-safe.
  overridden: 'bg-accent-subtle',
} as const;

export const SummarySectionCard: React.FC<SummarySectionCardProps> = ({
  title,
  headingId,
  overridden,
  children,
  actions,
  className,
}) => {
  const tone = overridden
    ? SUMMARY_CARD_TONE.overridden
    : SUMMARY_CARD_TONE.default;
  const classes = [SUMMARY_CARD_BASE, tone, className]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes} aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-2">
        <h3 id={headingId} className="m-0 text-lg font-semibold text-ink">
          {title}
        </h3>
        {actions && (
          <div className="flex flex-shrink-0 flex-row gap-1">
            {actions}
          </div>
        )}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </section>
  );
};

/**
 * The "No scenario overrides." / summary line inside a
 * `<SummarySectionCard>` — a single muted line with no margin.
 */
export const SummaryCardBody: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <Muted as="p" className="m-0">
    {children}
  </Muted>
);

/**
 * The Configure + optional Reset action pair every scenario subsection
 * summary card renders in its `<SummarySectionCard actions>` slot.
 * Centralised so the ~17-line button block isn't copy-pasted into every
 * card (keeps the already-oversized `ScenarioDetailPage` /
 * `ScenarioExpenseSubsectionCards` from growing).
 */
interface ConfigureResetActionsProps {
  /** Visible-label suffix for the aria-labels (e.g. "life expectancy"). */
  subject: string;
  onConfigure: () => void;
  /** Renders the Reset button when provided. */
  onReset?: () => void;
}

export const ConfigureResetActions: React.FC<ConfigureResetActionsProps> = ({
  subject,
  onConfigure,
  onReset,
}) => (
  <>
    <button
      type="button"
      className={btnSecondarySmClassInternal}
      onClick={onConfigure}
      aria-label={`Configure ${subject}`}
    >
      <SlidersIcon />
    </button>
    {onReset && (
      <button
        type="button"
        className={btnDangerSmClassInternal}
        onClick={onReset}
        aria-label={`Reset ${subject}`}
      >
        <RefreshIcon />
      </button>
    )}
  </>
);

/**
 * A labelled group of scenario override cards — the 4 plain-English topic
 * groups (Timing & longevity · Income & expenses · Savings & investments ·
 * Withdrawals & taxes) the edit screen organises its 13 override cards into.
 * Header carries the group label plus an optional "N customized" badge
 * (absent when the count is 0); the body is the existing three-up override
 * grid. Page-chrome-local — same category as `SummarySectionCard`.
 */
interface ScenarioCardGroupProps {
  title: string;
  id: string;
  customizedCount?: number;
  /** Decorative leading glyph for the group header (aria-hidden). */
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const ScenarioCardGroup: React.FC<ScenarioCardGroupProps> = ({
  title,
  id,
  customizedCount,
  icon,
  children,
}) => {
  const headingId = `scenario-group-${id}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 border-l-2 border-accent-link pl-2.5 text-sm font-semibold uppercase tracking-wider text-muted"
        >
          {icon && <span className="text-accent-link">{icon}</span>}
          {title}
        </h2>
        {customizedCount !== undefined && customizedCount > 0 && (
          <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-link">
            {customizedCount} customized
          </span>
        )}
      </div>
      <div
        // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum override-grid mock 18px gap
        className="grid grid-cols-1 gap-[18px] md:grid-cols-3"
        data-testid={`scenario-group-${id}`}
      >
        {children}
      </div>
    </section>
  );
};
