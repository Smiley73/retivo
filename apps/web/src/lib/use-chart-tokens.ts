/**
 * React hooks for reading the active-theme chart palette + chrome.
 * Split out of `tokens.ts` so worker-bundled callers (which transitively
 * reach `tokens.ts` via `expense-preview-projection.ts` →
 * `balance-projection-runner-context.ts` → the optimiser worker) don't
 * drag the `.tsx` `ThemeContext` into the worker bundle — Vite's
 * `@vitejs/plugin-react` injects a React Refresh runtime into every
 * `.tsx` file that touches `window` at module init, which throws
 * `ReferenceError: Can't find variable: window` inside a Web Worker.
 *
 * Pure values + types live in `./tokens`; this file only adds the
 * `useTheme()` lookup that resolves the active palette.
 */
import { useTheme } from '../contexts/ThemeContext';
import {
  CHART_CHROME,
  CHART_COLORS,
  type ChartChrome,
  type ChartColors,
} from './tokens';

/**
 * Resolved chart palette for the active theme. Chart components call
 * this and pass `colors.<key>` to the SVG engine's `fill` / `stroke`
 * presentation attributes; because it reads `useTheme()`, every chart
 * re-renders with the new palette on a theme toggle (the per-chart
 * render test gates this).
 */
export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return CHART_COLORS[resolvedTheme];
}

/**
 * Resolved chart chrome for the active theme. Sibling to
 * `useChartColors()`; reads `useTheme()` so chart chrome flips with the
 * theme just like the series palette does.
 */
export function useChartChrome(): ChartChrome {
  const { resolvedTheme } = useTheme();
  return CHART_CHROME[resolvedTheme];
}
