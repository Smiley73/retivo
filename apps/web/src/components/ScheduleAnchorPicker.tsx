/**
 * Shared schedule-anchor picker. Radio + conditional
 * input for the schedule-anchor vocabulary, modelled on the Expense
 * form's Start picker so the two stay visually consistent.
 *
 * Kinds: `retirementStart` · `age {memberId?,years,months}` ·
 * `year {year}`, plus an optional 4th `durationFromExpenseStart
 * {months}` kind gated by the `relativeKind` prop (off ⇒ behaves like
 * the expense Start picker; on ⇒ adds the per-expense relative option
 * the discretionary glide needs), plus an optional 5th `expenseEnd`
 * kind gated by the `expenseEndKind` prop — offered **only** on the
 * glide-end picker ("ends when the expense ends" is only meaningful
 * there). No sub-input: it resolves to the expense's own resolved end.
 *
 * Glide-anchor UX:
 * - `age` is configured **years-only** (no months sub-input); the
 *   stored anchor always carries `months: 0`. A member `<select>`
 *   renders only when a secondary member exists (mirrors the expense
 *   form's whose/member gating); otherwise the role defaults to primary.
 * - `durationFromExpenseStart` is configured as **years + months**
 *   "after this expense begins" (singular — this expense, not "each");
 *   the two inputs combine into the stored total `months`
 *   (`years*12 + months`).
 *
 * Rendered inside a collapsible `<AnchorCard>` by default (collapsed
 * shows a plain-language summary of the current selection; expanded
 * reveals the radio picker with room to lay out), or — when
 * `collapsible={false}` — inside the always-expanded shared
 * `<LabelledGroup>` (the income form has no collapsible sections). The
 * radio cluster is a React Aria `RadioGroup`
 * self-labelled by `label`: React Aria owns the keyboard pattern
 * (arrow / Home / End / Space / click, roving tabIndex,
 * selection-follows-focus). Pure controlled component — no draft state
 * of its own.
 *
 * Both forms' **Start** pickers now render through this component: the
 * Expense form's `StartSection` and the income form's `ScheduleStartPicker`
 * delegate to it via the `GlideAnchor ↔ ScheduleStart` bridge
 * (`lib/schedule-anchor-bridge.ts`). The Expense/income **End** pickers
 * still keep their own (richer) radio bodies — their 5-kind vocabulary is
 * a superset of this component and is not migrated.
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
  /** Enable the 4th `durationFromExpenseStart` kind (glide only). */
  relativeKind?: boolean;
  /** Enable the 5th `expenseEnd` kind — glide-end picker only. The
   *  glide ends exactly when the expense's own resolved `end` does. */
  expenseEndKind?: boolean;
  /** END-anchor mode. Hides the `retirementStart`
   *  radio so only `age | year` are offered (a cap window's END can't be the
   *  start of retirement). The age / year sliders still reuse
   *  `ageSliderBounds()` / `yearSliderBounds()` so the END age anchor reaches
   *  `MAX_AGE` (the old age-85 ceiling is gone). Defaults to `false`. */
  hideRetirementStart?: boolean;
  /** Group header text, e.g. "Glide starts". */
  label: string;
  /** Disables the whole picker: the anchor card can't expand and dims.
   *  Defaults to `false` so callers outside the glide stay unaffected. */
  disabled?: boolean;
  /** Gates ONLY the `age` member `<select>` visibility (AND-ed with
   *  `hasSecondary`). The component still emits `memberId ?? 'primary'`;
   *  the `memberId` keep/omit policy lives in the bridge. Defaults
   *  to `true` so the glide / Expense callers are unaffected. */
  memberSelectable?: boolean;
  /** When `false`, render the body in the shared always-expanded
   *  `<LabelledGroup>` instead of the collapsible `<AnchorCard>` (the
   *  income form has no collapsible sections). Defaults to `true`. */
  collapsible?: boolean;
  /** Overrides the `age` radio's text (Expense passes a personalized
   *  "At {primary}'s age"). Defaults to `'At age'`. */
  ageLabel?: React.ReactNode;
  /** The `memberId` a freshly-switched `age` kind defaults to (income
   *  passes the stream owner's role so switching to `age` on a
   *  secondary-owned stream anchors to that owner, not a hardcoded
   *  primary — the bridge's omit rule keeps a primary default on a
   *  secondary stream, silently mis-anchoring). Defaults to `'primary'`
   *  so the glide / Expense callers are unaffected. */
  defaultMemberId?: HouseholdRole;
  /** The `year` a freshly-switched `year` kind defaults to (income's
   *  Start picker uses the current year + 5). Defaults to the current
   *  year so the glide / Expense callers are unaffected. */
  defaultYear?: number;
  /** Optional upper bound for the age / year sliders. `age` caps the
   *  age-slider max; `year` caps the year-slider max (e.g. the Roth-conversion
   *  editor caps both at the source-owner's last working age / year — the
   *  engine converts only strictly before retirement). The never-clamp guard in
   *  `ageSliderBounds` / `yearSliderBounds` still wins, so an existing stored
   *  anchor above the cap keeps showing its real value. Omitted (or each field
   *  omitted) ⇒ no cap, so every existing caller is unaffected. */
  cap?: { age?: number; year?: number };
  /** Optional lower bound for the age / year sliders — the mirror of `cap`.
   *  `age` raises the age-slider min; `year` raises the year-slider min (e.g.
   *  the QCD editor floors both at the giver's 70½ first-eligible age / year, so
   *  a pre-70½ window can't be selected — complementing the resolver's
   *  start-up-clamp). The never-clamp guard in `ageSliderBounds` /
   *  `yearSliderBounds` still wins, so an existing stored anchor below the floor
   *  keeps showing its real value. Omitted (or each field omitted) ⇒ no floor,
   *  so every existing caller is unaffected. */
  floor?: { age?: number; year?: number };
}

