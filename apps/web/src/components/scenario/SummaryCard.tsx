import React, { useMemo } from 'react';
import type { Aggregate, HouseholdMemberPayload } from '../../db/types';
import { DEFAULT_INFLATION_PCT } from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { resolveScenario } from '../../lib/scenario-resolution';
import {
  DEFAULT_RETIREMENT,
  DEFAULT_SS_CLAIM,
} from '../../pages/scenario-age-modal-shared';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';
import { summaryText, ssSummaryText } from './summary-text';

export interface SummaryCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | null;
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const RetirementAgeSummaryCard: React.FC<SummaryCardProps> = ({
  scenario,
  scenarios,
  primaryMember,
  secondaryMember,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.retirementAge;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const inheritedOverrides = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return null;
    return resolveScenario(scenario.payload.parentScenarioId, scenarios);
  }, [scenario, scenarios]);
  const inheritedRetirementAge =
    inheritedOverrides?.retirementAge ?? DEFAULT_RETIREMENT;
  const effective = ownOverride ?? inheritedRetirementAge;

  const parentName = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    return scenarios.find((s) => s.id === scenario.payload.parentScenarioId)?.payload
      .name;
  }, [scenario, scenarios]);

  return (
    <SummarySectionCard
      title="Retirement age"
      headingId="retirement-age-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="retirement age"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? summaryText({
              isPrimary: scenario.payload.isPrimary,
              isOverriddenLocally,
              parentName,
              effective,
              primaryMember,
              secondaryMember,
            })
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

export const SocialSecuritySummaryCard: React.FC<SummaryCardProps> = ({
  scenario,
  scenarios,
  primaryMember,
  secondaryMember,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.socialSecurity;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const inheritedOverrides = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return null;
    return resolveScenario(scenario.payload.parentScenarioId, scenarios);
  }, [scenario, scenarios]);
  const inheritedSS = inheritedOverrides?.socialSecurity ?? DEFAULT_SS_CLAIM;
  const effective = ownOverride ?? inheritedSS;

  // The rate the engines apply when the SS COLA tracks inflation, so the summary shows the number
  // in effect.
  const scenarioInflationPct = useMemo(() => {
    const resolved = resolveScenario(scenario.id, scenarios);
    return resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  }, [scenario.id, scenarios]);

  const parentName = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    return scenarios.find((s) => s.id === scenario.payload.parentScenarioId)?.payload
      .name;
  }, [scenario, scenarios]);

  return (
    <SummarySectionCard
      title="Social Security"
      headingId="social-security-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="Social Security claim age"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? ssSummaryText({
              isPrimary: scenario.payload.isPrimary,
              isOverriddenLocally,
              parentName,
              effective,
              primaryMember,
              secondaryMember,
              scenarioInflationPct,
            })
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

