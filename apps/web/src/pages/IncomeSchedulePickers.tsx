/**
 * Schedule pickers + the shared `FormDraft` shape for the IncomeStream
 * form. Extracted from `IncomeFormPage` so that page stays under the
 * 400-line shape limit — the pickers + the draft type + the
 * start/end defaults & validators are a cohesive schedule sub-module
 * the page composes. One-directional import (IncomeFormPage →
 * IncomeSchedulePickers); no cycle.
 *
 * v1 form exposes a narrower subset of the partTime start/end
 * vocabulary; the data model still supports the full ScheduleStart /
 * ScheduleEnd discriminated unions.
 */
import React from 'react';
import { RadioGroup } from 'react-aria-components';
import { RadioOption } from '../components/RadioOption';
import {
  MemberAgeInput,
  NUMBER_INPUT_CLASS,
  ANCHOR_SLIDER_WRAP,
} from '../components/MemberAgeInput';
import { RangeSlider } from '../components/RangeSlider';
import { yearSliderBounds } from '../lib/age-anchor-bounds';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { parseClampedInt } from '../lib/parse-input';
import { Select } from '../components/Select';
import { TextInput } from '../components/TextInput';
import { LabelledGroup } from '../components/LabelledGroup';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import {
  scheduleStartToGlideAnchor,
  glideAnchorToScheduleStart,
} from '../lib/schedule-anchor-bridge';
import {
  type FormDraft,
  defaultEndForPartTime,
} from '../lib/income-form-draft';
import type {
  Aggregate,
  HouseholdMemberPayload,
  HouseholdRole,
  ScheduleEnd,
} from '../db/types';

/** Inline numeric text input — the control that sits on the same row as
 *  its radio (mockup "In year […]" inline pattern). Every row's input
 *  stays visible; the inputs whose radio isn't selected are disabled
 *  (not hidden). `type=text inputMode=numeric` (NOT `type=number` —
 *  AGENTS UI standards: no spinner layout jitter). */
