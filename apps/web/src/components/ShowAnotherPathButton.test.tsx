/**
 * ShowAnotherPathButton — reroll control render + interaction + a11y.
 *
 * Covers the enabled click + Enter/Space activation, the `aria-disabled`
 * (NOT native `disabled`, stays keyboard-focusable) state with an accessible
 * reason when no alternative exists, and the WCAG 2.2 AA smoke assertion.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ShowAnotherPathButton } from './ShowAnotherPathButton';
import { expectNoA11yViolations } from '../test/a11y';

describe('ShowAnotherPathButton', () => {
  it('calls onShowAnotherPath on click when enabled', async () => {
    const onShowAnotherPath = vi.fn();
    const user = userEvent.setup();
    render(
      <ShowAnotherPathButton enabled onShowAnotherPath={onShowAnotherPath} />,
    );
    await user.click(screen.getByRole('button', { name: 'Show another likely path' }));
    expect(onShowAnotherPath).toHaveBeenCalledTimes(1);
  });

  it('calls onShowAnotherPath on Enter and Space when enabled', async () => {
    const onShowAnotherPath = vi.fn();
    const user = userEvent.setup();
    render(
      <ShowAnotherPathButton enabled onShowAnotherPath={onShowAnotherPath} />,
    );
    const button = screen.getByRole('button', { name: 'Show another likely path' });
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onShowAnotherPath).toHaveBeenCalledTimes(2);
  });

  it('is aria-disabled (NOT native disabled) and keyboard-focusable when no alternative exists', () => {
    render(
      <ShowAnotherPathButton enabled={false} onShowAnotherPath={() => {}} />,
    );
    const button = screen.getByRole('button', { name: 'Show another likely path' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Native `disabled` would remove it from the tab order + drop the
    // accessible reason; the control must stay focusable (WCAG 2.2 AA).
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();
  });

  it('exposes an accessible reason when disabled and does NOT fire the handler', async () => {
    const onShowAnotherPath = vi.fn();
    const user = userEvent.setup();
    render(
      <ShowAnotherPathButton enabled={false} onShowAnotherPath={onShowAnotherPath} />,
    );
    const button = screen.getByRole('button', { name: 'Show another likely path' });
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Only one likely path for this outcome',
    );
    // Guarded no-op while disabled.
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onShowAnotherPath).not.toHaveBeenCalled();
  });

  it('has no a11y violations (enabled)', async () => {
    const { container } = render(
      <ShowAnotherPathButton enabled onShowAnotherPath={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations (disabled)', async () => {
    const { container } = render(
      <ShowAnotherPathButton enabled={false} onShowAnotherPath={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
