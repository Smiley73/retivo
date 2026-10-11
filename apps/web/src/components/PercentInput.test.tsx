/**
 * PercentInput — a11y smoke + minimal behavioural coverage.
 *
 * Most percent-input behaviour is exercised indirectly through the
 * Account / Scenario forms. This file's job is to lock in label
 * association (form variant) and aria-label (cell variant) so the
 * input always has an accessible name, and to prove the component
 * surfaces no axe violations in either variant.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PercentInput, formatPercent } from './PercentInput';
import { expectNoA11yViolations } from '../test/a11y';

const FormHarness: React.FC<{ initial?: number }> = ({ initial = 5 }) => {
  const [v, setV] = useState(initial);
  return <PercentInput id="growth" label="Growth" value={v} onChange={setV} />;
};

describe('PercentInput', () => {
  it('form variant: label is associated with input', () => {
    render(<FormHarness initial={7.5} />);
    const input = screen.getByLabelText('Growth') as HTMLInputElement;
    expect(input.value).toBe('7.5');
    expect(input).toHaveAttribute('inputMode', 'decimal');
  });

  it('cell variant: aria-label provides the accessible name', () => {
    render(
      <PercentInput
        variant="cell"
        ariaLabel="row-1-growth"
        value={3}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText('row-1-growth')).toBeInTheDocument();
  });

  it('renders at the text-sm page baseline (font-size regression guard)', () => {
    // Without `text-sm` the input fell back to the 16px browser
    // default while page text is 14px. jsdom cannot measure computed
    // px, so the class is the contract.
    render(
      <PercentInput
        variant="cell"
        ariaLabel="row-1-growth"
        value={3}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText('row-1-growth')).toHaveClass('text-sm');
  });

  it('form variant: no a11y violations', async () => {
    const { container } = render(<FormHarness />);
    await expectNoA11yViolations(container);
  });

  it('cell variant: no a11y violations', async () => {
    const { container } = render(
      <PercentInput
        variant="cell"
        ariaLabel="row-1-growth"
        value={3}
        onChange={() => undefined}
      />,
    );
    await expectNoA11yViolations(container);
  });
});

describe('formatPercent', () => {
  it('appends the % suffix to a positive one-decimal value', () => {
    expect(formatPercent(7.5)).toBe('7.5%');
  });

  it('forces one decimal place on a whole number', () => {
    expect(formatPercent(7)).toBe('7.0%');
  });

  it('formats zero with one decimal', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('formats a negative value with one decimal', () => {
    expect(formatPercent(-2.5)).toBe('-2.5%');
  });
});
