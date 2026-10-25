/**
 * Segmented control that is a real `radiogroup` on React Aria `RadioGroup` / `Radio`; the keyboard pattern comes from
 * RA. See "Form controls" in docs/ui-conventions.md.
 */
import React from 'react';
import { Radio, RadioGroup } from 'react-aria-components';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  /**
   * Leading glyph before the label; decorative (`aria-hidden`), the accessible name stays the
   * label.
   */
  icon?: React.ReactNode;
}

interface Props<T extends string> {
  ariaLabel: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** `'sm'` matches the compact `btnSecondarySmClass` buttons; default `'md'`. */
  size?: 'sm' | 'md';
}

const OPTION_BASE_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.seg button` mock radius (7px); the data-[*] are variant selectors and shadow uses the allowed `-[var(--*)]` glow token
  'cursor-pointer rounded-[7px] font-semibold text-ink transition-colors ' +
  'hover:bg-surface-sunken data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring ' +
  'data-[selected]:bg-accent data-[selected]:text-accent-ink data-[selected]:shadow-[var(--gs-accent-glow)]';

const SIZE_CLASS: Record<'sm' | 'md', string> = {
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.seg button` mock metrics (15px x 8px pad / 13.5px label)
  md: 'px-[15px] py-2 text-[13.5px]',
  // eslint-disable-next-line no-restricted-syntax -- proportional compact `sm` radius (6px) tracking the mock's 7px md radius
  sm: 'rounded-[6px] px-3 py-1.5 text-xs',
};

export function SegmentedRadioGroup<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  disabled,
  size = 'md',
}: Props<T>): React.ReactElement {
  const optionClass = `${OPTION_BASE_CLASS} ${SIZE_CLASS[size]}`;
  return (
    <RadioGroup
      value={value}
      onChange={(next) => onChange(next as T)}
      aria-label={ariaLabel}
      orientation="horizontal"
      isDisabled={disabled}
      // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum `.seg` track mock geometry (10px radius / 3px pad + gap); data-[disabled] are variant selectors
      className="inline-flex gap-[3px] rounded-[10px] border border-line bg-surface-sunken p-[3px] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55"
    >
      {options.map((opt) => (
        <Radio key={opt.value} value={opt.value} className={optionClass}>
          {/* RA's `Radio` typing does not surface the native `title` attribute, so the tooltip
              goes on a span around the label. */}
          {opt.icon ? (
            <span className="inline-flex items-center gap-1.5" title={opt.title}>
              <span aria-hidden="true" className="inline-flex">
                {opt.icon}
              </span>
              {opt.label}
            </span>
          ) : opt.title ? (
            <span title={opt.title}>{opt.label}</span>
          ) : (
            opt.label
          )}
        </Radio>
      ))}
    </RadioGroup>
  );
}
