import React, { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { AccountPayload, Aggregate } from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { resolveAccountFloorsForScenario } from '../../lib/scenario-resolution';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';

export interface AccountOverridesSummaryProps {
  scenarioId: string;
  scenario: ScenarioAggregate;
  activeAccountCount: number;
  onResetToInherited: () => void;
}

export const AccountContributionsOverridesSummaryCard: React.FC<AccountOverridesSummaryProps> = ({
  scenarioId,
  scenario,
  activeAccountCount,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const overrides = scenario.payload.overrides.accountContributions?.perAccount ?? {};
  const overriddenCount = Object.keys(overrides).length;
  const canResetToInherited = overriddenCount > 0 && !scenario.payload.isPrimary;
  return (
    <SummarySectionCard
      title="Account contributions"
      headingId="account-contributions-overrides-heading"
      overridden={scenario.payload.isPrimary ? undefined : overriddenCount > 0}
      actions={
        <ConfigureResetActions
          subject="account contribution overrides"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/contributions`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {activeAccountCount === 0
          ? 'No active accounts.'
          : overriddenCount === 0
            ? 'No scenario overrides.'
            : `${overriddenCount} of ${activeAccountCount} account${activeAccountCount === 1 ? '' : 's'} overridden.`}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

export const AccountReturnsOverridesSummaryCard: React.FC<AccountOverridesSummaryProps> = ({
  scenarioId,
  scenario,
  activeAccountCount,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const overrides = scenario.payload.overrides.accountReturns?.perAccount ?? {};
  const overriddenCount = Object.keys(overrides).length;
  const canResetToInherited = overriddenCount > 0 && !scenario.payload.isPrimary;
  return (
    <SummarySectionCard
      title="Planned returns"
      headingId="account-returns-overrides-heading"
      overridden={scenario.payload.isPrimary ? undefined : overriddenCount > 0}
      actions={
        <ConfigureResetActions
          subject="planned-return overrides"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/returns`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {activeAccountCount === 0
          ? 'No active accounts.'
          : overriddenCount === 0
            ? 'No scenario overrides.'
            : `${overriddenCount} of ${activeAccountCount} account${activeAccountCount === 1 ? '' : 's'} overridden.`}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

/**
 * "Account limits" summary: counts the accounts with a minimum-balance floor; Configure opens
 * `/scenarios/:id/floors`, Reset clears the local `accountFloors` override.
 */
export const AccountFloorsOverridesSummaryCard: React.FC<{
  scenarioId: string;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  accounts: Aggregate<AccountPayload>[];
  onResetToInherited: () => void;
}> = ({ scenarioId, scenario, scenarios, accounts, onResetToInherited }) => {
  const navigate = useNavigate();
  // Counts resolved floors including inherited ones, since a child that inherits a floor still has
  // it enforced.
  const resolvedFloors = useMemo(
    () => resolveAccountFloorsForScenario(scenario.id, scenarios, accounts),
    [scenario.id, scenarios, accounts],
  );
  // Only POST_TAX / HSA floors are enforced (`isFloorEligible`); floors on ineligible types are
  // ignored, so exclude them.
  const flooredCount = [...resolvedFloors.keys()].filter(id => {
    const acct = accounts.find(a => a.id === id);
    return (
      acct?.payload.taxTreatment === 'POST_TAX' ||
      acct?.payload.taxTreatment === 'HSA'
    );
  }).length;
  // The "Customized" pill reflects local customization only, unlike the inherited-inclusive body
  // count.
  const localOverrides = scenario.payload.overrides.accountFloors?.perAccount ?? {};
  const hasLocalOverride = Object.keys(localOverrides).length > 0;
  const canResetToInherited = hasLocalOverride && !scenario.payload.isPrimary;
  return (
    <SummarySectionCard
      title="Account limits"
      headingId="account-floors-overrides-heading"
      overridden={scenario.payload.isPrimary ? undefined : hasLocalOverride}
      actions={
        <ConfigureResetActions
          subject="account floors"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/floors`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {flooredCount === 0
          ? 'No account floors set.'
          : `${flooredCount} account${flooredCount === 1 ? '' : 's'} with a minimum-balance floor.`}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};
