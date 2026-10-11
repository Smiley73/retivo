/**
 * Shared helper for the per-chart theme-reactivity tests.
 * Renders a chart under a `ThemeProvider`
 * pinned to a deterministic light/dark preference (no `matchMedia`
 * dependency) so a test can assert the chart's color attribute is
 * sourced from the `CHART_COLORS` map and flips between themes.
 *
 * jsdom ships no `window.matchMedia`; `ThemeProvider` only consults it
 * for the 'system' preference, which these helpers never use (every
 * render stores an explicit light/dark value keyed by a unique userId).
 * The stub keeps `resolveTheme()` from throwing before the explicit
 * branch is reached.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { ThemeProvider } from '../contexts/ThemeContext';

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

let seq = 0;

/**
 * Wrap `node` in a `ThemeProvider` pinned to `theme`. Use this when a
 * test needs the full RTL result (screen / rerender / unmount) rather
 * than just the container — pass the element to `render()` directly,
 * or as a `wrapper`. A unique per-call userId isolates the stored
 * preference between renders in one test.
 *
 * Chart inner components read `useChartColors()` (→ `useTheme()`), so
 * any test that mounts a chart — directly or transitively via a page —
 * must render it under a ThemeProvider, exactly as the real app shell
 * does. This is the single shared seam for that.
 */
export function withTheme(
  theme: 'light' | 'dark',
  node: React.ReactNode,
): React.ReactElement {
  const userId = `r8-${theme}-${seq++}`;
  localStorage.setItem(`retivo.theme.${userId}`, theme);
  return <ThemeProvider userId={userId}>{node}</ThemeProvider>;
}

/**
 * Stable `wrapper` component for `render(ui, { wrapper: ThemeWrapper })`
 * — light theme, fixed key. Use when a test renders a chart-bearing
 * page/component and just needs *a* ThemeProvider ancestor (it doesn't
 * assert on theme color). RTL re-applies the wrapper on `rerender`, so
 * this also fixes rerender-based suites.
 */
export const ThemeWrapper: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  localStorage.setItem('retivo.theme.test-wrapper', 'light');
  return <ThemeProvider userId="test-wrapper">{children}</ThemeProvider>;
};

/**
 * Render `node` under a `ThemeProvider` resolved to `theme`, returning
 * the container (the common case for the per-chart color assertions).
 */
export function renderWithTheme(
  theme: 'light' | 'dark',
  node: React.ReactElement,
): HTMLElement {
  const { container } = render(withTheme(theme, node));
  return container;
}

/**
 * The SVG chart engine emits one `path[name="<series>"]` (area / line)
 * or `rect[name="<series>"]` (bar) whose `fill` (or, for a pure line
 * series, whose non-`none` `stroke`) carries the resolved series color.
 * Read that attribute — it is the unambiguous, series-specific value the
 * `CHART_COLORS` map fed the engine. (A whole-document stroke/fill scan
 * is ambiguous because some palette hues repeat across the light/dark
 * palettes.)
 */
export function seriesColor(
  container: HTMLElement,
  seriesName: string,
  attr: 'fill' | 'stroke' = 'fill',
): string {
  const node = Array.from(
    container.querySelectorAll<SVGElement>(
      `path[name="${seriesName}"], rect[name="${seriesName}"]`,
    ),
  ).find((p) => {
    const v = p.getAttribute(attr);
    return v !== null && v !== 'none';
  });
  if (!node) {
    throw new Error(`series "${seriesName}" ${attr} node not found`);
  }
  return node.getAttribute(attr) ?? '';
}
