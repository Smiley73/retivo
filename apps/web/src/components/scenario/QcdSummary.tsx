import React, { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { AccountPayload, Aggregate, HouseholdMemberPayload, ScenarioOverrides } from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { resolveQcdForScenario, scenarioChain } from '../../lib/scenario-resolution';
import { Muted } from '../Muted';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';

export function hasQcdOverride(ov: ScenarioOverrides): boolean {
  return ov.qualifiedCharitableDistributions !== undefined;
}

export interface QcdSummaryProps {
  scenarioId: string;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  onResetToInherited: () => void;
}

/**
 * QCD summary: counts the entries the hardened `resolveQcdForScenario` applies; tint and Reset key
 * on a local override only.
 */
export const QcdSummaryCard: React.FC<QcdSummaryProps> = ({
  scenarioId,
  scenario,
  scenarios,
  accounts,
  members,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const ov = scenario.payload.overrides;
  const hasLocalOverride = hasQcdOverride(ov);
  const canResetToInherited = hasLocalOverride && !scenario.payload.isPrimary;

  const resolvedCount = useMemo<number>(() => {
    try {
      return resolveQcdForScenario(
        scenario.id,
        scenarios,
        accounts.map((a) => ({ id: a.id, payload: a.payload })),
        members,
      ).entries.length;
    } catch {
      return 0;
    }
  }, [scenario.id, scenarios, accounts, members]);

  const inheritedFromName = useMemo<string | null>(() => {
    if (ov.qualifiedCharitableDistributions !== undefined) return null;
    if (resolvedCount === 0) return null;
    if (!scenario.payload.parentScenarioId) return null;
    try {
      const chain = scenarioChain(scenario.id, scenarios);
      for (let i = 1; i < chain.length; i += 1) {
        if (
          chain[i].payload.overrides.qualifiedCharitableDistributions !==
          undefined
        ) {
          return chain[i].payload.name;
        }
      }
    } catch {
      return null;
    }
    return null;
  }, [scenario, scenarios, ov, resolvedCount]);

  return (
    <SummarySectionCard
      title="Charitable distributions (QCDs)"
      headingId="qcd-heading"
      overridden={scenario.payload.isPrimary ? undefined : hasLocalOverride}
      actions={
        <ConfigureResetActions
          subject="charitable distributions"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/qcd`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {resolvedCount === 0
          ? 'No scenario overrides.'
          : `${resolvedCount} charitable distribution${resolvedCount === 1 ? '' : 's'} from a traditional IRA at 70½+`}
      </SummaryCardBody>
      {inheritedFromName && (
        <Muted className="m-0 mt-2 text-xs">
          Inherited from {inheritedFromName}.
        </Muted>
      )}
    </SummarySectionCard>
  );
};
