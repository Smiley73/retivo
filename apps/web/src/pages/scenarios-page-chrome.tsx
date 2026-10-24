/** Shared chrome for the scenarios, expenses and income pages: summary cards, field groups, banners and the re-exported control classes. */
import React from 'react';
import { Muted } from '../components/Muted';
import { RefreshIcon, SlidersIcon } from '../components/icons';
import {
  btnSecondarySmClass as btnSecondarySmClassInternal,
  btnDangerSmClass as btnDangerSmClassInternal,
} from './accounts-page-chrome';

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

/** Standalone, not concatenated with a size class (Tailwind v4 source order; see "Buttons and destructive actions" in docs/ui-conventions.md). */
export const btnSuccessSmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-positive px-2.5 py-1 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-positive/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const errorTextClass =
  'my-2 text-sm font-medium text-negative';

export const footNoteClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .foot-note geometry (12.5px text, 18px top margin) has no nearest-token equivalent
  'mt-[18px] text-[12.5px] text-muted';

export const noteClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .note geometry (14px radius, 16px/18px pad, 13.5px text, 22px margin) has no nearest-token equivalent
  'mb-[22px] rounded-[14px] border border-line bg-surface-sunken px-[18px] py-[16px] text-[13.5px] leading-relaxed text-muted';

export function bannerClass(tone: 'neutral' | 'warn' = 'neutral'): string {
  const base = 'my-2 rounded-md border px-3.5 py-2.5 text-sm';
  return tone === 'warn'
    ? `${base} border-warning/40 bg-surface-sunken text-warning`
    : `${base} border-line bg-surface-sunken text-ink`;
}

// A `<div role="group">` + `<header>`, not a `<fieldset>`: native fieldset has first-paint flex/grid sizing quirks.
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

export const SummaryCardBody: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <Muted as="p" className="m-0">
    {children}
  </Muted>
);

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
