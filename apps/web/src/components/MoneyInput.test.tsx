/** MoneyInput: parseCurrencyInput, the form and cell variants, focus/blur formatting, onChange and allowNegative. */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MoneyInput, parseCurrencyInput } from './MoneyInput';
import { expectNoA11yViolations } from '../test/a11y';

describe('parseCurrencyInput', () => {
  it('parses plain numbers', () => {
    expect(parseCurrencyInput('1000')).toBe(1000);
    expect(parseCurrencyInput('1234.56')).toBe(1234.56);
  });

  it('strips $ and commas', () => {
    expect(parseCurrencyInput('$1,234.56')).toBe(1234.56);
  });

  it('returns null for empty / non-numeric', () => {
    expect(parseCurrencyInput('')).toBeNull();
    expect(parseCurrencyInput('abc')).toBeNull();
  });

  it('keeps negative sign', () => {
    expect(parseCurrencyInput('-500')).toBe(-500);
  });
});

describe('MoneyInput form variant', () => {
  const FormHarness: React.FC<{ initial?: number }> = ({ initial = 0 }) => {
    const [v, setV] = useState(initial);
    return <MoneyInput id="amt" label="Amount" value={v} onChange={setV} />;
  };

  it('renders with label and formatted value when blurred', () => {
    render(<FormHarness initial={1234.5} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(input.value).toBe('1234.50');
  });

  it('shows raw value on focus, formats on blur', () => {
    render(<FormHarness initial={100} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.value).toBe('100');
    fireEvent.change(input, { target: { value: '250.5' } });
    fireEvent.blur(input);
    expect(input.value).toBe('250.50');
  });

  it('accepts negative values when allowNegative is default-true', () => {
    const onChange = vi.fn();
    render(<MoneyInput id="amt" label="Amount" value={0} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '-50' } });
    expect(onChange).toHaveBeenLastCalledWith(-50);
  });
});

describe('MoneyInput cell variant', () => {
  it('renders bare input (no label wrapper) with aria-label', () => {
    render(
      <MoneyInput
        variant="cell"
        ariaLabel="row-1-pre-tax"
        value={500}
        onChange={() => undefined}
      />,
    );
    const input = screen.getByLabelText('row-1-pre-tax') as HTMLInputElement;
    expect(input.value).toBe('500.00');
    expect(input).toHaveClass('text-right');
  });

  it('renders at the text-sm page baseline (font-size regression guard)', () => {
    // jsdom cannot measure computed px, so the class is the contract for matching the page text size.
    render(
      <MoneyInput
        variant="cell"
        ariaLabel="row-1-pre-tax"
        value={500}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText('row-1-pre-tax')).toHaveClass('text-sm');
  });

  it('rejects negative input by default in cell variant', () => {
    const onChange = vi.fn();
    render(
      <MoneyInput
        variant="cell"
        ariaLabel="row-1-pre-tax"
        value={0}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('row-1-pre-tax');
    fireEvent.change(input, { target: { value: '-50' } });
    expect(onChange).not.toHaveBeenCalledWith(-50);
  });

  it('treats empty input as 0', () => {
    const onChange = vi.fn();
    render(
      <MoneyInput
        variant="cell"
        ariaLabel="row-1-pre-tax"
        value={100}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('row-1-pre-tax');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('MoneyInput a11y (form variant)', () => {
  it('no a11y violations', async () => {
    const { container } = render(
      <MoneyInput id="amt" label="Amount" value={100} onChange={() => undefined} />,
    );
    await expectNoA11yViolations(container);
  });
});
