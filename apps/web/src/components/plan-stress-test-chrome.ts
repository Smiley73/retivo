/**
 * Class and hex vocabulary for the plan stress-test slots. Lives under `components/` because importing a
 * `pages/*-chrome` module would form a `components/ → pages/ → components/` cycle.
 */

export const STAT_BOX =
  'rounded-lg border px-4 py-3 shadow-sm border-line bg-surface-raised';
export const STAT_LABEL =
  'mb-1 text-center text-sm text-muted';

export const BTN_SM =
  'inline-flex items-center rounded-md border border-line-strong bg-surface-raised px-2.5 py-1 ' +
  'text-sm font-medium text-ink transition-colors hover:bg-surface-sunken';

export const TABLE_CLASS =
  'w-full border-collapse text-left text-sm text-ink';
const TD_CLASS =
  'border-b border-line px-3 py-2';
export const TD_NUM_CLASS = `${TD_CLASS} text-right tabular-nums`;
/**
 * Centred cell for a column whose values are neither prose nor a figure to compare down the column.
 */
export const TD_CENTER_CLASS = `${TD_CLASS} text-center`;

/**
 * Runtime status → semantic-token hex for inline `style.color`; the band is selected by the
 * resolved theme.
 */
export type StatusColors = {
  muted: string;
  success: string;
  warning: string;
  danger: string;
};

export const STATUS_HEX: Record<'light' | 'dark', StatusColors> = {
  light: {
    muted: '#575b62', // muted (graphite)
    success: '#097f23', // positive (green)
    warning: '#975800', // warning (amber)
    danger: '#b32228', // negative (red)
  },
  dark: {
    muted: '#a1a5ac', // muted (graphite)
    success: '#4cb86a', // positive (green)
    warning: '#e9ab2b', // warning (amber)
    danger: '#ef6661', // negative (red)
  },
} as const;

export type StatusTier = keyof StatusColors;

/**
 * Static class equivalent of {@link STATUS_HEX} for tiers known at render without per-row theme JS;
 * the `.dark` variable swap handles the flip.
 */
export const STATUS_TEXT_CLASS: Record<StatusTier, string> = {
  muted: 'text-muted',
  success: 'text-positive',
  warning: 'text-warning',
  danger: 'text-negative',
};

/**
 * Maps a rounded plan-success percent to its status tier (≥85 success, ≥70 warning, else danger);
 * `null` is `muted`.
 */
export function successTierForPct(pct: number | null): StatusTier {
  if (pct == null) return 'muted';
  if (pct >= 85) return 'success';
  if (pct >= 70) return 'warning';
  return 'danger';
}
