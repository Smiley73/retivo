/**
 * Member + years + months age picker shared by the Expense and Income
 * forms wherever a `ScheduleStart.age` / `ScheduleEnd.age` anchor is
 * being edited.
 *
 * Renders:
 *   [member-select?]  [years input]  years  [months input]  months
 *
 * The member dropdown is hidden when only one member is present in the
 * household (or `members` is empty / omitted) — in that case the
 * `memberId` becomes implicit and the caller decides what role to
 * persist (or omit the field entirely).
 */
import React from 'react';
import type { Aggregate, HouseholdMemberPayload, HouseholdRole } from '../db/types';
import { parseClampedInt } from '../lib/parse-input';
import { ageSliderBounds } from '../lib/age-anchor-bounds';
import { Select } from './Select';
import { TextInput } from './TextInput';
import { RangeSlider } from './RangeSlider';

// Control boundary uses the dedicated `input-line` token — a
// load-bearing boundary, AA-safe non-text (WCAG 1.4.11 ≥ 3.0);
// registered in contrast.ts. Dark mode is the `.dark` variable swap.
//
// Exported so every inline schedule number input (the expense Start/End
// "In year", the income pickers, the glide anchor pickers) shares this
// EXACT control vocabulary — crucially WITHOUT `block w-full`, which
// would otherwise override the fixed `w-16` width and stretch the field
// to the column. The "At age […] yrs" input is the canonical width.
export const NUMBER_INPUT_CLASS =
  'rounded-md border border-input-line bg-surface px-2 py-1.5 ' +
  'text-ink ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

// Shared width for every schedule number field (age yrs/mo, year, N
// years, duration) so they line up identically across all the forms.
export const NUMBER_INPUT_WIDTH = 'w-16';

// Wrapper for an age/year anchor slider: fills the available width and a
// small left inset (`pl-2`) so the thumb at the minimum doesn't overlap
// the control to its left (e.g. the member dropdown).
export const ANCHOR_SLIDER_WRAP = 'min-w-0 flex-1 pl-2';

const CONTROL_CLASS = NUMBER_INPUT_CLASS;

const UNIT_CLASS = 'text-muted';

interface Props {
  /** All household members. When length < 2, the role dropdown is
   *  hidden. Pass `undefined` or `[]` to suppress the dropdown
   *  unconditionally (owner-implicit usage). */
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Currently selected role. Required when a dropdown can render;
   *  ignored when no dropdown is shown. */
  memberId?: HouseholdRole;
  years: number;
  months: number;
  onChange: (next: {
    memberId?: HouseholdRole;
    years: number;
    months: number;
  }) => void;
  /** Prefix used as the aria-label root, e.g. `"Start age"` →
   *  `"Start age years"` / `"Start age months"` / `"Start age member"`. */
  ariaPrefix: string;
  /**
   * Layout: `'below'` (default) keeps the legacy indented-under-the-radio
   * placement (`-mt-1 ml-6`); `'inline'` drops the indent so the control
   * sits on the same row as its radio (the Graphite Spectrum mockup's
   * "At age […] yrs" inline row).
   */
  inline?: boolean;
  /**
   * Disables every control (member select + years + months). The mockup
   * keeps each radio's inputs visible at all times and merely disables
   * those whose radio isn't selected, rather than hiding them.
   */
  disabled?: boolean;
  /**
   * Years-only mode: hides the months input (and its unit label) and
   * always emits `months: 0`. The expense Start/End age anchors model
   * full years only — months add noise that doesn't matter there.
   */
  yearsOnly?: boolean;
}

export const MemberAgeInput: React.FC<Props> = ({
  members,
  memberId,
  years,
  months,
  onChange,
  ariaPrefix,
  inline = false,
  disabled = false,
  yearsOnly = false,
}) => {
  const hasSecondary = !!members && members.some((m) => !m.payload.isPrimary);
  const showDropdown = hasSecondary;
  const bounds = ageSliderBounds(years, memberId, members);

  const primaryName =
    members?.find((m) => m.payload.isPrimary)?.payload.firstName?.trim() || 'Primary';
  const secondaryName =
    members?.find((m) => !m.payload.isPrimary)?.payload.firstName?.trim() || 'Secondary';

  return (
    <div
      className={
        inline
          ? 'flex min-w-0 items-center gap-2'
          : '-mt-1 ml-6 flex min-w-0 items-center gap-2'
      }
    >
      {showDropdown && (
        <Select
          ariaLabel={`${ariaPrefix} member`}
          value={memberId ?? 'primary'}
          disabled={disabled}
          onChange={(v) =>
            onChange({
              memberId: v as HouseholdRole,
              years,
              months: yearsOnly ? 0 : months,
            })
          }
          className="w-40 shrink-0"
          options={[
            { value: 'primary', label: primaryName },
            { value: 'secondary', label: secondaryName },
          ]}
        />
      )}
      <div className={ANCHOR_SLIDER_WRAP}>
        <RangeSlider
          ariaLabel={`${ariaPrefix} years`}
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={years}
          disabled={disabled}
          onChange={(v) =>
            onChange({ memberId, years: v, months: yearsOnly ? 0 : months })
          }
          formatValue={(v) => `${v}`}
          formatAriaValue={(v) => `${v} years`}
        />
      </div>
      {!yearsOnly && (
        <>
          <TextInput
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label={`${ariaPrefix} months`}
            disabled={disabled}
            className={`${CONTROL_CLASS} w-16 text-center`}
            value={String(months)}
            onChange={(e) =>
              onChange({
                memberId,
                years,
                months: parseClampedInt(e.target.value, 11),
              })
            }
          />
          <span className={UNIT_CLASS}>months</span>
        </>
      )}
    </div>
  );
};
