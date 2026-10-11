import type { Aggregate, HouseholdMemberPayload, RetirementAgeOverride, SocialSecurityClaimAgeOverride } from '../../db/types';
import { DEFAULT_COLA_PCT } from '../../db/types';
import { formatPercent } from '../PercentInput';
import {
  formatAge,
  DEFAULT_PER_MEMBER_AGE,
  SS_PER_MEMBER_DEFAULT,
  DEFAULT_BENEFIT_REDUCTION_PCT,
} from '../../pages/scenario-age-modal-shared';

export interface SummaryTextInput {
  isPrimary: boolean;
  isOverriddenLocally: boolean;
  parentName: string | null | undefined;
  effective: RetirementAgeOverride;
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | null;
}

export function summaryText(input: SummaryTextInput): string {
  const { isPrimary, isOverriddenLocally, parentName, effective, secondaryMember } =
    input;
  const primaryName = input.primaryMember?.payload.firstName?.trim() || 'Primary';
  const secondaryName = secondaryMember?.payload.firstName?.trim() || 'Secondary';
  const primaryAge = formatAge(effective.primary);

  let base: string;
  if (!secondaryMember) {
    base = `${primaryName} retires at ${primaryAge}`;
  } else {
    const secondaryAge = effective.secondary
      ? formatAge(effective.secondary)
      : formatAge(DEFAULT_PER_MEMBER_AGE);
    if (effective.sameDateAnchor === 'primary') {
      base = `${primaryName}: ${primaryAge}; ${secondaryName}: same day (age ${secondaryAge})`;
    } else if (effective.sameDateAnchor === 'secondary') {
      base = `${secondaryName}: ${secondaryAge}; ${primaryName}: same day (age ${primaryAge})`;
    } else {
      base = `${primaryName}: ${primaryAge}, ${secondaryName}: ${secondaryAge}`;
    }
  }

  if (!isPrimary && !isOverriddenLocally && parentName) {
    return `${base} (inherited from ${parentName}).`;
  }
  return `${base}.`;
}

export interface SsSummaryTextInput {
  isPrimary: boolean;
  isOverriddenLocally: boolean;
  parentName: string | null | undefined;
  effective: SocialSecurityClaimAgeOverride;
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | null;
  /** Resolved scenario inflation rate — shown as the effective COLA when
   *  `colaTracksInflation` is on (absent/true), matching `resolveSsColaPct`. */
  scenarioInflationPct: number;
}

export function ssSummaryText(input: SsSummaryTextInput): string {
  const { isPrimary, isOverriddenLocally, parentName, effective, secondaryMember } =
    input;
  const primaryName = input.primaryMember?.payload.firstName?.trim() || 'Primary';
  const secondaryName = secondaryMember?.payload.firstName?.trim() || 'Secondary';
  const primaryAge = formatAge(effective.primary);
  const secondaryAge = effective.secondary
    ? formatAge(effective.secondary)
    : formatAge(SS_PER_MEMBER_DEFAULT);
  const ageLine = secondaryMember
    ? `${primaryName} claims at ${primaryAge}, ${secondaryName} at ${secondaryAge}`
    : `${primaryName} claims at ${primaryAge}`;
  const reduction = effective.benefitReductionPct ?? DEFAULT_BENEFIT_REDUCTION_PCT;
  const reductionLabel =
    reduction === 0 ? 'full benefit' : `${formatPercent(reduction)} reduction`;
  // Mirror resolveSsColaPct: absent/true → COLA tracks scenario inflation;
  // only an explicit false uses the fixed colaPct.
  const colaLabel =
    effective.colaTracksInflation === false
      ? `${formatPercent(effective.colaPct ?? DEFAULT_COLA_PCT)} COLA`
      : `COLA tracks inflation (${formatPercent(input.scenarioInflationPct)})`;
  const base = `${ageLine} · ${reductionLabel}, ${colaLabel}`;
  if (!isPrimary && !isOverriddenLocally && parentName) {
    return `${base} (inherited from ${parentName}).`;
  }
  return `${base}.`;
}
