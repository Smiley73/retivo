/** Shared primitives for the Retirement-Age and Social-Security claim-age modals: default-override constants, the years/months display helper, the AgeInputs slider pair and the RetirementDateLine. */
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

/** Applied when no override exists in the parent chain: Full Retirement Age for anyone born 1960 or later; mirrors DEFAULT_SOCIAL_SECURITY_CLAIM_AGE in lib/scenario-bootstrap.ts. */
export const DEFAULT_SS_CLAIM: SocialSecurityClaimAgeOverride = {
  primary: { ageYears: 67, ageMonths: 0 },
};
export const SS_PER_MEMBER_DEFAULT: RetirementAgePerMember = {
  ageYears: 67,
  ageMonths: 0,
};

export const DEFAULT_BENEFIT_REDUCTION_PCT = 0;

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

/** Recomputes the non-anchor's age from birthdates so the payload always carries both members' ages in same-date mode; downstream calculations read primary.age and secondary.age without consulting birthdates. */
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
  // A disabled (derived) side never fires onChange, so its persisted value stays whatever the same-date auto-recompute set.
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
  /** Displayed verbatim by the same-date modes so the non-anchor's "Retires" line matches the anchor's exact date; birthdate + age rounds to the day-of-month and can drift weeks. */
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
