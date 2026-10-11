/**
 * RadioOption — visible circle indicator + a11y smoke.
 *
 * Wraps React Aria `Radio` with a styled ring/filled-dot indicator.
 * Asserts: indicator class swap on selection, text-sm label pin, role
 * pass-through, keyboard nav (Tab / ArrowDown / Space), disabled visual
 * state, and the shared-component axe rule (AGENTS mandate).
 *
 * Interaction via `@testing-library/user-event` — React Aria's
 * `usePress` model requires real pointer/keyboard events.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup } from 'react-aria-components';
import { RadioOption } from './RadioOption';
import { expectNoA11yViolations } from '../test/a11y';

// Helper — React Aria requires Radio elements inside a RadioGroup.
function renderGroup(
  ui: React.ReactElement,
  defaultValue?: string,
  onChange?: (v: string) => void,
) {
  return render(
    <RadioGroup
      defaultValue={defaultValue}
      aria-label="Test group"
      onChange={onChange}
    >
      {ui}
    </RadioGroup>,
  );
}

describe('RadioOption', () => {
  it('renders a radio with the given accessible name', () => {
    renderGroup(<RadioOption value="a">Option A</RadioOption>);
    expect(screen.getByRole('radio', { name: 'Option A' })).toBeInTheDocument();
  });

  it('unselected indicator has border classes, no fill', () => {
    const { container } = renderGroup(
      <RadioOption value="a">Option A</RadioOption>,
    );
    const indicator = container.querySelector('[aria-hidden]');
    expect(indicator).not.toBeNull();
    expect(indicator!.className).toContain('border');
    expect(indicator!.className).toContain('border-input-line');
    expect(indicator!.className).not.toContain('bg-accent');
  });

  it('selected indicator has filled classes + inner dot', () => {
    const { container } = renderGroup(
      <>
        <RadioOption value="a">Option A</RadioOption>
        <RadioOption value="b">Option B</RadioOption>
      </>,
      'a',
    );
    const indicators = container.querySelectorAll('[aria-hidden]');
    // First option selected → filled
    const selectedIndicator = indicators[0];
    expect(selectedIndicator!.className).toContain('bg-accent');
    // Inner dot present
    const innerDot = selectedIndicator!.querySelector('span');
    expect(innerDot).not.toBeNull();
    expect(innerDot!.className).toContain('bg-accent-ink');
    // Second option unselected → border only, no inner dot
    const unselectedIndicator = indicators[1];
    expect(unselectedIndicator!.className).toContain('border');
    expect(unselectedIndicator!.querySelector('span')).toBeNull();
  });

  it('label renders at text-sm (font baseline pin)', () => {
    const { container } = renderGroup(
      <RadioOption value="a">Option A</RadioOption>,
    );
    // React Aria renders Radio as <label class="…"> wrapping a hidden <input>.
    // The className lives on the <label>, not the <input> (role=radio).
    const label = container.querySelector('label');
    expect(label).not.toBeNull();
    expect(label!.className).toContain('text-sm');
  });

  it('keyboard nav: Tab focuses first radio, ArrowDown moves to next', async () => {
    const user = userEvent.setup();
    renderGroup(
      <>
        <RadioOption value="a">Option A</RadioOption>
        <RadioOption value="b">Option B</RadioOption>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Option A' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Option B' })).toHaveFocus();
  });

  it('Space selects the focused radio', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderGroup(
      <>
        <RadioOption value="a">Option A</RadioOption>
        <RadioOption value="b">Option B</RadioOption>
      </>,
      undefined,
      onChange,
    );
    await user.tab();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('disabled option carries cursor-not-allowed and opacity-60 classes', () => {
    const { container } = renderGroup(
      <RadioOption value="a" isDisabled>Option A</RadioOption>,
    );
    // React Aria renders Radio as <label class="…">; data-[disabled] utility
    // classes live on that label element, not the hidden <input> (role=radio).
    const label = container.querySelector('label');
    expect(label).not.toBeNull();
    expect(label!.className).toContain('data-[disabled]:cursor-not-allowed');
    expect(label!.className).toContain('data-[disabled]:opacity-60');
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <RadioGroup defaultValue="a" aria-label="Test group">
        <RadioOption value="a">Option A</RadioOption>
        <RadioOption value="b">Option B</RadioOption>
      </RadioGroup>,
    );
    await expectNoA11yViolations(container);
  });
});
