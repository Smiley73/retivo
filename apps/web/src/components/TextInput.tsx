/**
 * Typed React Aria `TextField` / `Input` replacing raw `<input>`, forwarding native controlled-input props. Numeric
 * inputs stay `type="text"` + `inputMode` ("Form controls" in docs/ui-conventions.md).
 */
import React from 'react';
import { Input, Label, TextField } from 'react-aria-components';

type NativeInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export interface TextInputProps
  extends Omit<NativeInputProps, 'size'> {
  /** Visible label wired to the input by RA; omit when the caller or a `<Field>` owns the label. */
  label?: React.ReactNode;
  /** Layout-only classes on the `TextField` wrapper; visual classes go on `className`. */
  wrapperClassName?: string;
  labelClassName?: string;
}

const DEFAULT_LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

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
      // The wrapper stays presentational; the input below is the controlled element.
    >
      {label != null && label !== '' && (
        <Label className={labelClassName ?? DEFAULT_LABEL_CLASS}>{label}</Label>
      )}
      {/* Prepended so a caller class still composes. */}
      <Input
        className={`text-sm ${className ?? ''}`}
        disabled={disabled}
        {...inputProps}
      />
    </TextField>
  );
};
