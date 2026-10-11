/**
 * RangeSlider — React Aria `Slider` keyboard + value behaviour + a11y
 * smoke. The behavior is the point here, not visual parity.
 *
 * Asserts the FROZEN public API (`value`/`onChange`/`min`/`max`/`step`/
 * `formatValue`/`formatAriaValue`/`ariaLabel`): renders a `slider` role
 * with the accessible name + spoken value, Arrow keys step + snap and
 * fire `onChange(next)`, Home/End jump to the bounds, disabled blocks
 * interaction. Interaction goes through `@testing-library/user-event`.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RangeSlider, snapToStep } from './RangeSlider';
import { expectNoA11yViolations } from '../test/a11y';

function setup(value = 50, overrides: Partial<React.ComponentProps<typeof RangeSlider>> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <RangeSlider
      ariaLabel="Adjustment"
      min={0}
      max={100}
      step={5}
      value={value}
      onChange={onChange}
      formatValue={(v) => `${v}%`}
      formatAriaValue={(v) => `${v} percent`}
      {...overrides}
    />,
  );
  return { onChange, user, ...utils };
}

describe('RangeSlider', () => {
  it('snapToStep clamps and snaps to the nearest step', () => {
    expect(snapToStep(52, 0, 100, 5)).toBe(50);
    expect(snapToStep(-9, 0, 100, 5)).toBe(0);
    expect(snapToStep(999, 0, 100, 5)).toBe(100);
    expect(snapToStep(0.27, 0, 1, 0.05)).toBe(0.25);
  });

  it('exposes a STABLE accessible name + the formatted spoken value as a separate description', () => {
    setup(50);
    // Frozen AT contract: the thumb's accessible NAME is the stable
    // `ariaLabel` (never the value merged in), and the formatted spoken
    // value rides the separate `aria-describedby` channel. The slider
    // is a native range input — its value is the native `value`.
    const slider = screen.getByRole('slider', { name: 'Adjustment' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAccessibleName('Adjustment');
    expect(slider).toHaveAccessibleDescription('50 percent');
    // Visible badge shows the formatted value.
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('keeps the name stable while the spoken value tracks the value', () => {
    const { rerender } = setup(50);
    rerender(
      <RangeSlider
        ariaLabel="Adjustment"
        min={0}
        max={100}
        step={5}
        value={75}
        onChange={() => {}}
        formatValue={(v) => `${v}%`}
        formatAriaValue={(v) => `${v} percent`}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Adjustment' });
    // Name unchanged; only the described spoken value moved.
    expect(slider).toHaveAccessibleName('Adjustment');
    expect(slider).toHaveAccessibleDescription('75 percent');
  });

  it('falls back to formatValue for the spoken value when formatAriaValue is omitted', () => {
    render(
      <RangeSlider
        ariaLabel="Adjustment"
        min={0}
        max={100}
        step={5}
        value={40}
        onChange={() => {}}
        formatValue={(v) => `${v}%`}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Adjustment' });
    expect(slider).toHaveAccessibleName('Adjustment');
    expect(slider).toHaveAccessibleDescription('40%');
  });

  it('ArrowRight steps up and fires onChange with the snapped value', async () => {
    const { onChange, user } = setup(50);
    await user.tab();
    expect(screen.getByRole('slider', { name: /Adjustment/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith(55);
  });

  it('Home jumps to the minimum bound', async () => {
    const { onChange, user } = setup(50);
    await user.tab();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('does not fire onChange when disabled', async () => {
    const { onChange, user } = setup(50, { disabled: true });
    const slider = screen.getByRole('slider', { name: /Adjustment/ });
    await user.click(slider);
    await user.keyboard('{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = setup(50);
    await expectNoA11yViolations(container);
  });
});
