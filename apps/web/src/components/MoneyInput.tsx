/**
 * Shared currency input on React Aria `TextField` with `form` and `cell` variants: focus shows the raw value, blur
 * re-formats to `decimals`. Spinner-less ("Form controls" in docs/ui-conventions.md).
 */
import React, { useEffect, useState } from 'react';
import { Input, Label, Text, TextField } from 'react-aria-components';

export function parseCurrencyInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  // `font-mono` so the amount matches read-only mono cells beside it ("Typography" in
  // docs/ui-conventions.md).
  'text-right text-sm font-mono tabular-nums text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

const LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

interface BaseProps {
  value: number;
  onChange: (next: number) => void;
  /** Fired on blur after the display re-formats, so callers can commit a draft once per edit. */
  onBlur?: () => void;
  disabled?: boolean;
  /** Allow negative values. Defaults to `true` for `form`, `false` for `cell`. */
  allowNegative?: boolean;
  /** Decimal places shown and accepted. Defaults to 2. Pass 0 for whole-dollar inputs. */
  decimals?: number;
}

interface FormVariantProps extends BaseProps {
  variant?: 'form';
  id: string;
  label: string;
  /**
   * Help text wired as the field's `aria-describedby`; a bare sibling paragraph would not be
   * announced.
   */
  description?: React.ReactNode;
}

interface CellVariantProps extends BaseProps {
  variant: 'cell';
  ariaLabel: string;
}

export type MoneyInputProps = FormVariantProps | CellVariantProps;

export const MoneyInput: React.FC<MoneyInputProps> = (props) => {
  const { value, onChange, disabled } = props;
  const isCell = props.variant === 'cell';
  const allowNegative = props.allowNegative ?? !isCell;
  const dp = props.decimals ?? 2;

  const [display, setDisplay] = useState(value.toFixed(dp));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setDisplay(value.toFixed(dp));
  }, [value, isFocused, dp]);

  const pattern = dp === 0
    ? (allowNegative ? '-?[0-9]*' : '[0-9]*')
    : (allowNegative ? '-?[0-9]*[.,]?[0-9]*' : '[0-9]*[.,]?[0-9]*');

  const handleChange = (raw: string): void => {
    setDisplay(raw);
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-') {
      onChange(0);
      return;
    }
    const parsed = parseCurrencyInput(raw);
    if (parsed === null) return;
    if (!allowNegative && parsed < 0) return;
    onChange(dp === 0 ? Math.round(parsed) : parsed);
  };

  // RA `<TextField>` owns the labelled-input wiring; the value is fully controlled by `display`.
  const field = (
    <TextField
      value={display}
      onChange={handleChange}
      isDisabled={disabled}
      aria-label={isCell ? (props as CellVariantProps).ariaLabel : undefined}
      className={isCell ? undefined : 'mb-3 min-w-0 flex-1'}
    >
      {!isCell && (
        <Label className={LABEL_CLASS}>
          {(props as FormVariantProps).label}
        </Label>
      )}
      <Input
        id={isCell ? undefined : (props as FormVariantProps).id}
        inputMode={dp === 0 ? 'numeric' : 'decimal'}
        pattern={pattern}
        className={INPUT_CLASS}
        onFocus={() => {
          setIsFocused(true);
          setDisplay(dp === 0 ? String(Math.round(value)) : String(value));
        }}
        onBlur={() => {
          setIsFocused(false);
          setDisplay(value.toFixed(dp));
          props.onBlur?.();
        }}
      />
      {!isCell && (props as FormVariantProps).description !== undefined && (
        <Text slot="description" className="mt-1 block text-sm text-muted">
          {(props as FormVariantProps).description}
        </Text>
      )}
    </TextField>
  );

  return field;
};
