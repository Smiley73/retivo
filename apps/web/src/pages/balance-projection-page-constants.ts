/** Shared constants and labels for the Balance Projection page family. */
import type { ProjectionMethod } from '../components/ProjectionChart';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';
import type { McBasis } from '../lib/monte-carlo';

export const METHOD_ORDER: ReadonlyArray<ProjectionMethod> = ['planned', 'twr'];

/** Aliases the canonical lib map so the page and the report builders agree on method names. */
export const METHOD_LABELS: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

/** Tier names shown in the Basis selector and in Monte Carlo chart titles. */
export const MC_BASIS_LABELS: Readonly<Record<McBasis, string>> = {
  'mc-typical': 'Typical',
  'mc-pessimistic': 'Pessimistic',
  'mc-bad-luck': 'Bad-luck',
};

/** Note under the Account Balance Stack and RMD titles: a Monte Carlo basis shows one illustrative path, not a distribution. */
export const MC_REPRESENTATIVE_RUN_SUBLABEL =
  'Based on one example simulated path.';

/**
 * Note under the tax band title for Monte Carlo bases: core tax is deducted from balances,
 * the display-only yield, interest and cost-basis refinements are not (see `BalanceProjectionEstimateNote`).
 */
export const MC_TAX_ESTIMATE_SUBLABEL =
  'Estimated tax for this example path — the core tax bill is funded from the ' +
  'projected balances; the added yield, interest, and cost-basis portion is ' +
  'shown but not yet deducted.';

/** Label of the basis a Monte-Carlo-aware chart reflects: the active MC tier, else the deterministic method. */
export function resolvedBasisLabel(
  activeMcBasis: McBasis | null,
  activeMethod: ProjectionMethod,
): string {
  return activeMcBasis ? MC_BASIS_LABELS[activeMcBasis] : METHOD_LABELS[activeMethod];
}

/** Section-landmark card chrome: a `<section aria-label>` exposes a named region, which the typed `<Card>` div cannot. */
export const CARD_SECTION_CLASS =
  'mb-4 mt-4 flex flex-col gap-3 rounded-lg border border-line ' +
  'bg-surface-raised p-5 shadow-sm';

export const SECTION_H2_CLASS =
  'm-0 text-xl font-semibold text-ink';

/** The tabbed views; the order is both the tab-row order and the DOM/print order. */
export type BalanceProjectionViewId =
  | 'overview'
  | 'cashflow'
  | 'accounts'
  | 'taxes'
  | 'swr'
  | 'compare';

export const VIEW_ORDER: ReadonlyArray<BalanceProjectionViewId> = [
  'overview',
  'cashflow',
  'accounts',
  'taxes',
  'swr',
  'compare',
];

export const VIEW_LABELS: Readonly<Record<BalanceProjectionViewId, string>> = {
  overview: 'Overview',
  cashflow: 'Cash flow',
  accounts: 'Accounts',
  taxes: 'Taxes & distributions',
  swr: 'Safe withdrawal rate',
  compare: 'Compare',
};

/** Parses a raw `?view=` value; an absent or unknown value falls back to Overview without rewriting the URL. */
export function parseBalanceProjectionView(raw: string | null): BalanceProjectionViewId {
  return raw !== null && (VIEW_ORDER as readonly string[]).includes(raw)
    ? (raw as BalanceProjectionViewId)
    : 'overview';
}

export const COMPARE_WITH_PARAM = 'with';

export function compareDeepLink(comparisonId: string): string {
  const params = new URLSearchParams({
    view: 'compare',
    [COMPARE_WITH_PARAM]: comparisonId,
  });
  return `/balance-projection?${params.toString()}`;
}
