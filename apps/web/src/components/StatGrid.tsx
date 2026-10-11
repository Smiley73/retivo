/**
 * Stat summary grid — the typed Tailwind-defaults replacement for the
 * legacy `.stat-grid` > `.stat` > `.stat__label` / `.stat__value`
 * pattern.
 *
 * `<StatGrid>` is a responsive grid of `<Stat>` boxes using standard
 * Tailwind breakpoint columns (2 / md:3 / xl:4, gap-3). Each `<Stat>`
 * is a bordered surface tile with a muted label
 * above a prominent value. Numeric values render with `tabular-nums`
 * (the framework-independent numeric-alignment rule) so columns of figures line up.
 */
import React from 'react';

interface StatGridProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Responsive column ramp. `'default'` (omitted) = the standard
   * summary-tile grid (2 → md:3 → xl:4). `'three'` caps at three columns
   * (2 → md:3, no `xl` bump) — the natural fit for an exactly-three-tile
   * row (e.g. the projection page's lifetime tax-burden tiles) so the
   * row stays full-width with no empty fourth track on wide screens.
   * `'five'` / `'six'` = a fixed-N-card row that goes N-up only on a wide
   * desktop and steps down on narrower screens (2 → md:3 → lg:N).
   * `'five'` drives the projection page's "At retirement" / "At horizon"
   * rows; `'six'` the portfolio summary when an HSA adds a sixth tile —
   * both read best on a single line.
   */
  cols?: 'default' | 'three' | 'four' | 'five' | 'six';
}

interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /**
   * `'positive'` tints the value with the green `positive` token (e.g. a
   * surplus / gain KPI). `'default'` (omitted) keeps the standard `text-ink`.
   */
  tone?: 'default' | 'positive';
  /**
   * Explicit value text-colour class, overriding `tone` — for a value
   * whose colour is data-driven across more than two states (e.g. the
   * dashboard Plan Success KPI, which mirrors the readiness card's
   * green / amber / red success tier via `STATUS_TEXT_CLASS`).
   */
  valueClassName?: string;
  className?: string;
}

const GRID_BASE = 'grid gap-3';

// `default` is byte-identical to the legacy single GRID_CLASS string
// (every other StatGrid caller is unchanged). `five` keeps the 2/3
// low-end ramp, then jumps straight to 5 columns at `lg` instead of 4.
const GRID_COLS: Record<NonNullable<StatGridProps['cols']>, string> = {
  default: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4',
  three: 'grid-cols-2 md:grid-cols-3',
  four: 'grid-cols-2 md:grid-cols-4',
  five: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
  six: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
};

// The KPI tile is a flex column so the value bottom-baselines (pushed
// down by `mt-auto`) regardless of label wrap — the Graphite Spectrum
// `.kpi` mock. The hand-rolled projection / stress-test tiles mirror
// this (kept in sync).
const STAT_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.kpi` mock geometry (14px radius / 17px inline pad); no default-scale token matches the spec'd pixel values
  'flex flex-col rounded-[14px] border px-[17px] py-4 shadow-sm ' +
  'border-line bg-surface-raised';

// Top-left mono micro-label (the `.kpi .k` mock).
const LABEL_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.kpi .k` mock type scale (11px / 1.3 line-height / .03em tracking)
  'text-left font-mono text-[11px] font-semibold uppercase leading-[1.3] tracking-[0.03em] text-muted';

// `mt-auto` pins the value to the tile bottom; `tabular-nums` keeps
// stacked figures aligned — the numeric-alignment behavior.
// The `.kpi .v` mock.
const VALUE_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.kpi .v` mock type scale (22px / -.01em tracking)
  'mt-auto pt-2.5 text-left font-mono text-[22px] font-bold tracking-[-0.01em] tabular-nums';

const VALUE_TONE_CLASS: Record<NonNullable<StatProps['tone']>, string> = {
  default: 'text-ink',
  positive: 'text-positive',
};

export const Stat: React.FC<StatProps> = ({
  label,
  value,
  tone = 'default',
  valueClassName,
  className,
}) => {
  const classes = className ? `${STAT_CLASS} ${className}` : STAT_CLASS;
  const valueClasses = `${VALUE_CLASS} ${valueClassName ?? VALUE_TONE_CLASS[tone]}`;
  return (
    <div className={classes}>
      <div className={LABEL_CLASS}>{label}</div>
      <div className={valueClasses}>{value}</div>
    </div>
  );
};

export const StatGrid: React.FC<StatGridProps> = ({
  children,
  className,
  cols = 'default',
}) => {
  const base = `${GRID_BASE} ${GRID_COLS[cols]}`;
  const classes = className ? `${base} ${className}` : base;
  return <div className={classes}>{children}</div>;
};
