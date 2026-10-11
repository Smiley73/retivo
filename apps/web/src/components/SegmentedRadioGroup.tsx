/**
 * Shared 2+-option segmented control — a single pill that is a real
 * WAI-ARIA `radiogroup`. Built on React Aria's `RadioGroup`/`Radio`.
 *
 * React Aria owns the full radio keyboard pattern by construction:
 *   - one tab stop (roving `tabIndex`), only the checked option is in
 *     the Tab order;
 *   - Arrow keys move AND select (selection-follows-focus), wrapping at
 *     both ends; Home/End jump to the ends;
 *   - Space/Enter/click select.
 *
 * The visual style is the Graphite Spectrum semantic-token system (lime
 * accent fill for the checked option); the
 * framework-independent behavioral contract (radiogroup + radio roles,
 * accessible group name, keyboard nav) holds. A
 * Playwright keyboard/focus e2e covers this component at
 * `BalanceProjectionPage` (apps/web/e2e/balance-projection-radiogroup).
 */
import React from 'react';
import { Radio, RadioGroup } from 'react-aria-components';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional native tooltip on the option. */
  title?: string;
  /**
   * Optional leading glyph rendered before the label (the Graphite
   * Spectrum `.seg button svg` affordance — e.g. the Preferences theme
   * picker's sun / moon / monitor). Must be decorative
   * (`aria-hidden`) — the option's accessible name stays the `label`.
   */
  icon?: React.ReactNode;
}

interface Props<T extends string> {
  /** Accessible group name announced by assistive tech. */
  ariaLabel: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * When true, the whole radio group is non-interactive (forwarded to
   * React Aria's `isDisabled`). Project convention exposes a `disabled`
   * prop (HTML idiom) on the wrapper; React Aria's `isDisabled` is the
   * internal target — same pattern as `<Select>` / `<RangeSlider>` /
   * `<ToggleSwitch>`.
   */
  disabled?: boolean;
  /**
   * Option sizing. `'md'` (default) is the standard control size used in
   * page headers. `'sm'` matches the compact `btnSecondarySmClass`
   * row-action buttons (`px-2.5 py-1 text-xs`) so the control sits flush
   * beside small buttons — e.g. the Expenses chart-card tab strip.
   */
  size?: 'sm' | 'md';
}

// Checked option: the pine `accent` fill with the white `accent-ink`
// label (7.06:1 both themes — the deep pine takes a white label). Dark
// mode is the same tokens re-pointed by the `.dark` variable swap; no
// `dark:` twins. Registered "primary button label on accent" in
// contrast.ts. Sizing is split out (SIZE_CLASS) so a `'sm'` group matches
// the compact `btnSecondarySmClass` buttons.
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
          {/* React Aria's `Radio` typing doesn't surface the native
              `title` global attribute; render the optional hover
              tooltip on a span around the label so the behavioral
              contract (native tooltip on the option) is preserved.
              An optional leading icon rides in an inline-flex wrapper
              (mock `.seg button` gap:6px); the icon must be decorative
              so the accessible name stays the label text alone. */}
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
