/** TextInput: the shared React Aria text input keeps a native-input-equivalent contract. */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TextInput } from './TextInput';
import { expectNoA11yViolations } from '../test/a11y';

describe('TextInput', () => {
  it('renders a labelled, controlled input reflecting its value', () => {
    render(
      <TextInput
        id="name"
        label="Name"
        value="Ada"
        onChange={() => undefined}
      />,
    );
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(input).toHaveValue('Ada');
    expect(input.id).toBe('name');
  });

  it('fires native onChange with the typed value (e.target.value contract)', () => {
    const Harness: React.FC = () => {
      const [v, setV] = useState('');
      return (
        <TextInput
          id="email"
          label="Email"
          type="email"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      );
    };
    render(<Harness />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a@b.test' } });
    expect(input).toHaveValue('a@b.test');
    expect(input.type).toBe('email');
  });

  it('passes inputMode / pattern through for spinner-less numeric entry', () => {
    render(
      <TextInput
        aria-label="Years"
        inputMode="numeric"
        pattern="[0-9]*"
        value="65"
        onChange={() => undefined}
      />,
    );
    const input = screen.getByLabelText('Years');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('pattern', '[0-9]*');
    expect(input).not.toHaveAttribute('type', 'number');
  });

  it('fires onBlur (formatter-on-blur callers keep working)', () => {
    const onBlur = vi.fn();
    render(
      <TextInput
        aria-label="Amount"
        value="1"
        onChange={() => undefined}
        onBlur={onBlur}
      />,
    );
    fireEvent.blur(screen.getByLabelText('Amount'));
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('renders at the text-sm page baseline (font-size regression guard)', () => {
    // jsdom cannot measure computed px, so the class is the contract for matching the page text size.
    render(
      <TextInput aria-label="Sized" value="" onChange={() => undefined} />,
    );
    expect(screen.getByLabelText('Sized')).toHaveClass('text-sm');
  });

  it('keeps a caller className composed alongside the base size', () => {
    render(
      <TextInput
        aria-label="Composed"
        className="w-16 text-center"
        value=""
        onChange={() => undefined}
      />,
    );
    const input = screen.getByLabelText('Composed');
    expect(input).toHaveClass('text-sm');
    expect(input).toHaveClass('w-16');
    expect(input).toHaveClass('text-center');
  });

  it('honours disabled', () => {
    render(
      <TextInput
        aria-label="Locked"
        value="x"
        onChange={() => undefined}
        disabled
      />,
    );
    expect(screen.getByLabelText('Locked')).toBeDisabled();
  });

  it('forwards data-* attributes to the rendered input (PM_IGNORE_ATTRS contract)', () => {
    render(
      <TextInput
        aria-label="Secret"
        value=""
        onChange={() => undefined}
        data-1p-ignore
        data-lpignore="true"
      />,
    );
    const input = screen.getByLabelText('Secret');
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
  });

  it('has no a11y violations (labelled and bare)', async () => {
    const { container } = render(
      <>
        <TextInput id="n" label="Full name" value="" onChange={() => undefined} />
        <TextInput aria-label="Search" value="" onChange={() => undefined} />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});
