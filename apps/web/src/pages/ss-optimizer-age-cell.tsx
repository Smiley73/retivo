/**
 * Optimizer transition cells: render a scenario's current value → the
 * optimizer's recommendation as "current → recommended". `AgeTransition`
 * does this for claim ages (e.g. "62 → 65"); `MetricTransition` for the
 * ending balance / plan-success metric (e.g. "$1.1M → $1.3M"). In both,
 * when the current value already equals the recommendation — or no
 * baseline is available — only the recommended value shows, so an
 * already-applied row reads as a plain value.
 *
 * Shared by both the Monte Carlo and deterministic tabs so the two render
 * identically.
 */
import React from 'react';
import { formatAgeYearsMonths } from '../lib/format-age';
import { claimAgeMatches } from './ss-optimizer-row-view';
import type { RetirementAgePerMember } from '../db/types';

export interface AgeTransitionProps {
  /** Scenario's current claim age for this member, or `null` when unset. */
  readonly current: RetirementAgePerMember | null;
  /** Optimizer's recommended whole-year claim age. */
  readonly recommendedYears: number;
}

export const AgeTransition: React.FC<AgeTransitionProps> = ({
  current,
  recommendedYears,
}) => {
  if (!current || claimAgeMatches(current, recommendedYears)) {
    return <>{recommendedYears}</>;
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
      {recommendedYears}
    </span>
  );
};

export interface MetricTransitionProps {
  /** Metric value at the scenario's current claim ages, or `undefined`
   *  when no whole-year baseline candidate exists. */
  readonly baseline: number | undefined;
  /** Optimizer's recommended (winning) metric value. */
  readonly recommended: number;
  /** Formats a metric value for display (e.g. `formatCurrencyShort` for
   *  balance, percent for plan success). */
  readonly format: (value: number) => string;
}

export const MetricTransition: React.FC<MetricTransitionProps> = ({
  baseline,
  recommended,
  format,
}) => {
  const recommendedLabel = format(recommended);
  // No baseline (current ages off-grid), or the metric doesn't move — show
  // just the recommended value, mirroring AgeTransition's already-applied
  // single-value rendering.
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
