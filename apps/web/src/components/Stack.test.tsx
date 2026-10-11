/**
 * Stack — vertical flex utility render.
 *
 * Tailwind-defaults replacement for the legacy `.stack` class.
 * Asserts children render in a column flex. Purely presentational (no interactive control / ARIA / focus /
 * keyboard handler) → exempt from the a11y-smoke mandate (AGENTS *Testing
 * setup*).
 */
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
