/** Live monthly-benefit estimate for a member's slider position inside SocialSecurityModal. */
import React from 'react';
import { textLinkClass } from '../components/TextLink';
import { Muted } from '../components/Muted';
import { formatCurrency } from '../lib/format-currency';
import {
  fraMonthsForBirthdate,
  monthlyBenefitAtAge,
  InvalidBirthYearError,
} from '../lib/ssa-formulas';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

interface LiveBenefitAmountProps {
  member: Aggregate<HouseholdMemberPayload>;
  claimAgeYears: number;
  pia: number | null;
  onNavigateToSsPage: () => void;
}

/** Prompts with a link to the SS page when `pia` is null (the dirty guard fires via onNavigateToSsPage), and falls back gracefully for an unsupported birth year (InvalidBirthYearError). */
export const LiveBenefitAmount: React.FC<LiveBenefitAmountProps> = ({
  member,
  claimAgeYears,
  pia,
  onNavigateToSsPage,
}) => {
  if (pia === null) {
    return (
      <Muted className="text-sm">
        Enter your monthly benefit at full retirement age on the{' '}
        <button
          type="button"
          className={textLinkClass}
          onClick={onNavigateToSsPage}
        >
          Social Security page
        </button>{' '}
        to see this estimate.
      </Muted>
    );
  }

  // fraMonthsForBirthdate throws InvalidBirthYearError for pre-1943 births or an unparseable birthdate; fall back instead of propagating into the render tree.
  let fra: number;
  try {
    fra = fraMonthsForBirthdate(member.payload.birthdate ?? '');
  } catch (e) {
    if (e instanceof InvalidBirthYearError) {
      return (
        <Muted className="text-sm">
          Benefit estimate unavailable. Birth year not in the SSA FRA table.
        </Muted>
      );
    }
    return null;
  }

  const claimMonths = claimAgeYears * 12;
  const monthly = monthlyBenefitAtAge(pia, fra, claimMonths);
  return (
    <Muted className="text-sm tabular-nums">
      Monthly benefit at age {claimAgeYears}: {formatCurrency(monthly)}
    </Muted>
  );
};
