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

/** True when this scenario carries a LOCAL QCD override (drives the card tint +
 *  Reset gating + the group customized count). */
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

/** Qualified Charitable Distributions summary. Shows how many QCD
 *  entries the engine actually applies — the count is taken from the HARDENED
 *  `resolveQcdForScenario` output (orphan / non-IRA / cross-owner / pre-70½
 *  entries already dropped), so the card never counts an invalid entry. The
 *  Configure button opens the dedicated editor; the tint + Reset stay keyed on
 *  a LOCAL override only (mirrors the Roth-conversions card). */
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

  // The resolved (engine-applied) entry count: the hardened resolver reads the
  // parent-chain effective list and drops every invalid entry, so the body
  // matches what the projection actually applies for an inheriting child too.
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

  // Nearest ancestor that actually sets the QCD key — shown only when the child
  // inherits the list (no local override), mirroring the editor's inherited
  // banner (first-ancestor-wins).
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
