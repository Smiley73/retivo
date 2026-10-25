/** StatGrid and Stat: label and value render, tabular-nums values and responsive columns; presentational, so no a11y scan. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatGrid, Stat } from './StatGrid';

describe('StatGrid', () => {
  it('renders stat label + value', () => {
    render(
      <StatGrid>
        <Stat label="Total saved" value="$1,234,567" />
      </StatGrid>,
    );
    expect(screen.getByText('Total saved')).toBeInTheDocument();
    expect(screen.getByText('$1,234,567')).toBeInTheDocument();
  });

  it('renders the value with tabular-nums for column alignment', () => {
    render(<Stat label="Plans" value="42" />);
    expect(screen.getByText('42').className).toContain('tabular-nums');
  });

  it('uses a responsive breakpoint grid', () => {
    const { container } = render(
      <StatGrid>
        <Stat label="a" value="1" />
      </StatGrid>,
    );
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('grid');
    expect(cls).toContain('grid-cols-2');
    expect(cls).toContain('md:grid-cols-3');
  });

  it('cols="three" caps at three columns (2 → md:3, no xl:4 track)', () => {
    const { container } = render(
      <StatGrid cols="three">
        <Stat label="a" value="1" />
      </StatGrid>,
    );
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('grid-cols-2');
    expect(cls).toContain('md:grid-cols-3');
    expect(cls).not.toContain('xl:grid-cols-4');
  });

  it('cols="five" ramps to a 5-up desktop grid (2 → md:3 → lg:5)', () => {
    const { container } = render(
      <StatGrid cols="five">
        <Stat label="a" value="1" />
      </StatGrid>,
    );
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('grid-cols-2');
    expect(cls).toContain('md:grid-cols-3');
    expect(cls).toContain('lg:grid-cols-5');
    expect(cls).not.toContain('xl:grid-cols-4');
  });

  it('cols="six" ramps to a 6-up desktop grid (2 → md:3 → lg:6)', () => {
    const { container } = render(
      <StatGrid cols="six">
        <Stat label="a" value="1" />
      </StatGrid>,
    );
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('grid-cols-2');
    expect(cls).toContain('md:grid-cols-3');
    expect(cls).toContain('lg:grid-cols-6');
    expect(cls).not.toContain('xl:grid-cols-4');
  });
});
