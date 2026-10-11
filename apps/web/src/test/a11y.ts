/**
 * A11y smoke-test helper for shared components.
 *
 * Wraps jest-axe with a project-wide ruleset (WCAG 2.1 AA) and
 * disables two rules that produce false positives under jsdom:
 *
 *   - `color-contrast` — jsdom has no rendered pixels, so the
 *     contrast algorithm has no useful input. Real contrast checks
 *     belong in a Playwright + axe pass over a real browser.
 *   - `region` — every page-level landmark check fails when a
 *     component renders in isolation (no `<main>` / `<nav>` /
 *     `<header>` wrappers). Page-level a11y will exercise this.
 *
 * Usage:
 *
 *   const { container } = render(<Modal ... />);
 *   await expectNoA11yViolations(container);
 *
 * Add the assertion to any new shared component test in
 * apps/web/src/components/*.test.tsx — see AGENTS.md (Testing setup).
 */
// jest-axe@10 ships no types; @types/jest-axe pins a stale axe-core
// version and creates a RunOptions mismatch against the installed
// axe-core@4. Keep the options as a plain literal — they're static
// and the runtime contract is well-defined by axe-core's docs.
import { axe } from 'jest-axe';
import { expect } from 'vitest';

export const A11Y_OPTIONS = {
  runOnly: {
    type: 'tag' as const,
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
};

export async function expectNoA11yViolations(
  container: Element,
): Promise<void> {
  const results = await axe(container, A11Y_OPTIONS);
  expect(results.violations).toEqual([]);
}
