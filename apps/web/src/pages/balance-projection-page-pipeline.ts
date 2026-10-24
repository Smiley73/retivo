/** Barrel for the balance-projection-page-data, -cashflow and -drawdown modules. */
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
