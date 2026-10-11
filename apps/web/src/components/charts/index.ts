/**
 * Barrel for the in-house SVG chart engine. Chart `*Inner` components import the frame +
 * supporting types from here; the engine reads the theme-reactive
 * `CHART_COLORS` / `CHART_CHROME` tokens internally so series + chrome
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
