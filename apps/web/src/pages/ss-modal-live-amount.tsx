/**
 * Live monthly-benefit estimate shown inside `SocialSecurityModal` for
 * each member's current slider position.
 *
 * Extracted to keep `SocialSecurityModal.tsx` under the 400-line file cap.
 */
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
  /** PIA for the member; null when the user has not yet entered one. */
  pia: number | null;
  /** Called when the user clicks the "Social Security page" link in the
   *  null-PIA prompt. Should guard dirty state before navigating. */
  onNavigateToSsPage: () => void;
}

/**
 * Renders the live monthly-benefit estimate for a member's current slider
 * position.
 *
 * - `pia === null` → prompt with a button linking to the SS page (dirty-
 *   state guard fires via `onNavigateToSsPage`).
 * - Unsupported birth year (pre-1943 or unparseable) → graceful fallback
 *   (InvalidBirthYearError handling).
 * - Otherwise → formatted monthly estimate.
 */
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

  // fraMonthsForBirthdate throws InvalidBirthYearError for pre-1943
  // births or an empty / unparseable birthdate. Return a graceful
  // fallback instead of propagating the exception into the render tree.
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
