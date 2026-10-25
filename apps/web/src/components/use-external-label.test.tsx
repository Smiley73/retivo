/** useExternalLabelledBy: probes the first synchronous render, which act() batching hides from the Select and DatePicker warn-spy tests. */
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
