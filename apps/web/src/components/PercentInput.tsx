/**
 * Shared percentage input on React Aria `TextField`; focus shows the raw value, blur re-formats to `decimals`
 * (default 1), and change clamps to `[min, max]`. Read-only `%` strings use `formatPercent()`.
 */
import React, { useEffect, useState } from 'react';
import { Input, Label, TextField } from 'react-aria-components';

const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  // `font-mono` so the input matches read-only mono cells beside it ("Typography" in
  // docs/ui-conventions.md).
  'text-right text-sm font-mono tabular-nums text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

const LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

function parsePercentInput(raw: string): number | null {
  const cleaned = raw.replace(/[%,\s]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

const DEFAULT_PERCENT_DECIMALS = 1;

export function formatPercentDisplay(
  n: number,
  decimals: number = DEFAULT_PERCENT_DECIMALS,
): string {
  return n.toFixed(decimals);
}

/**
 * Formats read-only percent strings with the app-wide precision, so `7%` never sits beside `7.0%`.
 */
export function formatPercent(n: number): string {
  return `${formatPercentDisplay(n)}%`;
}

interface BaseProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Allow negative values; defaults to `false`. */
  allowNegative?: boolean;
  /** Inclusive minimum after parse; defaults to `-100` when negatives are allowed, else `0`. */
  min?: number;
  /** Inclusive maximum after parse; defaults to `1000`. */
  max?: number;
  placeholder?: string;
  /** Inline style on the `<input>`, for sentence-embedded inputs needing a fixed width. */
  inputStyle?: React.CSSProperties;
  /**
   * Decimals the blurred display re-formats to; default 1. Raise only where extra digits are
   * material, e.g. basis points.
   */
  decimals?: number;
}

interface FormVariantProps extends BaseProps {
  variant?: 'form';
  id: string;
  label?: string;
  /** Render bare, without the `.field` wrapper. */
  unwrapped?: boolean;
  ariaLabel?: string;
}

interface CellVariantProps extends BaseProps {
  variant: 'cell';
  ariaLabel: string;
}

export type PercentInputProps = FormVariantProps | CellVariantProps;

export const PercentInput: React.FC<PercentInputProps> = (props) => {
  const { value, onChange, disabled } = props;
  const isCell = props.variant === 'cell';
  const allowNegative = props.allowNegative ?? false;
  const min = props.min ?? (allowNegative ? -100 : 0);
  const max = props.max ?? 1000;
  const decimals = props.decimals ?? DEFAULT_PERCENT_DECIMALS;

  const [display, setDisplay] = useState(formatPercentDisplay(value, decimals));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setDisplay(formatPercentDisplay(value, decimals));
  }, [value, isFocused, decimals]);

  const pattern = allowNegative ? '-?[0-9]*[.,]?[0-9]*' : '[0-9]*[.,]?[0-9]*';

  const handleChange = (raw: string): void => {
    setDisplay(raw);
    const cleaned = raw.replace(/[%,\s]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') {
      onChange(0);
      return;
    }
    const parsed = parsePercentInput(raw);
    if (parsed === null) return;
    if (!allowNegative && parsed < 0) return;
    const clamped = Math.max(min, Math.min(max, parsed));
    onChange(clamped);
  };

  const formProps = props as FormVariantProps;
  const ariaLabel = isCell
    ? (props as CellVariantProps).ariaLabel
    : formProps.ariaLabel;
  // Bare renders only the RA input; the wrapped form renders its own <Label>.
  const bare = isCell || formProps.unwrapped;

  return (
    <TextField
      value={display}
      onChange={handleChange}
      isDisabled={disabled}
      aria-label={ariaLabel}
      className={bare ? undefined : 'mb-3 min-w-0 flex-1'}
    >
      {!bare && formProps.label && (
        <Label className={LABEL_CLASS}>{formProps.label}</Label>
      )}
      <Input
        id={isCell ? undefined : formProps.id}
        inputMode="decimal"
        pattern={pattern}
        placeholder={props.placeholder}
        className={INPUT_CLASS}
        // eslint-disable-next-line no-restricted-syntax -- runtime caller-supplied inline width/centering for sentence-embedded percent inputs (frozen API passthrough)
        style={!isCell && props.inputStyle ? props.inputStyle : undefined}
        onFocus={() => {
          setIsFocused(true);
          setDisplay(String(value));
        }}
        onBlur={() => {
          setIsFocused(false);
          setDisplay(formatPercentDisplay(value, decimals));
        }}
      />
    </TextField>
  );
};
