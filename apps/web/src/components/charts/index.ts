/**
 * Barrel for the SVG chart engine; the engine reads `CHART_COLORS` / `CHART_CHROME` internally so series and chrome
 * re-flip on a `.dark` toggle.
 */
export { ChartFrame } from './engine/ChartFrame';
export { ChartLegend } from './engine/ChartLegend';
export { useSeriesVisibility } from './engine/useSeriesVisibility';
export * from './engine/scales';
export type {
  ChartDatum,
  SeriesSpec,
  SeriesZone,
  MarkerSpec,
} from './engine/types';
