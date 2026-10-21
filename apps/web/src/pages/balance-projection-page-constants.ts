/**
 * Balance Projection page — shared constants for the page + its
 * siblings. Hoisted out so the chart / yearly / stats files share one
 * `METHOD_ORDER` source and the page itself stays under the file shape
 * cap.
 */
import type { ProjectionMethod } from '../components/ProjectionChart';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';
import type { McBasis } from './balance-projection-page-pipeline';

export const METHOD_ORDER: ReadonlyArray<ProjectionMethod> = ['planned', 'twr'];

/** The page's method-label map. Aliases the canonical `lib` map so
 *  the Balance Projection surfaces and the PDF/report builders that also read
 *  the canonical map can never disagree on what the TWR method is called. */
export const METHOD_LABELS: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

/** Tier display labels for the Monte Carlo bases — the names that appear in
 *  the Basis selector and in the parenthetical suffix of every MC-driven
 *  chart/section title (so a title names the basis actually driving it). */
export const MC_BASIS_LABELS: Readonly<Record<McBasis, string>> = {
  'mc-typical': 'Typical',
  'mc-pessimistic': 'Pessimistic',
  'mc-bad-luck': 'Bad-luck',
};

/**
 * Sub-label rendered as a small note below the Account Balance Stack + RMD
 * chart titles when a Monte Carlo basis is active. It disambiguates the
 * per-account split from an expected distribution — the per-account view makes
 * that misread more tempting — by stating the chart reflects ONE illustrative
 * path, not a fan of outcomes. Absent under a deterministic method.
 */
export const MC_REPRESENTATIVE_RUN_SUBLABEL =
  'Based on one example simulated path.';

/**
 * Tax-chart-specific sub-label rendered under the Tax & Health-Cost Burden band
 * title when a Monte Carlo basis is active. Every MC basis funds the CORE
 * tax bill from the portfolio each year (Combined-Pot and the named strategies
 * alike), so that portion IS reflected in the projected balances — but the
 * display-only refinements (tax on estimated investment yield, savings/
 * money-market/CD interest, and the evolving cost basis) are shown for
 * information and deliberately NOT deducted from either engine's balances
 * (see `BalanceProjectionEstimateNote`).
 * This sub-label states both
 * halves, for one representative run.
 */
export const MC_TAX_ESTIMATE_SUBLABEL =
  'Estimated tax for this example path — the core tax bill is funded from the ' +
  'projected balances; the added yield, interest, and cost-basis portion is ' +
  'shown but not yet deducted.';

/**
 * The label that names the basis a Monte-Carlo-aware surface actually
 * reflects: the active MC tier when an MC basis is selected, else the active
 * deterministic method label. Charts driven by the resolved drawdown
 * (cashflow, income breakdown, portfolio flow, tax burden, AND — v23 — the
 * Account Balance Stack + RMD) suffix THIS; the income-breakdown chart keeps
 * the plain `METHOD_LABELS[activeMethod]` (its sources are market-independent
 * plan inputs).
 */
export function resolvedBasisLabel(
  activeMcBasis: McBasis | null,
  activeMethod: ProjectionMethod,
): string {
  return activeMcBasis ? MC_BASIS_LABELS[activeMcBasis] : METHOD_LABELS[activeMethod];
}

/**
 * Deliberate section-landmark card chrome for the Balance Projection page:
 * each card is a `<section aria-label="…">` exposing a named region (the
 * typed `<Card>` is an unlabelled `<div>` and cannot), so the page family
 * standardises on this class string — a documented OOTB deviation per
 * AGENTS (UI coding standards / OOTB lock). Shared here so the five card
 * sites stay byte-identical.
 */
export const CARD_SECTION_CLASS =
  'mb-4 mt-4 flex flex-col gap-3 rounded-lg border border-line ' +
  'bg-surface-raised p-5 shadow-sm';

/**
 * Card-section `<h2>` heading chrome for the Balance Projection page family.
 * Shared here so the page + chart-section heading sites stay byte-identical.
 * (The `-yearly-*` retirement bands use a smaller `text-base` heading instead —
 * a distinct, deliberately non-shared literal.)
 */
export const SECTION_H2_CLASS =
  'm-0 text-xl font-semibold text-ink';

/**
 * The six tabbed views the page renders. Order is both the tab row's
 * left-to-right order AND the DOM/print order — Overview first so
 * printing preserves today's top-of-page content first, `compare` last in both.
 */
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

/** Tab row + tab-panel labels. The tab row's accessible name is "Projection
 *  views", set where the `TabList` is rendered. "Safe withdrawal rate"
 *  is sentence case like its siblings — an industry term, not renamed. */
export const VIEW_LABELS: Readonly<Record<BalanceProjectionViewId, string>> = {
  overview: 'Overview',
  cashflow: 'Cash flow',
  accounts: 'Accounts',
  taxes: 'Taxes & distributions',
  swr: 'Safe withdrawal rate',
  compare: 'Compare',
};

/**
 * Resolve a raw `?view=` search-param value to a view id, defaulting an
 * absent or unrecognised value to Overview. The page never writes the
 * URL to normalise an invalid value — it just renders Overview and leaves
 * the param as-is — so this parse is the page's only notion of "unknown ⇒
 * Overview"; reuse it in tests rather than re-deriving the default.
 */
export function parseBalanceProjectionView(raw: string | null): BalanceProjectionViewId {
  return raw !== null && (VIEW_ORDER as readonly string[]).includes(raw)
    ? (raw as BalanceProjectionViewId)
    : 'overview';
}

/** Search param carrying the comparison scenario id on the Compare tab. */
export const COMPARE_WITH_PARAM = 'with';

/**
 * Deep link to the Compare tab with `comparisonId` preselected as the
 * comparison scenario. The tab compares the *viewed* scenario with this one,
 * so callers that mean a specific pair switch the active scenario first.
 */
export function compareDeepLink(comparisonId: string): string {
  const params = new URLSearchParams({
    view: 'compare',
    [COMPARE_WITH_PARAM]: comparisonId,
  });
  return `/balance-projection?${params.toString()}`;
}
