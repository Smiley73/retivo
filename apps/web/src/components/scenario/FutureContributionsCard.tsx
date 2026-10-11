import React, { useMemo } from 'react';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { resolveScenario } from '../../lib/scenario-resolution';
import { Muted } from '../Muted';
import { ToggleSwitch } from '../ToggleSwitch';
import { RefreshIcon } from '../icons';
import { btnDangerSmClass } from '../../pages/scenarios-page-chrome';
import { SummarySectionCard } from '../../pages/scenarios-page-chrome';

export interface FutureContributionsCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  onToggle: (next: boolean) => void;
  onResetToInherited: () => void;
}

export const FutureContributionsCard: React.FC<FutureContributionsCardProps> = ({
  scenario,
  scenarios,
  onToggle,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.contributions;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const inheritedOverrides = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return null;
    return resolveScenario(scenario.payload.parentScenarioId, scenarios);
  }, [scenario, scenarios]);
  const inheritedStop =
    inheritedOverrides?.contributions?.stopContributionsToday ?? false;
  const effective = ownOverride?.stopContributionsToday ?? inheritedStop;

  const parentName = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    return scenarios.find((s) => s.id === scenario.payload.parentScenarioId)
      ?.payload.name;
  }, [scenario, scenarios]);

  const inheritedSuffix =
    !scenario.payload.isPrimary && !isOverriddenLocally && parentName
      ? ` (inherited from ${parentName}).`
      : '.';

  const bodyText = effective
    ? `Stop contributing today${inheritedSuffix}`
    : `Continue contributions until retirement${inheritedSuffix}`;

  return (
    <SummarySectionCard
      title="Future contributions"
      headingId="future-contributions-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        canResetToInherited ? (
          <button
            type="button"
            className={`${btnDangerSmClass} gap-1.5`}
            onClick={onResetToInherited}
            aria-label="Reset future contributions"
          >
            <RefreshIcon />
            Reset
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2">
        <Muted as="p" className="m-0">
          {isOverriddenLocally || scenario.payload.isPrimary
            ? bodyText
            : 'No scenario overrides.'}
        </Muted>
        <ToggleSwitch
          label="Stop contributing today"
          checked={effective}
          onChange={onToggle}
        />
      </div>
    </SummarySectionCard>
  );
};
