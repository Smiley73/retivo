/**
 * Member, years and months age picker for `ScheduleStart.age` / `ScheduleEnd.age` anchors; the member select is
 * hidden below two members.
 */
import React from 'react';
import type { Aggregate, HouseholdMemberPayload, HouseholdRole } from '../db/types';
import { parseClampedInt } from '../lib/parse-input';
import { ageSliderBounds } from '../lib/age-anchor-bounds';
import { Select } from './Select';
import { TextInput } from './TextInput';
import { RangeSlider } from './RangeSlider';

// Shared by every inline schedule number input; no `block w-full`, which would override the fixed
// `w-16` width.
export const NUMBER_INPUT_CLASS =
  'rounded-md border border-input-line bg-surface px-2 py-1.5 ' +
  'text-ink ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

export const NUMBER_INPUT_WIDTH = 'w-16';

// Left inset keeps the thumb at the minimum from overlapping the control beside it.
export const ANCHOR_SLIDER_WRAP = 'min-w-0 flex-1 pl-2';

const CONTROL_CLASS = NUMBER_INPUT_CLASS;

const UNIT_CLASS = 'text-muted';

interface Props {
  /** Household members; the role dropdown is hidden when there are fewer than two. */
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Selected role; required when a dropdown can render. */
  memberId?: HouseholdRole;
  years: number;
  months: number;
  onChange: (next: {
    memberId?: HouseholdRole;
    years: number;
    months: number;
  }) => void;
  /** Aria-label root, e.g. `"Start age"` gives `"Start age years"`. */
  ariaPrefix: string;
  /**
   * `'inline'` drops the indent so the control sits on its radio's row; `'below'` (default) indents
   * under it.
   */
  inline?: boolean;
  /** Disables every control. */
  disabled?: boolean;
  /** Hides the months input and always emits `months: 0`. */
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
