/**
 * Light-palette colors for the jsPDF export, which always renders on a white page regardless of the app theme.
 * Chrome neutrals are not in `tokens.ts`, whose chart palette is gated by the WCAG contrast test.
 */
import { CHART_COLORS } from '../tokens';

/** Light-palette colors the PDF host paints with. */
export const PDF_LIGHT_COLORS = {
  text: '#1a1a1a',
  textMuted: '#5a5a5a',
  border: '#d0d0d0',
  headerBg: '#f5f5f5',
  pageBg: '#ffffff',

  chartEssential: CHART_COLORS.light.essential,
  chartDiscretionary: CHART_COLORS.light.discretionary,
  chartIncome: CHART_COLORS.light.income,
  chartShortfall: CHART_COLORS.light.shortfall,
  chartNetChangePositive: CHART_COLORS.light.netChangePositive,
  chartNetChangeNegative: CHART_COLORS.light.netChangeNegative,
  chartQcd: CHART_COLORS.light.qcd,
} as const;
