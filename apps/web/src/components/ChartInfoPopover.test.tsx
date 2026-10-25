/** ChartInfoPopover: accessible trigger and decorative icon, open on press and keys, Esc and outside-press close, unmount while open. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChartInfoPopover } from './ChartInfoPopover';
import { expectNoA11yViolations } from '../test/a11y';

const LABEL = 'About the Per-year projection chart';

function renderPopover() {
  return render(
    <ChartInfoPopover label={LABEL}>
      <p className="m-0">The caption explains how the chart works.</p>
    </ChartInfoPopover>,
  );
}

describe('ChartInfoPopover', () => {
  it('renders the trigger with the given accessible name and a decorative icon', () => {
    renderPopover();
    const trigger = screen.getByRole('button', { name: LABEL });
    expect(trigger).toBeInTheDocument();
    const icon = trigger.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens a Dialog containing the children when pressed', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: LABEL }));
    const dialog = screen.getByRole('dialog', { name: LABEL });
    expect(dialog).toHaveTextContent('The caption explains how the chart works.');
  });

  it('opens on keyboard (Enter)', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.tab();
    expect(screen.getByRole('button', { name: LABEL })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: LABEL })).toBeInTheDocument();
  });

  it('opens on keyboard (Space)', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.tab();
    await user.keyboard(' ');
    expect(screen.getByRole('dialog', { name: LABEL })).toBeInTheDocument();
  });

  it('Esc closes the popover', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.getByRole('dialog', { name: LABEL })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on an outside press', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.getByRole('dialog', { name: LABEL })).toBeInTheDocument();
    // React Aria's outside-press close is unreliable under jsdom, so drive it with a click on document.body.
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the popover content out of the DOM until opened', () => {
    renderPopover();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.queryByText('The caption explains how the chart works.'),
    ).toBeNull();
  });

  it('has no a11y violations on the opened dialog', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: LABEL }));
    await expectNoA11yViolations(screen.getByRole('dialog', { name: LABEL }));
  });

  it('unmounts cleanly while open (no act/state warning, no error)', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderPopover();
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.getByRole('dialog', { name: LABEL })).toBeInTheDocument();
    expect(() => unmount()).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
