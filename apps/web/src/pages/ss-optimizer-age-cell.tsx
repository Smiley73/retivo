/** Optimizer "current → recommended" cells, shared by the MC and deterministic tabs: AgeTransition for claim ages and MetricTransition for the ending balance / plan-success metric. When the current value equals the recommendation, or there is no baseline, only the recommended value shows. */
import React from 'react';
import { formatAgeYearsMonths } from '../lib/format-age';
import { claimAgeMatches } from './ss-optimizer-row-view';
import type { RetirementAgePerMember } from '../db/types';

export interface AgeTransitionProps {
  readonly current: RetirementAgePerMember | null;
  readonly recommendedYears: number;
  readonly recommendedMonths?: number;
}

export const AgeTransition: React.FC<AgeTransitionProps> = ({
  current,
  recommendedYears,
  recommendedMonths = 0,
}) => {
  const recommendedLabel = formatAgeYearsMonths({
    years: recommendedYears,
    months: recommendedMonths,
  });
  if (
    !current ||
    claimAgeMatches(current, recommendedYears, recommendedMonths)
  ) {
    return <>{recommendedLabel}</>;
  }
  const currentLabel = formatAgeYearsMonths({
    years: current.ageYears,
    months: current.ageMonths,
  });
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted">{currentLabel}</span>
      <span aria-hidden="true" className="mx-1 text-muted">
        →
      </span>
      <span className="sr-only"> to </span>
      {recommendedLabel}
    </span>
  );
};

export interface MetricTransitionProps {
  readonly baseline: number | undefined;
  readonly recommended: number;
  readonly format: (value: number) => string;
}

export const MetricTransition: React.FC<MetricTransitionProps> = ({
  baseline,
  recommended,
  format,
}) => {
  const recommendedLabel = format(recommended);
  if (baseline === undefined || baseline === recommended) {
    return <>{recommendedLabel}</>;
  }
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted">{format(baseline)}</span>
      <span aria-hidden="true" className="mx-1 text-muted">
        →
      </span>
      <span className="sr-only"> to </span>
      {recommendedLabel}
    </span>
  );
};
