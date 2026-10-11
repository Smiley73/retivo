/**
 * `useExternalLabelledBy` — deterministic first-render hook-return probe.
 *
 * The Select/DatePicker `console.warn` spy tests assert on React
 * Aria's dev-only render-phase warning, but jsdom + RTL's `act()` batches
 * the `useLayoutEffect` + `useState` update into the same flush as the
 * initial render, so a reversion of the render-1 seed never reliably
 * turns those tests red. This file probes the hook directly: a
 * throwaway component pushes the hook's return value into a closure
 * array on every render, so `seen[0]` is exactly the value returned
 * during the FIRST synchronous render — before the layout effect has
 * had a chance to run — regardless of how the test runner batches
 * subsequent effect-driven re-renders.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useExternalLabelledBy } from './use-external-label';

function renderAndCaptureFirstValue(
  id: string | undefined,
  ariaLabel: string | undefined,
): string | undefined {
  const seen: Array<string | undefined> = [];
  function Probe() {
    seen.push(useExternalLabelledBy(id, ariaLabel));
    return null;
  }
  render(<Probe />);
  return seen[0];
}

describe('useExternalLabelledBy', () => {
  it('seeds a non-empty aria-labelledby on the very first render on the id+external-label path', () => {
    // No `<label>` needs to exist in the DOM for this assertion — the
    // seed is label-independent (it fires before the layout effect
    // looks for a real label). This assertion goes red if the initial
    // `useState` reverts to seeding `undefined`.
    const firstValue = renderAndCaptureFirstValue('some-id', undefined);
    expect(firstValue).toEqual(expect.any(String));
    expect(firstValue).not.toBe('');
  });

  it('seeds undefined on the very first render when there is no id', () => {
    expect(renderAndCaptureFirstValue(undefined, undefined)).toBeUndefined();
  });

  it('seeds undefined on the very first render when an explicit ariaLabel is supplied', () => {
    expect(
      renderAndCaptureFirstValue('some-id', 'Explicit label'),
    ).toBeUndefined();
  });
});
