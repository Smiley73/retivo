/**
 * Shared primitives for the Retirement-Age + Social-Security claim-age
 * modals (extracted from `ScenarioDetailPage.tsx`).
 *
 * The two modals + their shared helpers were lifted out of the largest
 * page in the app so that page stays small. This module holds the slice
 * both modals depend on:
 * default-override constants, the years/months age display helper, the
 * WAI-ARIA `AgeInputs` pair (NOT `type="number"` — spinner jitter in
 * constrained dialogs), and the `RetirementDateLine` (`formatDate`-
 * backed). The retirement-timing mode picker is the typed
 * `<SegmentedRadioGroup>` invoked inline at the modal call sites
 * (no wrapper component). Visual style is
 * Tailwind defaults; the framework-independent behavioral contract is
 * preserved verbatim.
 */
import React from 'react';
import { formatDate } from '../lib/format-date';
import { formatAgeYearsMonths } from '../lib/format-age';
import { ageOnDate, retirementDate } from '../lib/retirement-date-math';
import { RangeSlider } from '../components/RangeSlider';
import { AGE_MONTHS_MAX, RETIREMENT_AGE_MAX, RETIREMENT_AGE_MIN } from '../lib/scenario-input-bounds';
import type {
  RetirementAgeOverride,
  RetirementAgePerMember,
  SocialSecurityClaimAgeOverride,
} from '../db/types';

export const DEFAULT_RETIREMENT: RetirementAgeOverride = {
  primary: { ageYears: 65, ageMonths: 0 },
  sameDateAnchor: 'primary',
};
export const DEFAULT_PER_MEMBER_AGE: RetirementAgePerMember = {
  ageYears: 65,
  ageMonths: 0,
};

/** Default Social Security claim age applied when no override exists in
 *  the parent chain — Full Retirement Age for everyone born 1960 or
 *  later. Mirrors `DEFAULT_SOCIAL_SECURITY_CLAIM_AGE` in
 *  `lib/scenario-bootstrap.ts`. */
export const DEFAULT_SS_CLAIM: SocialSecurityClaimAgeOverride = {
  primary: { ageYears: 67, ageMonths: 0 },
};
export const SS_PER_MEMBER_DEFAULT: RetirementAgePerMember = {
  ageYears: 67,
  ageMonths: 0,
};

export const DEFAULT_BENEFIT_REDUCTION_PCT = 0;

/** Years-months age display (e.g. "65" or "65 years 6 months") for
 *  summary text. Thin `{ ageYears, ageMonths }` → canonical adapter. */
export function formatAge(age: { ageYears: number; ageMonths: number }): string {
  return formatAgeYearsMonths({ years: age.ageYears, months: age.ageMonths });
}

export type RetirementMode =
  | 'independent'
  | 'sameDateAnchorPrimary'
  | 'sameDateAnchorSecondary';

export function modeOf(o: RetirementAgeOverride): RetirementMode {
  if (o.sameDateAnchor === 'primary') return 'sameDateAnchorPrimary';
  if (o.sameDateAnchor === 'secondary') return 'sameDateAnchorSecondary';
  return 'independent';
}

/**
 * Recomputes the non-anchor's age from birthdates so the persisted
 * payload always carries both members' ages even in same-date mode.
 * Calculations downstream read `primary.age` + `secondary.age`
 * directly without consulting birthdates.
 */
export function recomputeNonAnchorAge(
  draft: RetirementAgeOverride,
  primaryBirthdate: string | undefined,
  secondaryBirthdate: string | undefined,
): RetirementAgeOverride {
  if (
    draft.sameDateAnchor === 'primary' &&
    primaryBirthdate &&
    secondaryBirthdate
  ) {
    const retDate = retirementDate(primaryBirthdate, draft.primary);
    return { ...draft, secondary: ageOnDate(secondaryBirthdate, retDate) };
  }
  if (
    draft.sameDateAnchor === 'secondary' &&
    primaryBirthdate &&
    secondaryBirthdate &&
    draft.secondary
  ) {
    const retDate = retirementDate(secondaryBirthdate, draft.secondary);
    return { ...draft, primary: ageOnDate(primaryBirthdate, retDate) };
  }
  return draft;
}

interface AgeInputsProps {
  ageYears: number;
  ageMonths: number;
  onChange: (key: 'ageYears' | 'ageMonths', value: number) => void;
  ariaLabelPrefix: string;
  disabled?: boolean;
}

export const AgeInputs: React.FC<AgeInputsProps> = ({
  ageYears,
  ageMonths,
  onChange,
  ariaLabelPrefix,
  disabled,
}) => {
  // Years + months as sliders (label on the left, slider filling the
  // rest). The slider value/onChange wiring is identical to the prior
  // numeric inputs, so the same-date auto-recompute + derived-side
  // disabling driven by the modal continue to work unchanged. A
  // disabled (derived) side never fires `onChange`, so its persisted
  // value stays whatever the auto-recompute set.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-sm font-medium text-ink">
          Years
        </span>
        <div className="min-w-0 flex-1">
          <RangeSlider
            ariaLabel={`${ariaLabelPrefix}-years`}
            min={RETIREMENT_AGE_MIN}
            max={RETIREMENT_AGE_MAX}
            step={1}
            value={ageYears}
            onChange={(v) => onChange('ageYears', v)}
            disabled={disabled}
            formatValue={(v) => `${v}`}
            formatAriaValue={(v) => `${v} years`}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-sm font-medium text-ink">
          Months
        </span>
        <div className="min-w-0 flex-1">
          <RangeSlider
            ariaLabel={`${ariaLabelPrefix}-months`}
            min={0}
            max={AGE_MONTHS_MAX}
            step={1}
            value={ageMonths}
            onChange={(v) => onChange('ageMonths', v)}
            disabled={disabled}
            formatValue={(v) => `${v}`}
            formatAriaValue={(v) => `${v} months`}
          />
        </div>
      </div>
    </div>
  );
};

interface RetirementDateLineProps {
  birthdate: string | undefined;
  age: { ageYears: number; ageMonths: number };
  ariaPrefix: string;
  /**
   * Optional ISO `YYYY-MM-DD` to display verbatim instead of computing
   * `birthdate + age`. Used by the same-date modes so the non-anchor's
   * "Retires" line matches the anchor's exact date — `birthdate + age`
   * rounds to the non-anchor's day-of-month, which can drift several
   * weeks from the anchor's actual retirement date.
   */
  overrideIsoDate?: string | null;
}

export const RetirementDateLine: React.FC<RetirementDateLineProps> = ({
  birthdate,
  age,
  ariaPrefix,
  overrideIsoDate,
}) => {
  let isoDate: string | null = null;
  if (overrideIsoDate) {
    isoDate = overrideIsoDate;
  } else if (birthdate) {
    try {
      isoDate = retirementDate(birthdate, age);
    } catch {
      isoDate = null;
    }
  }
  if (!isoDate) return null;
  const formatted = formatDate(isoDate);
  if (!formatted) return null;
  return (
    <p
      className="m-0 text-sm text-muted"
      data-testid={`${ariaPrefix}-date`}
    >
      Retires {formatted}
    </p>
  );
};
