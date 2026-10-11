/**
 * React Aria's `useLabel` dev-only warning for a control with neither
 * `aria-label` nor `aria-labelledby`. Shared by any spy test that
 * asserts a control DID or DID NOT trip it — keeps the exact substring
 * and the `console.warn` mock-call matcher in one place instead of
 * duplicated per test file.
 *
 * Usage:
 *
 *   const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
 *   render(...);
 *   expect(firedReactAriaMissingLabelWarning(warn)).toBe(false);
 *   warn.mockRestore();
 */
import type { MockInstance } from 'vitest';

export const RA_MISSING_LABEL_WARNING =
  'aria-label or aria-labelledby attribute for accessibility';

export function firedReactAriaMissingLabelWarning(
  warn: MockInstance<(...args: unknown[]) => void>,
): boolean {
  return warn.mock.calls.some((call) =>
    call.some(
      (arg) => typeof arg === 'string' && arg.includes(RA_MISSING_LABEL_WARNING),
    ),
  );
}
