/**
 * TextInput — shared React Aria text/number input.
 * Asserts the frozen, native-`<input>`-equivalent contract: a controlled
 * value reflected on the element, native change/blur events firing with
 * the typed value (call sites keep `e.target.value`), `type`/`inputMode`
 * /`pattern`/`disabled` pass-through, the optional RA `<Label>` wiring,
 * and the shared-component axe rule (AGENTS mandate). RA `<Input>` is a
 * real `<input>`, so `fireEvent` drives it faithfully (the userEvent
 * requirement is for RA press/key primitives — Switch/Select/Slider —
 * not text inputs; consistent with MoneyInput.test).
 */
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
    // No native number spinner — it is a text input by construction.
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
    // The original bug: the input set no `text-*` so it fell back to
    // the 16px browser default while page text is 14px. jsdom cannot
    // measure computed px, so the class is the contract.
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
    // The password-manager opt-out attributes (PM_IGNORE_ATTRS in
    // components/password-manager.tsx) are spread onto TextInput and must
    // land on the real <input> — locks RA Input's data-attr passthrough.
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
