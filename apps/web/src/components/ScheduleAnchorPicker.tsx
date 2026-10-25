/**
 * Controlled radio-plus-input picker for the schedule-anchor vocabulary, collapsible by default; the Start pickers
 * delegate to it via `lib/schedule-anchor-bridge.ts`.
 */
import React from 'react';
import { RadioGroup } from 'react-aria-components';
import { RadioOption } from './RadioOption';
import { AnchorCard } from './AnchorCard';
import { LabelledGroup } from './LabelledGroup';
import { RangeSlider } from './RangeSlider';
import {
  NUMBER_INPUT_CLASS,
  NUMBER_INPUT_WIDTH,
  ANCHOR_SLIDER_WRAP,
} from './MemberAgeInput';
import { parseClampedInt } from '../lib/parse-input';
import { memberName } from '../lib/expense-glide-format';
import { describeGlideAnchor } from '../lib/schedule-format';
import { ageSliderBounds, yearSliderBounds } from '../lib/age-anchor-bounds';
import { Muted } from './Muted';
import { Select } from './Select';
import { TextInput } from './TextInput';
import type {
  Aggregate,
  GlideAnchor,
  HouseholdMemberPayload,
  HouseholdRole,
} from '../db/types';

interface Props {
  value: GlideAnchor;
  onChange: (next: GlideAnchor) => void;
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Enables the `durationFromExpenseStart` kind (glide only). */
  relativeKind?: boolean;
  /** Enables the `expenseEnd` kind, offered on the glide-end picker only. */
  expenseEndKind?: boolean;
  /** END-anchor mode: hides `retirementStart` so only `age | year` are offered. */
  hideRetirementStart?: boolean;
  /** Group header text, e.g. "Glide starts". */
  label: string;
  /** Disables the whole picker; the anchor card cannot expand. */
  disabled?: boolean;
  /**
   * Gates only the `age` member `<select>`; the `memberId` keep/omit policy lives in the bridge.
   */
  memberSelectable?: boolean;
  /**
   * `false` renders the body in the always-expanded `<LabelledGroup>` instead of the collapsible
   * `<AnchorCard>`.
   */
  collapsible?: boolean;
  /**
   * Overrides the `age` radio text, e.g. a personalized "At {primary}'s age". Defaults to
   * `'At age'`.
   */
  ageLabel?: React.ReactNode;
  /**
   * The `memberId` a freshly-switched `age` kind defaults to, so a secondary-owned stream anchors
   * to its owner.
   */
  defaultMemberId?: HouseholdRole;
  /** The `year` a freshly-switched `year` kind defaults to. Defaults to the current year. */
  defaultYear?: number;
  /**
   * Upper bound for the age / year sliders; an existing stored anchor above it still shows its real
   * value.
   */
  cap?: { age?: number; year?: number };
  /** Lower bound for the age / year sliders, the mirror of `cap`. */
  floor?: { age?: number; year?: number };
}

// Same class and width as the expense "At age" inputs; no `block w-full`, which would override the
// fixed width.
const CONTROL_CLASS = NUMBER_INPUT_CLASS;
const NUM_WIDTH = NUMBER_INPUT_WIDTH;

const DEFAULT_AGE_YEARS = 65;
const DEFAULT_DURATION_MONTHS = 0;
const DURATION_YEARS_MAX = 100;
const MONTHS_MAX = 11;
const MONTHS_PER_YEAR = 12;

function defaultForKind(
  kind: GlideAnchor['kind'],
  defaults: { memberId: HouseholdRole; year: number },
  floor?: { age?: number; year?: number },
): GlideAnchor {
  switch (kind) {
    case 'retirementStart':
      return { kind: 'retirementStart' };
    case 'age':
      return {
        kind: 'age',
        memberId: defaults.memberId,
        // A finite floor raises the seed so a freshly-switched anchor cannot start below the
        // picker's lower bound.
        years: Number.isFinite(floor?.age)
          ? Math.max(DEFAULT_AGE_YEARS, floor?.age as number)
          : DEFAULT_AGE_YEARS,
        months: 0,
      };
    case 'year':
      return {
        kind: 'year',
        year: Number.isFinite(floor?.year)
          ? Math.max(defaults.year, floor?.year as number)
          : defaults.year,
      };
    case 'durationFromExpenseStart':
      return {
        kind: 'durationFromExpenseStart',
        months: DEFAULT_DURATION_MONTHS,
      };
    case 'expenseEnd':
      return { kind: 'expenseEnd' };
  }
}

