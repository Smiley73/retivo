/**
 * Canonical display labels for the two deterministic projection methods.
 *
 * Every surface that names a method — basis selectors, chart legends, table
 * headers, PDF columns, progress-bar accessible names — reads it from here, so
 * the Balance Projection page, the Scenarios cards, the claim-age optimizer,
 * the report and the exported PDF cannot disagree on what a method is called.
 *
 * Lives in `lib/` (not in a page module) because the PDF export builders and
 * the chart components both consume it, and `lib` may not import from
 * `components/` or `pages/` (dependency-cruiser `lib-independent-of-ui`).
 */
import type { ProjectionMethod } from './balance-projection-runner-types.js';

/** The time-weighted-return (TWR) method's user-facing name. */
export const TWR_METHOD_LABEL = 'Historical';

/** Display label per deterministic projection method. */
export const PROJECTION_METHOD_LABELS: Readonly<Record<ProjectionMethod, string>> = {
  planned: 'Planned',
  twr: TWR_METHOD_LABEL,
};

/**
 * One-line past-performance disclaimer for the Historical method, consumed by
 * the projection-method explainer. The method replays the return each account
 * has already earned in the entered balance history; this states that a
 * measured past return is not a prediction. Wording follows the SEC's investor
 * bulletin on performance claims.
 *
 * The success-probability methodology modal and the exported report make the
 * same point about SIMULATED market histories rather than this one measured
 * return, so they carry their own longer phrasing instead of this constant —
 * they are not silently out of sync with it.
 */
export const PAST_PERFORMANCE_DISCLAIMER =
  'Past performance is not a forecast — your accounts may earn more or less ' +
  'than they have.';
