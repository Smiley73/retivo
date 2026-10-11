/**
 * InlineDisclaimerCard — the shared point-of-use disclaimer surface. Asserts
 * the `role="note"` + accessible name, the canonical lead + closing sourced
 * from the shared fragment constants, the fineprint text-size exception, the
 * bare `line` variant, plus the shared-component axe rule (AGENTS mandate).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InlineDisclaimerCard } from './InlineDisclaimerCard';
import {
  INLINE_DISCLAIMER_CLOSING,
  INLINE_DISCLAIMER_LEAD,
  TAX_SNAPSHOT_NOTE,
} from '../lib/disclaimer-fragments';
import { expectNoA11yViolations } from '../test/a11y';

describe('InlineDisclaimerCard', () => {
  it('renders a role="note" region with the supplied accessible name', () => {
    render(
      <InlineDisclaimerCard ariaLabel="Test disclaimer">middle text</InlineDisclaimerCard>,
    );
    expect(
      screen.getByRole('note', { name: /Test disclaimer/i }),
    ).toBeInTheDocument();
  });

  it('composes the canonical lead + scope middle + closing (card variant)', () => {
    render(
      <InlineDisclaimerCard ariaLabel="Test disclaimer">
        This scope-specific middle.
      </InlineDisclaimerCard>,
    );
    const note = screen.getByRole('note', { name: /Test disclaimer/i });
    expect(note).toHaveTextContent(INLINE_DISCLAIMER_LEAD);
    expect(note).toHaveTextContent('This scope-specific middle.');
    expect(note).toHaveTextContent(INLINE_DISCLAIMER_CLOSING);
    // The lead is a real bold-red emphasis, not an icon/colour-only cue.
    expect(note.querySelector('strong')?.textContent).toBe(INLINE_DISCLAIMER_LEAD);
  });

  it('renders body copy at text-xs fineprint by default and text-sm when size="sm"', () => {
    const { rerender } = render(
      <InlineDisclaimerCard ariaLabel="Test disclaimer">m</InlineDisclaimerCard>,
    );
    expect(screen.getByRole('note').querySelector('p')).toHaveClass('text-xs');
    rerender(
      <InlineDisclaimerCard ariaLabel="Test disclaimer" size="sm">m</InlineDisclaimerCard>,
    );
    expect(screen.getByRole('note').querySelector('p')).toHaveClass('text-sm');
  });

  it('renders the line variant as a bare note without auto lead/closing', () => {
    render(
      <InlineDisclaimerCard ariaLabel="Tax estimate disclaimer" variant="line">
        {TAX_SNAPSHOT_NOTE}
      </InlineDisclaimerCard>,
    );
    const note = screen.getByRole('note', { name: /Tax estimate disclaimer/i });
    expect(note.tagName.toLowerCase()).toBe('p');
    expect(note).toHaveTextContent(TAX_SNAPSHOT_NOTE);
    // No card chrome, and it does not force the financial-advice lead/closing.
    expect(note.className).not.toContain('rounded-2xl');
    expect(note).not.toHaveTextContent(INLINE_DISCLAIMER_LEAD);
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <InlineDisclaimerCard ariaLabel="Test disclaimer">middle</InlineDisclaimerCard>,
    );
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations for the line variant', async () => {
    const { container } = render(
      <InlineDisclaimerCard ariaLabel="Tax estimate disclaimer" variant="line">
        {TAX_SNAPSHOT_NOTE}
      </InlineDisclaimerCard>,
    );
    await expectNoA11yViolations(container);
  });
});
