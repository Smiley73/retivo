/**
 * Tests for the interactive (show/hide) chart legend. A static legend
 * (no `onToggle`) renders plain text entries; an interactive legend
 * renders one toggle `<button aria-pressed>` per visible series, dims +
 * strikes through hidden entries, and omits `hideFromLegend` specs.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { ChartLegend } from './ChartLegend';
import type { SeriesSpec } from './types';
import { expectNoA11yViolations } from '../../../test/a11y';

const series: SeriesSpec[] = [
  { kind: 'area', dataKey: 'a', name: 'Alpha', color: '#112233', stackId: 's' },
  { kind: 'line', dataKey: 'b', name: 'Beta', color: '#445566' },
  { kind: 'line', dataKey: 'b2', name: 'Beta', color: '#445566', hideFromLegend: true },
];

describe('ChartLegend', () => {
  it('renders static text entries without onToggle', () => {
    const { container } = render(<ChartLegend series={series} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
  });

  it('renders one toggle button per visible series (hideFromLegend omitted)', () => {
    const { container } = render(
      <ChartLegend series={series} hiddenSeries={new Set()} onToggle={vi.fn()} />,
    );
    // Alpha + Beta — the second Beta channel is hideFromLegend.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('calls onToggle with the series name and reflects hidden via aria-pressed', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <ChartLegend series={series} hiddenSeries={new Set()} onToggle={onToggle} />,
    );
    const alpha = within(container).getByRole('button', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(alpha);
    // Passes the clicked key + the full de-duplicated legend-key universe —
    // only non-hideFromLegend entries contribute, so the dashed `Beta`
    // channel is excluded and `Beta` appears exactly once.
    expect(onToggle).toHaveBeenCalledWith('Alpha', ['Alpha', 'Beta']);
    const passedKeys = onToggle.mock.calls[0]![1] as readonly string[];
    expect(passedKeys).toEqual([...new Set(passedKeys)]);

    rerender(
      <ChartLegend
        series={series}
        hiddenSeries={new Set(['Alpha'])}
        onToggle={onToggle}
      />,
    );
    const alphaHidden = within(container).getByRole('button', { name: 'Alpha' });
    expect(alphaHidden).toHaveAttribute('aria-pressed', 'true');
    expect(alphaHidden.className).toContain('line-through');
  });

  it('is a11y-clean as an interactive legend', async () => {
    const { container } = render(
      <ChartLegend
        series={series}
        hiddenSeries={new Set(['Alpha'])}
        onToggle={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
