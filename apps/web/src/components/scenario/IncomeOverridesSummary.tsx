import React from 'react';
import { useNavigate } from 'react-router';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';

export interface IncomeOverridesSummaryProps {
  scenarioId: string;
  scenario: ScenarioAggregate;
  onResetToInherited: () => void;
}

export const IncomeOverridesSummaryCard: React.FC<IncomeOverridesSummaryProps> = ({
  scenarioId,
  scenario,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const inc = scenario.payload.overrides.income;
  const disabled = inc?.disabledIds?.length ?? 0;
  const patched = inc ? Object.keys(inc.patches ?? {}).length : 0;
  const added = inc?.added?.length ?? 0;
  const total = disabled + patched + added;
  const canResetToInherited = total > 0 && !scenario.payload.isPrimary;
  return (
    <SummarySectionCard
      title="Income"
      headingId="income-overrides-heading"
      overridden={scenario.payload.isPrimary ? undefined : total > 0}
      actions={
        <ConfigureResetActions
          subject="income overrides"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/income`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {total === 0
          ? 'No scenario overrides.'
          : `${disabled} disabled · ${patched} modified · ${added} scenario-only.`}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};
