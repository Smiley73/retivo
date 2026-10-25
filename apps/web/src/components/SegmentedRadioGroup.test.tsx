/** SegmentedRadioGroup: radiogroup roles, the checked option as the sole tab stop, click and arrow selection. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedRadioGroup } from './SegmentedRadioGroup';
import { expectNoA11yViolations } from '../test/a11y';

type Mode = 'a' | 'b' | 'c';

const OPTIONS = [
  { value: 'a' as const, label: 'Alpha' },
  { value: 'b' as const, label: 'Bravo' },
  { value: 'c' as const, label: 'Charlie' },
];

function setup(value: Mode = 'a') {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <SegmentedRadioGroup<Mode>
      ariaLabel="Test group"
      options={OPTIONS}
      value={value}
      onChange={onChange}
    />,
  );
  return { onChange, user, ...utils };
}

describe('SegmentedRadioGroup', () => {
  it('renders a radiogroup with the value option checked + roving tab stop', () => {
    setup('b');
    const group = screen.getByRole('radiogroup', { name: 'Test group' });
    expect(group).toBeInTheDocument();
    const bravo = screen.getByRole('radio', { name: 'Bravo' });
    // React Aria renders a native <input role="radio">, so selected state is `checked`, not `aria-checked`.
    expect(bravo).toBeChecked();
    expect(bravo).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('selects on click', async () => {
    const { onChange, user } = setup('a');
    await user.click(screen.getByRole('radio', { name: 'Charlie' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('ArrowRight moves+selects to the next option', async () => {
    const { onChange, user } = setup('a');
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('ArrowLeft wraps from first to last', async () => {
    const { onChange, user } = setup('a');
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('ignores non-navigation keys', async () => {
    const { onChange, user } = setup('a');
    await user.tab();
    await user.keyboard('x');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = setup('a');
    await expectNoA11yViolations(container);
  });

  it('applies compact sizing classes when size="sm"', () => {
    render(
      <SegmentedRadioGroup<Mode>
        ariaLabel="Test group"
        options={OPTIONS}
        value="a"
        onChange={vi.fn()}
        size="sm"
      />,
    );
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    const option = alpha.closest('label');
    expect(option).not.toBeNull();
    expect(option).toHaveClass('px-3', 'py-1.5', 'text-xs');
    expect(option).not.toHaveClass('text-[13.5px]');
  });

  it('defaults to the standard md sizing when size is omitted', () => {
    setup('a');
    const option = screen
      .getByRole('radio', { name: 'Alpha' })
      .closest('label');
    expect(option).toHaveClass('px-[15px]', 'py-2', 'text-[13.5px]');
  });

  // Disabling by wrapping the group does not work: React Aria needs `isDisabled` on the radiogroup itself.
  it('does not fire onChange while disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedRadioGroup<Mode>
        ariaLabel="Test group"
        options={OPTIONS}
        value="a"
        onChange={onChange}
        disabled
      />,
    );
    await user.click(screen.getByRole('radio', { name: 'Charlie' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeDisabled();
  });
});
