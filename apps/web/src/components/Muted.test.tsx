/** Muted: default inline render, the `as` element override and the muted colour classes; presentational, so no a11y scan. */
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
