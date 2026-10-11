/**
 * Shared currency input — single source of truth for money entry.
 *
 * Two variants share parsing/format/focus behavior:
 *  - `form` (default): wraps in a labelled field. Used in edit dialogs
 *    and full-page forms.
 *  - `cell`: bare input, right-aligned, `aria-label` only. Used inside
 *    `<td>` cells in editable tables.
 *
 * Built on React Aria's `TextField` / `Input`. RA
 * `TextField` is spinner-less by construction (a text field, no
 * stepper buttons — the input keeps the same height every paint, per
 * "Form controls" in docs/ui-conventions.md) and keeps `inputMode="decimal"`. The public API
 * and the BEHAVIORAL CONTRACT are FROZEN byte-for-byte (consumers
 * untouched): positive-only / negative-opt-in `pattern`, strip
 * `$`/`,`, parse via `parseCurrencyInput`, raw value on focus,
 * `toFixed(2)` on blur, right-aligned, `min-w-0` flex-shrink guard.
 */
import React, { useEffect, useState } from 'react';
import { Input, Label, Text, TextField } from 'react-aria-components';

export function parseCurrencyInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

// Control boundary uses the dedicated `input-line` token — a load-bearing
// boundary, AA-safe non-text (WCAG 1.4.11 ≥ 3.0), registered in
// contrast.ts. Dark mode is the `.dark` variable swap.
const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  // `text-sm` matches the 14px page baseline (Field labels / tables).
  // `font-mono`: the Tabular-Money Rule — the entered amount sits in editable
  // table columns beside read-only mono cells, so it renders in JetBrains Mono
  // too (see "Typography" in docs/ui-conventions.md).
  'text-right text-sm font-mono tabular-nums text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

const LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

interface BaseProps {
  value: number;
  onChange: (next: number) => void;
  /** Fired on blur after the display re-formats — lets callers commit a draft
   *  edit once per edit (blur-commit) rather than on every keystroke. */
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
  /** Optional help text rendered under the control. React Aria wires it as the
   *  field's `aria-describedby`, so a screen reader announces it with the label
   *  — a bare sibling paragraph would not be announced at all. */
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

  // React Aria's <TextField> owns the labelled-input wiring (the bare
  // `cell` form uses aria-label). `inputMode="decimal"` + `pattern`
  // ride on the RA <Input> exactly as on the prior native input; the
  // value is fully controlled by `display`, so parse/format/blur is
  // byte-identical to the prior build.
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
