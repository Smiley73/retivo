/**
 * KbdHint — keyboard hint render.
 *
 * Tailwind-defaults replacement for the legacy `.kbd-hint` class.
 * Asserts the hint text renders muted/extra-small. Purely presentational (a static `<p>` hint line — no
 * interactive control / ARIA / focus / keyboard handler) → exempt from the
 * a11y-smoke mandate (AGENTS *Testing setup*).
 */
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
