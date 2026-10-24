// React hooks for the active-theme chart palette and chrome, split from `tokens.ts` so worker bundles never reach this `.tsx` import chain.

import { useTheme } from '../contexts/ThemeContext';
import {
  CHART_CHROME,
  CHART_COLORS,
  type ChartChrome,
  type ChartColors,
} from './tokens';

/** Chart palette for the active theme; reads `useTheme()`, so charts re-render on a toggle. */
export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return CHART_COLORS[resolvedTheme];
}

/** Chart chrome for the active theme. */
export function useChartChrome(): ChartChrome {
  const { resolvedTheme } = useTheme();
  return CHART_CHROME[resolvedTheme];
}