const InlineNumberInput: React.FC<{
  ariaLabel: string;
  value: string;
  width: string;
  onValue: (raw: string) => void;
  disabled?: boolean;
  suffix?: React.ReactNode;
}> = ({ ariaLabel, value, width, onValue, disabled, suffix }) => (
  <>
    <TextInput
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${NUMBER_INPUT_CLASS} ${width} text-center`}
      value={value}
      onChange={(e) => onValue(e.target.value)}
    />
    {suffix}
  </>
);

interface SchedulePickerProps {
  draft: FormDraft;
  setDraft: (d: FormDraft) => void;
  members: Aggregate<HouseholdMemberPayload>[];
}

interface StartPickerProps extends SchedulePickerProps {
  /** Heading shown above the radio stack. */
  label: string;
  /** When true, the `age` kind exposes a member dropdown so partTime
   *  can anchor to the non-owner spouse. Annuity/lumpSum/oneOff hide it
   *  (owner-implicit). */
  showMemberPicker: boolean;
  /** The stream owner's role, used by the bridge to keep an
   *  owner-implicit `age.memberId` omitted. Derived in
   *  `IncomeFormPage` from the selected owner member. */
  ownerRole?: HouseholdRole;
}

/**
 * Income Start picker. Renders through the shared `ScheduleAnchorPicker`
 * (always-expanded — `collapsible={false}`); the `GlideAnchor ↔
 * ScheduleStart` conversion and the owner-implicit `memberId` policy live
 * in `lib/schedule-anchor-bridge.ts`. The member `<select>` is
 * gated to partTime via `memberSelectable={showMemberPicker}`.
 */
export const ScheduleStartPicker: React.FC<StartPickerProps> = ({
  draft,
  setDraft,
  members,
  label,
  showMemberPicker,
  ownerRole,
}) => (
  <ScheduleAnchorPicker
    collapsible={false}
    memberSelectable={showMemberPicker}
    label={label}
    members={members}
    // Switching to the `age` kind defaults to the stream owner (not a
    // hardcoded primary), and switching to the `year` kind defaults to
    // current year + 5 — matching the pre-shared income Start picker.
    defaultMemberId={ownerRole ?? 'primary'}
    defaultYear={new Date().getFullYear() + 5}
    value={scheduleStartToGlideAnchor(draft.start, { memberRole: ownerRole })}
    onChange={(anchor) =>
      setDraft({
        ...draft,
        start: glideAnchorToScheduleStart(anchor, {
          memberSelectable: showMemberPicker,
          ownerRole,
        }),
      })
    }
  />
);

export const ScheduleEndPicker: React.FC<SchedulePickerProps> = ({
  draft,
  setDraft,
  members,
}) => {
  const end = draft.end ?? defaultEndForPartTime();
  const setEnd = (e: ScheduleEnd): void => setDraft({ ...draft, end: e });
  const onKindChange = (kind: string): void => {
    if (end.kind === kind) return;
    if (kind === 'lifetime') setEnd({ kind: 'lifetime', whose: 'primary' });
    else if (kind === 'age')
      setEnd({ kind: 'age', years: 70, months: 0 });
    else if (kind === 'year')
      setEnd({ kind: 'year', year: new Date().getFullYear() + 10 });
    else if (kind === 'endOfRetirementYear')
      setEnd({ kind: 'endOfRetirementYear', offsetYears: 0 });
    else if (kind === 'durationFromStart')
      setEnd({ kind: 'durationFromStart', months: 60 });
  };
  const hasSecondary = members.some((m) => !m.payload.isPrimary);
  // Every radio's input stays visible — the inactive ones are disabled,
  // not hidden (matching the expense form). Show the live value when the
  // kind is active, else a sensible default while disabled.
  const lifetimeActive = end.kind === 'lifetime';
  const ageActive = end.kind === 'age';
  const yearActive = end.kind === 'year';
  const retYearsActive = end.kind === 'endOfRetirementYear';
  const durationActive = end.kind === 'durationFromStart';
  const lifetimeWhose = lifetimeActive ? end.whose : 'primary';
  const ageYears = ageActive ? end.years : 70;
  const ageMemberId = ageActive ? end.memberId : undefined;
  const yearValue = yearActive ? end.year : new Date().getFullYear() + 10;
  const retYears = retYearsActive ? end.offsetYears : 0;
  const durationEnd = durationActive
    ? end
    : ({ kind: 'durationFromStart', months: 60 } as Extract<
        ScheduleEnd,
        { kind: 'durationFromStart' }
      >);
  return (
    <LabelledGroup id="income-end-group-label" heading="End">
      {/* Alignment grid: radios in column 1, their inputs in column 2. */}
      <RadioGroup
        aria-labelledby="income-end-group-label"
        value={end.kind}
        onChange={onKindChange}
        className="anchor-grid items-center gap-x-3 gap-y-3"
      >
        <RadioOption value="lifetime">Until death</RadioOption>
        {hasSecondary ? (
          <Select
            ariaLabel="Whose lifetime"
            value={lifetimeWhose}
            disabled={!lifetimeActive}
            onChange={(v) =>
              setEnd({
                kind: 'lifetime',
                whose: v as HouseholdRole | 'last',
              })
            }
            className="w-40 flex-shrink-0"
            options={[
              {
                value: 'primary',
                label: `of ${members.find((m) => m.payload.isPrimary)?.payload.firstName?.trim() || 'Primary'}`,
              },
              {
                value: 'secondary',
                label: `of ${members.find((m) => !m.payload.isPrimary)?.payload.firstName?.trim() || 'Secondary'}`,
              },
              { value: 'last', label: 'of last surviving' },
            ]}
          />
        ) : (
          <span />
        )}

        <RadioOption value="age">At age</RadioOption>
        <MemberAgeInput
          inline
          yearsOnly
          disabled={!ageActive}
          members={members}
          memberId={ageMemberId}
          years={ageYears}
          months={0}
          ariaPrefix="Income end age"
          onChange={({ memberId, years }) =>
            setEnd({ kind: 'age', memberId, years, months: 0 })
          }
        />

        <RadioOption value="year">In year</RadioOption>
        <div className={ANCHOR_SLIDER_WRAP}>
          <RangeSlider
            ariaLabel="Income end year"
            {...yearSliderBounds(yearValue, members)}
            step={1}
            value={yearValue}
            disabled={!yearActive}
            onChange={(v) => setEnd({ kind: 'year', year: v })}
            formatValue={(v) => `${v}`}
          />
        </div>

        <RadioOption value="endOfRetirementYear">After</RadioOption>
        {/* User-facing N = stored offsetYears + 1 (1 = first year only,
            6 = first 6 years). Slider spans 1–30 retirement years. */}
        <div className={ANCHOR_SLIDER_WRAP}>
          <RangeSlider
            ariaLabel="Number of retirement years"
            min={1}
            max={30}
            step={1}
            value={retYears + 1}
            disabled={!retYearsActive}
            onChange={(v) =>
              setEnd({ kind: 'endOfRetirementYear', offsetYears: v - 1 })
            }
            formatValue={(v) => `${v} years`}
          />
        </div>

        <RadioOption value="durationFromStart">For</RadioOption>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DurationFromStartInput
            end={durationEnd}
            setEnd={setEnd}
            disabled={!durationActive}
          />
        </div>
      </RadioGroup>
    </LabelledGroup>
  );
};

const DurationFromStartInput: React.FC<{
  end: Extract<ScheduleEnd, { kind: 'durationFromStart' }>;
  setEnd: (e: ScheduleEnd) => void;
  disabled?: boolean;
}> = ({ end, setEnd, disabled }) => {
  // Display unit derived from the stored months: divisible by 12 → years.
  const inYears = end.months % 12 === 0;
  const value = inYears ? end.months / 12 : end.months;
  return (
    <InlineNumberInput
      ariaLabel="Duration value"
      width="w-16"
      disabled={disabled}
      value={String(value)}
      onValue={(raw) => {
        const n = parseClampedInt(raw, inYears ? 100 : 1200);
        setEnd({ kind: 'durationFromStart', months: inYears ? n * 12 : n });
      }}
      suffix={
        <ToggleSwitch
          ariaLabel="Duration unit (off = months, on = years)"
          label={inYears ? 'years' : 'months'}
          disabled={disabled}
          checked={inYears}
          onChange={(checked) => {
            // Convert without losing magnitude — `value` is the current
            // visible number; flipping the unit changes how it's stored.
            const next = checked ? value * 12 : value;
            setEnd({ kind: 'durationFromStart', months: next });
          }}
        />
      }
    />
  );
};
