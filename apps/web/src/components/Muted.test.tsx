/**
 * Muted — de-emphasized text render.
 *
 * Tailwind-defaults replacement for the legacy `.muted` class.
 * Asserts default inline render, the `as` element override, the
 * muted color classes. Purely presentational (no interactive control /
 * ARIA / focus / keyboard handler; the optional `role` live-region prop
 * is unset in these renders) → exempt from the a11y-smoke mandate (AGENTS
 * *Testing setup*).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Muted } from './Muted';

describe('Muted', () => {
  it('renders an inline span by default with the muted color', () => {
    const { container } = render(<Muted>Secondary copy</Muted>);
    const el = screen.getByText('Secondary copy');
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('text-muted');
    expect(container).toBeTruthy();
  });

  it('renders the requested element via `as`', () => {
    render(<Muted as="p">Paragraph</Muted>);
    expect(screen.getByText('Paragraph').tagName).toBe('P');
  });
});
