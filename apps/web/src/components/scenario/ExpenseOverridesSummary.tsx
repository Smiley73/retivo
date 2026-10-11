import React from 'react';
import { useNavigate } from 'react-router';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';

export interface ExpenseOverridesSummaryProps {
  scenarioId: string;
  scenario: ScenarioAggregate;
  onResetToInherited: () => void;
}

export const ExpenseOverridesSummaryCard: React.FC<ExpenseOverridesSummaryProps> = ({
  scenarioId,
  scenario,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const exp = scenario.payload.overrides.expenses;
  const disabled = exp?.disabledIds?.length ?? 0;
  const patched = exp ? Object.keys(exp.patches ?? {}).length : 0;
  const added = exp?.added?.length ?? 0;
  const total = disabled + patched + added;
  const canResetToInherited = total > 0 && !scenario.payload.isPrimary;
  return (
    <SummarySectionCard
      title="Expenses"
      headingId="expense-overrides-heading"
      overridden={scenario.payload.isPrimary ? undefined : total > 0}
      actions={
        <ConfigureResetActions
          subject="expense overrides"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/expenses`)}
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
