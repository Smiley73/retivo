/**
 * Class / hex vocabulary for the Plan stress-test slots (Graphite
 * Spectrum semantic tokens). Extracted from `PlanStressTestSection.tsx`
 * to keep that component under the shape limit.
 *
 * Lives under `components/` (not a `pages/*-page-chrome` module): a
 * `components/` file reaching into a `pages/*-chrome` module would form
 * a `components/ → pages/ → components/` import cycle. The class
 * strings mirror the shared `<Stat>` / table chrome (same AA-safe
 * semantic-token pairs, contrast.ts). Visual style only — no behavioral contract.
 */

// Stat-box classes (mirrors `<Stat>` / `.stat-grid` — these slots
// render *inside* the host page's StatGrid). Dark mode is the `.dark`
// CSS-variable swap (no `dark:` colour twins).
export const STAT_BOX =
  'rounded-lg border px-4 py-3 shadow-sm border-line bg-surface-raised';
// `text-center` mirrors the shared `<Stat>` tile (StatGrid.tsx) so the
// stress-test slots stay visually identical to their neighbours.
export const STAT_LABEL =
  'mb-1 text-center text-sm text-muted';
export const STAT_VALUE =
  'text-center text-2xl font-semibold tracking-tight tabular-nums ' +
  'text-ink';

// `.btn--sm`-equivalent compact buttons (still-shared class kept off
// the section file; rendered as semantic-token-utility buttons).
export const BTN_SM =
  'inline-flex items-center rounded-md border border-line-strong bg-surface-raised px-2.5 py-1 ' +
  'text-sm font-medium text-ink transition-colors hover:bg-surface-sunken';

// Percentile data-table classes. Intentionally identical to the
// canonical `accounts-page-chrome.tsx` definitions (same AA-safe
// Tailwind-default pairs, contrast.ts). The sticky-header classes are
// applied by the consumer on each `<Column>`, not here.
export const TABLE_CLASS =
  'w-full border-collapse text-left text-sm text-ink';
const TD_CLASS =
  'border-b border-line px-3 py-2';
export const TD_NUM_CLASS = `${TD_CLASS} text-right tabular-nums`;
/** Centred cell. For a column whose values are neither prose nor a figure to
 *  compare down the column — the market-stress depletion reading is a mix of
 *  "Fully funded" and "2058 (6 yr sooner)", which left-aligned sat oddly
 *  between two right-aligned number columns. */
export const TD_CENTER_CLASS = `${TD_CLASS} text-center`;

/**
 * Runtime status → Graphite Spectrum semantic-token hex (used in inline
 * `style.color` because the threshold is computed at render). Each hex
 * is the sRGB rendering of the matching OKLCH token in styles.css.
 *
 * Theme-aware: the status text renders on the `STAT_BOX` surface
 * (`surface-raised`). The light band is the darker on-light token shade;
 * the dark band is the lifted on-dark shade. `PlanStressTestSection`
 * selects the band by the resolved theme (`useTheme()`). Both bands'
 * fg/surface pairs are registered in contrast.ts ("stress status …").
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
 * Static semantic-token-class equivalent of {@link STATUS_HEX}, used
 * when the status tier is known from a threshold at render and does
 * **not** need per-row runtime theme JS — the `.dark` CSS-variable swap
 * handles the theme flip (so no `useTheme()` + inline `style.color`, no
 * eslint-disable). The token shades match STATUS_HEX so the contrast.ts
 * "stress status …" registrations for the `STAT_BOX` surface apply
 * unchanged. The horizon-card danger tints stay on STATUS_HEX + inline
 * style — they flip per row from a runtime `horizonStatus` computation.
 */
export const STATUS_TEXT_CLASS: Record<StatusTier, string> = {
  muted: 'text-muted',
  success: 'text-positive',
  warning: 'text-warning',
  danger: 'text-negative',
};

/**
 * Map a rounded plan-success percent (0–100) to its status tier — the
 * single source of truth for the green / amber / red thresholds shared
 * by the Plan stress-test card, the Dashboard readiness card, and the
 * Scenarios list rows. `null` (no Monte-Carlo result yet) → `muted`.
 * Thresholds: ≥85 success, ≥70 warning, otherwise danger.
 */
export function successTierForPct(pct: number | null): StatusTier {
  if (pct == null) return 'muted';
  if (pct >= 85) return 'success';
  if (pct >= 70) return 'warning';
  return 'danger';
}
