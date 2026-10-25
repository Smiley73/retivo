/** Stack: children render in a column flex; presentational, so no a11y scan. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Stack } from './Stack';

describe('Stack', () => {
  it('renders children in a column flex', () => {
    const { container } = render(
      <Stack>
        <span>One</span>
        <span>Two</span>
      </Stack>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('flex');
    expect(el.className).toContain('flex-col');
    expect(screen.getByText('One')).toBeInTheDocument();
  });
});
