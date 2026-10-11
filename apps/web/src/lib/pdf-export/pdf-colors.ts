/**
 * Pure light-palette color helpers for the unified PDF export. The PDF
 * is ALWAYS rendered on a white page in the light palette regardless of the
 * app's active theme, so every chart capture + table chrome reads from
 * `CHART_COLORS.light` (never the dark twin, never a runtime CSS-var read).
 *
 * Non-token "chrome" neutrals (page text, table borders, header backgrounds)
 * that have no entry in the chart palette are fixed light hexes here. They are
 * deliberately NOT in `tokens.ts`: that file is the chart-series palette gated
 * by the WCAG non-text-UI contrast test, whereas these are print-surface
 * neutrals (borders / fills) outside that gate's scope.
 *
 * Framework-free: pure constants, no React / DOM / jsPDF import.
 */
import { CHART_COLORS } from '../tokens';

/**
 * The resolved light-palette colors the PDF host paints with. Chart-series
 * hues come straight from `CHART_COLORS.light` (one source of truth); the
 * `text` / `border` / `*Bg` neutrals are print-surface chrome.
 */
export const PDF_LIGHT_COLORS = {
  // Page chrome neutrals (print surface — not chart-series colors).
  text: '#1a1a1a',
  textMuted: '#5a5a5a',
  border: '#d0d0d0',
  headerBg: '#f5f5f5',
  pageBg: '#ffffff',

  // Chart-series hues — light palette only.
  chartEssential: CHART_COLORS.light.essential,
  chartDiscretionary: CHART_COLORS.light.discretionary,
  chartIncome: CHART_COLORS.light.income,
  chartShortfall: CHART_COLORS.light.shortfall,
  chartNetChangePositive: CHART_COLORS.light.netChangePositive,
  chartNetChangeNegative: CHART_COLORS.light.netChangeNegative,
  // Charitable (QCD) outflow stripe on the Annual portfolio flow chart (pink).
  chartQcd: CHART_COLORS.light.qcd,
} as const;