export const ScheduleAnchorPicker: React.FC<Props> = ({
  value,
  onChange,
  members,
  relativeKind = false,
  expenseEndKind = false,
  hideRetirementStart = false,
  label,
  disabled = false,
  memberSelectable = true,
  collapsible = true,
  ageLabel = 'At age',
  defaultMemberId = 'primary',
  defaultYear = new Date().getFullYear(),
  cap,
  floor,
}) => {
  // The member select renders only when a secondary member exists and the caller allows it.
  const hasSecondary = !!members && members.some((m) => !m.payload.isPrimary);
  const showMemberSelect = memberSelectable && hasSecondary;
  const select = (kind: GlideAnchor['kind']) => {
    if (value.kind === kind) return;
    onChange(
      defaultForKind(kind, { memberId: defaultMemberId, year: defaultYear }, floor),
    );
  };

  // Every radio's input stays visible; inputs of inactive kinds are disabled, showing a default
  // placeholder.
  const ageActive = value.kind === 'age';
  const yearActive = value.kind === 'year';
  const durationActive = value.kind === 'durationFromExpenseStart';
  const ageMember = ageActive ? (value.memberId ?? 'primary') : 'primary';
  const ageYears = ageActive ? value.years : DEFAULT_AGE_YEARS;
  const yearValue = yearActive ? value.year : new Date().getFullYear();
  const durationMonths = durationActive ? value.months : DEFAULT_DURATION_MONTHS;

  const ageBounds = ageSliderBounds(
    ageYears,
    ageMember,
    members,
    undefined,
    cap?.age,
    floor?.age,
  );
  const yrBounds = yearSliderBounds(
    yearValue,
    members,
    undefined,
    cap?.year,
    floor?.year,
  );

  // Heading id for the non-collapsible `<LabelledGroup>`; the collapsible path labels the
  // RadioGroup with `aria-label`.
  const groupHeadingId = React.useId();

  const body = (
    <RadioGroup
      aria-label={collapsible ? label : undefined}
      aria-labelledby={collapsible ? undefined : groupHeadingId}
      value={value.kind}
      onChange={(v) => select(v as GlideAnchor['kind'])}
      isDisabled={disabled}
      className="anchor-grid items-center gap-x-3 gap-y-3"
    >
        {!hideRetirementStart && (
          <RadioOption value="retirementStart" className="col-span-2">
            Start of retirement
          </RadioOption>
        )}

        {/* Controls sit beside the RadioOption, not inside its label, which would toggle on
            click. */}
        <RadioOption value="age">{ageLabel}</RadioOption>
        <div className="flex min-w-0 items-center gap-2">
          {showMemberSelect && (
            <Select
              ariaLabel={`${label} age member`}
              value={ageMember}
              disabled={disabled || !ageActive}
              onChange={(v) =>
                onChange({
                  kind: 'age',
                  memberId: v as HouseholdRole,
                  years: ageYears,
                  months: 0,
                })
              }
              className="w-40 flex-shrink-0"
              options={[
                { value: 'primary', label: memberName('primary', members) },
                { value: 'secondary', label: memberName('secondary', members) },
              ]}
            />
          )}
          <div className={ANCHOR_SLIDER_WRAP}>
            <RangeSlider
              ariaLabel={`${label} age years`}
              min={ageBounds.min}
              max={ageBounds.max}
              step={1}
              value={ageYears}
              disabled={disabled || !ageActive}
              onChange={(v) =>
                onChange({ kind: 'age', memberId: ageMember, years: v, months: 0 })
              }
              formatValue={(v) => `${v}`}
              formatAriaValue={(v) => `${v} years`}
            />
          </div>
        </div>

        <RadioOption value="year">In year</RadioOption>
        <div className={ANCHOR_SLIDER_WRAP}>
          <RangeSlider
            ariaLabel={`${label} year`}
            min={yrBounds.min}
            max={yrBounds.max}
            step={1}
            value={yearValue}
            disabled={disabled || !yearActive}
            onChange={(v) => onChange({ kind: 'year', year: v })}
            formatValue={(v) => `${v}`}
          />
        </div>

        {relativeKind && (
          <>
            <RadioOption value="durationFromExpenseStart">After</RadioOption>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <TextInput
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label={`${label} years after expense start`}
                disabled={disabled || !durationActive}
                className={`${CONTROL_CLASS} ${NUM_WIDTH} text-center`}
                value={String(Math.floor(durationMonths / MONTHS_PER_YEAR))}
                onChange={(e) =>
                  onChange({
                    kind: 'durationFromExpenseStart',
                    months:
                      parseClampedInt(e.target.value, DURATION_YEARS_MAX) *
                        MONTHS_PER_YEAR +
                      (durationMonths % MONTHS_PER_YEAR),
                  })
                }
              />
              <Muted>years</Muted>
              <TextInput
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label={`${label} months after expense start`}
                disabled={disabled || !durationActive}
                className={`${CONTROL_CLASS} ${NUM_WIDTH} text-center`}
                value={String(durationMonths % MONTHS_PER_YEAR)}
                onChange={(e) =>
                  onChange({
                    kind: 'durationFromExpenseStart',
                    months:
                      Math.floor(durationMonths / MONTHS_PER_YEAR) *
                        MONTHS_PER_YEAR +
                      parseClampedInt(e.target.value, MONTHS_MAX),
                  })
                }
              />
              <Muted>months</Muted>
            </div>
          </>
        )}

        {expenseEndKind && (
          <RadioOption value="expenseEnd" className="col-span-2">
            When this expense ends
          </RadioOption>
        )}
    </RadioGroup>
  );

  if (!collapsible) {
    return (
      <LabelledGroup id={groupHeadingId} heading={label}>
        {body}
      </LabelledGroup>
    );
  }
  return (
    <AnchorCard
      label={label}
      summary={describeGlideAnchor(value, members)}
      disabled={disabled}
    >
      {body}
    </AnchorCard>
  );
};
