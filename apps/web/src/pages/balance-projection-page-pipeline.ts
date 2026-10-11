/**
 * Balance Projection page — pipeline helpers barrel. Re-exports from the
 * concern-split siblings:
 *
 *  - `balance-projection-page-data.ts` — per-scenario runner adapter
 *    (`loadPageData`, `PipelineData`, `drawdownByMethodFromPageResult`,
 *    `DrawdownByMethodResult`).
 *  - `balance-projection-page-cashflow.ts` — income/expense cashflow
 *    series assembly (`buildPageCashflowSeries`, the non-drawdown surface
 *    that stays page-side).
 *  - `balance-projection-page-drawdown.ts` — chart-row deflator
 *    (`deflateChartRows`). The page-local drawdown simulation was deleted
 *    in the runner migration.
 *
 * The page imports from this barrel; the split keeps each concern file
 * under the file shape cap.
 */
export {
  loadPageData,
  drawdownByMethodFromPageResult,
  representativeByBasisFromSummary,
  type PipelineData,
  type DrawdownByMethodResult,
  type McBasis,
  type RepresentativeRun,
} from './balance-projection-page-data';
export {
  buildPageCashflowSeries,
} from './balance-projection-page-cashflow';
export { deflateChartRows } from './balance-projection-page-drawdown';
