/** Responsive grid of `<Stat>` tiles; numeric values use `tabular-nums` so figures line up. */
import React from 'react';

interface StatGridProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Column ramp: `'default'` is 2 → md:3 → xl:4; `'three'` caps at three; `'five'` and `'six'` go
   * N-up only on wide desktops.
   */
  cols?: 'default' | 'three' | 'four' | 'five' | 'six';
}

interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** `'positive'` tints the value green; `'default'` keeps `text-ink`. */
  tone?: 'default' | 'positive';
  /** Value text-colour class overriding `tone`, for values coloured across more than two states. */
  valueClassName?: string;
  className?: string;
}

const GRID_BASE = 'grid gap-3';

const GRID_COLS: Record<NonNullable<StatGridProps['cols']>, string> = {
  default: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4',
  three: 'grid-cols-2 md:grid-cols-3',
  four: 'grid-cols-2 md:grid-cols-4',
  five: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
  six: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6',
};

// Flex column so the value bottom-aligns via `mt-auto` regardless of label wrap.
const STAT_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.kpi` mock geometry (14px radius / 17px inline pad); no default-scale token matches the spec'd pixel values
  'flex flex-col rounded-[14px] border px-[17px] py-4 shadow-sm ' +
  'border-line bg-surface-raised';

const LABEL_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.kpi .k` mock type scale (11px / 1.3 line-height / .03em tracking)
  'text-left font-mono text-[11px] font-semibold uppercase leading-[1.3] tracking-[0.03em] text-muted';

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