// Shared schedule number-input vocabulary (from MemberAgeInput) — the
// SAME class + width the expense Start/End "At age" inputs use, so every
// anchor input (age yrs · year · duration yrs/mo) lines up identically.
// Crucially has no `block w-full`, which would override the fixed width.
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
        // A finite floor raises the seed above the bare default so a
        // freshly-switched `age` anchor can't start below the picker's
        // own lower bound (e.g. the QCD editor's 70½ floor). Absent /
        // non-finite floor ⇒ the bare default, so every existing caller
        // (which passes no `floor`) is unchanged.
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
  // Mirror the expense form's whose/member gating: the role select
  // only renders when a secondary member exists AND the caller allows it
  // (income hides it for non-partTime kinds via `memberSelectable`);
  // otherwise the anchor defaults to primary implicitly.
  const hasSecondary = !!members && members.some((m) => !m.payload.isPrimary);
  const showMemberSelect = memberSelectable && hasSecondary;
  const select = (kind: GlideAnchor['kind']) => {
    if (value.kind === kind) return;
    onChange(
      defaultForKind(kind, { memberId: defaultMemberId, year: defaultYear }, floor),
    );
  };

  // Mockup: every radio's input stays visible at all times — the inputs
  // whose radio isn't the active kind are simply *disabled*, not hidden.
  // Each row shows the live value when its kind is selected, otherwise a
  // sensible default placeholder while disabled.
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

  // Stable id for the non-collapsible `<LabelledGroup>` heading the
  // RadioGroup is `aria-labelledby`-wired to. In the collapsible
  // `<AnchorCard>` path the RadioGroup self-labels via `aria-label`.
  const groupHeadingId = React.useId();

  const body = (
    // Two-column alignment grid: every radio sits in column 1 and its
    // input(s) in column 2, so the age/year sliders and duration inputs
    // line up vertically. Radios with no input span both columns.
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

        {/* The editable controls sit in column 2 beside the RadioOption
            (not inside the <Radio> label, which would toggle on click). */}
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
          // No sub-input — `expenseEnd` resolves to the expense's own
          // resolved end window (offered only on the glide-end picker).
          <RadioOption value="expenseEnd" className="col-span-2">
            When this expense ends
          </RadioOption>
        )}
    </RadioGroup>
  );

  // Default: collapsible anchor card — the label + a plain-language
  // summary of the current selection when collapsed; the radio picker
  // when open. The card owns the bordered chrome (the parent no longer
  // wraps each picker in its own box). When `collapsible === false`
  // (income), render the body in the shared always-expanded
  // `<LabelledGroup>` instead.
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
