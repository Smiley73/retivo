/** ChartLegend: static text entries without onToggle; toggle buttons with aria-pressed, dimming and hideFromLegend otherwise. */
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
