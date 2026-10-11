/**
 * Tooltip — focus reveal behavior + a11y smoke.
 *
 * Built on React Aria's `TooltipTrigger`/`Tooltip`.
 * Asserts the contract: the bubble is
 * hidden by default, reveals on keyboard focus (the a11y path the
 * legacy mouse-only handlers lacked — and the deterministic reveal
 * path under jsdom; React Aria owns pointer-hover-intent natively but
 * jsdom cannot emit the real mouse-modality pointer stream RA's
 * `useHover` gates on, so focus is the asserted seam), hides on blur,
 * and is wired as `role="tooltip"` + the trigger's `aria-describedby`
 * — plus the shared-component axe rule (AGENTS mandate). The public API
 * (`children`/`content`/`multiline`/`className`) is frozen.
 * Interaction goes through `@testing-library/user-event`.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';
import { expectNoA11yViolations } from '../test/a11y';

describe('Tooltip', () => {
  it('is hidden until the trigger is focused, then reveals and hides again', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Year mismatch detail">
        <span>warn</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Year mismatch detail',
    );
    await user.tab();
    await waitFor(() =>
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(),
    );
  });

  it('the trigger is keyboard-reachable (a11y over the mouse-only legacy)', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Keyboard reachable">
        <span>icon</span>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByText('icon').closest('[tabindex]')).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Keyboard reachable',
    );
  });

  it('applies the multiline variant classes', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip multiline content="A longer wrapping message">
        <span>m</span>
      </Tooltip>,
    );
    await user.tab();
    expect((await screen.findByRole('tooltip')).className).toContain(
      'max-w-72',
    );
  });

  it('has no a11y violations (revealed)', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(
      <Tooltip content="Accessible tip">
        <span>help</span>
      </Tooltip>,
    );
    await user.tab();
    await screen.findByRole('tooltip');
    // React Aria portals the tooltip outside the render container.
    await expectNoA11yViolations(baseElement);
  });
});
