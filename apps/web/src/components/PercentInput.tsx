/**
 * Shared percentage input — single source of truth for percent entry.
 *
 * Built on React Aria's `TextField` / `Input`. RA
 * `TextField` is spinner-less by construction and keeps
 * `inputMode="decimal"`; the public API and behavioral contract are
 * FROZEN (consumers untouched).
 *
 * Mirrors MoneyInput's focus/blur lifecycle:
 *  - Focus: replaces the formatted display with the raw `value` so the
 *    user can edit without fighting the formatter.
 *  - Blur: re-formats to one decimal place (e.g. `7.5`), or to the
 *    caller's `decimals` where a coarser reading would misstate the
 *    value.
 *  - Change: parses the raw input into a number; rejects characters
 *    outside `0-9.,-` and clamps to `[min, max]`.
 *
 * Default render is one decimal place. Read-only surfaces that render
 * a `%`-suffixed string use the canonical `formatPercent()` (exported
 * below); bare-numeric percent surfaces and `PercentInput`'s own
 * internals use `formatPercentDisplay()` (one decimal by default;
 * `PercentInput` forwards its optional `decimals` prop). Every current
 * caller passes 0 or leaves the default, so the app never shows `7%`
 * next to `7.0%`.
 */
import React, { useEffect, useState } from 'react';
import { Input, Label, TextField } from 'react-aria-components';

// Control boundary uses the dedicated `input-line` token — a load-bearing
// boundary, AA-safe non-text (WCAG 1.4.11 ≥ 3.0); registered in
// contrast.ts. Dark mode is the `.dark` variable swap.
const INPUT_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  // `text-sm` matches the 14px page baseline (Field labels / tables).
  // `font-mono`: the Tabular-Money Rule — the editable percent sits beside
  // read-only mono cells (Baseline % column), so it renders in JetBrains Mono
  // too (see "Typography" in docs/ui-conventions.md).
  'text-right text-sm font-mono tabular-nums text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

const LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

function parsePercentInput(raw: string): number | null {
  const cleaned = raw.replace(/[%,\s]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/** Default number of decimals a percent renders with, app-wide. */
const DEFAULT_PERCENT_DECIMALS = 1;

export function formatPercentDisplay(
  n: number,
  decimals: number = DEFAULT_PERCENT_DECIMALS,
): string {
  return n.toFixed(decimals);
}

/**
 * Canonical helper for new / edited read-only `%`-suffixed percent
 * strings: the one-decimal numeric display plus the `%` suffix
 * (e.g. `7.5%`), so the app never shows `7%` next to `7.0%`.
 * Sign/null-normalising callers wrap this thinly.
 */
export function formatPercent(n: number): string {
  return `${formatPercentDisplay(n)}%`;
}

interface BaseProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Allow negative values. Defaults to `false`; inflation/deflation
   *  callers opt in. */
  allowNegative?: boolean;
  /** Inclusive minimum after parse. Defaults to `-100` when negatives
   *  are allowed, `0` otherwise. */
  min?: number;
  /** Inclusive maximum after parse. Defaults to `1000` so unusual
   *  high-growth scenarios still work without surprising clamps. */
  max?: number;
  placeholder?: string;
  /** Inline style merged onto the underlying `<input>` element. Useful
   *  when the input is embedded inline in a sentence and needs a fixed
   *  width / centered text. */
  inputStyle?: React.CSSProperties;
  /** Decimal places the blurred display re-formats to. Defaults to 1 (the
   *  app-wide percent precision). Raise it only where the extra digits are
   *  materially different values rather than noise — e.g. a rate quoted in
   *  basis points, where 0.05% must not re-format to 0.1%. No current caller
   *  raises it; the annual investment cost that did was removed. */
  decimals?: number;
}

interface FormVariantProps extends BaseProps {
  variant?: 'form';
  id: string;
  label?: string;
  /** When true, render bare (no `.field` wrapper). Useful when the
   *  caller already supplies its own label/wrapper. */
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
  // Bare (cell / unwrapped) renders just the RA input; the wrapped
  // form renders its own <Label>. RA <TextField> owns the
  // input↔label↔aria wiring; the controlled `display` keeps
  // parse/format/blur byte-identical to the prior native build.
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
        // `inputStyle` stays a runtime-dynamic passthrough: inline
        // callers size/center the input inside a sentence (fixed
        // width). Static styling lives in INPUT_CLASS.
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
