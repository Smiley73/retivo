/**
 * Shared single-line text/number entry — the typed React Aria
 * replacement for the remaining raw `<input>` elements across pages and
 * composite pickers. Every plain
 * text/email/password/numeric input uses React Aria
 * `TextField`/`Input` so the whole app sits on one AT-tested primitive
 * foundation.
 *
 * The public API is intentionally a **near drop-in for the native
 * element it replaces** — it forwards the standard controlled-input
 * props (`value`, `onChange` as a native change event, `type`, `name`,
 * `id`, `autoComplete`, `required`, `placeholder`, `inputMode`,
 * `pattern`, `aria-label`, `maxLength`, `autoFocus`, `onBlur`,
 * `disabled`, `className`) straight onto the React Aria `<Input>`, so
 * call sites swap `<input …/>` → `<TextInput …/>` with **no handler or
 * logic change** (`onChange={(e) => …e.target.value}` keeps working).
 * Numeric inputs stay `type="text"` + `inputMode` (RA `TextField` is
 * spinner-less by construction — the no-`type=number` rule
 * holds ("Form controls" in docs/ui-conventions.md): identical input height every paint;
 * strip/clamp stays in the caller's change handler exactly as before).
 *
 * An optional `label` renders a React Aria `<Label>` (wired to the
 * input by RA); omit it for bare inputs whose label/aria-label is
 * supplied by the caller or a surrounding `<Field>` / `<label htmlFor>`.
 */
import React from 'react';
import { Input, Label, TextField } from 'react-aria-components';

type NativeInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export interface TextInputProps
  extends Omit<NativeInputProps, 'size'> {
  /** Optional visible label rendered as a React Aria `<Label>` wired to
   *  the input. Omit for bare inputs (caller / `<Field>` owns the
   *  label). */
  label?: React.ReactNode;
  /** Layout-only classes on the React Aria `TextField` wrapper (the
   *  outer element). The visual input classes go on `className`. */
  wrapperClassName?: string;
  /** Class for the React Aria `<Label>` when `label` is supplied. */
  labelClassName?: string;
}

const DEFAULT_LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

/**
 * RA `TextField` owns the input↔label↔aria wiring; the native
 * controlled props (`value`/`onChange`/`type`/…) pass straight through
 * to RA's `<Input>` (a real `<input>`), so behavior is byte-identical
 * to the prior raw element and the value contract is frozen.
 */
export const TextInput: React.FC<TextInputProps> = ({
  label,
  wrapperClassName,
  labelClassName,
  disabled,
  className,
  ...inputProps
}) => {
  return (
    <TextField
      isDisabled={disabled}
      className={wrapperClassName}
      // RA `TextField` would otherwise also try to own the value; the
      // input below is the controlled element (frozen native contract),
      // so the wrapper stays presentational only.
    >
      {label != null && label !== '' && (
        <Label className={labelClassName ?? DEFAULT_LABEL_CLASS}>{label}</Label>
      )}
      {/* Base `text-sm` sizes the input to the 14px page baseline
          (Field labels / tables / Muted). Prepended so a caller class
          still composes (and a future caller size class would win). */}
      <Input
        className={`text-sm ${className ?? ''}`}
        disabled={disabled}
        {...inputProps}
      />
    </TextField>
  );
};
