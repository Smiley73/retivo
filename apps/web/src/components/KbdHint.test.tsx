/** KbdHint: the hint text renders muted and extra-small; presentational, so no a11y scan. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KbdHint } from './KbdHint';

describe('KbdHint', () => {
  it('renders the hint text with the muted/extra-small classes', () => {
    render(<KbdHint>Press Enter to save · Esc to cancel</KbdHint>);
    const el = screen.getByText('Press Enter to save · Esc to cancel');
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('text-muted');
  });
});
