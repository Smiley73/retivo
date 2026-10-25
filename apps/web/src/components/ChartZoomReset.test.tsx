/** ChartZoomReset: hidden when not zoomed, shown when zoomed, and click calls reset. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChartZoomReset } from './ChartZoomReset';
import { expectNoA11yViolations } from '../test/a11y';

describe('ChartZoomReset', () => {
  it('null_when_not_zoomed', () => {
    const { container } = render(
      <ChartZoomReset isZoomed={false} onReset={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders_when_zoomed', () => {
    render(<ChartZoomReset isZoomed={true} onReset={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /reset view/i });
    expect(btn).toBeInTheDocument();
  });

  it('click_calls_reset', () => {
    const onReset = vi.fn();
    render(<ChartZoomReset isZoomed={true} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: /reset view/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('a11y_smoke', async () => {
    const { container } = render(
      <ChartZoomReset isZoomed={true} onReset={vi.fn()} />,
    );
    await expectNoA11yViolations(container);
  });
});
