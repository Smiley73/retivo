/** Deterministic-tab progress bar (React Aria ProgressBar); ticks are scenario+method pairs and the aria-label is "scenario X / N, method <label>" with the label from PROJECTION_METHOD_LABELS. */
import React from 'react';
import { ProgressBar } from 'react-aria-components';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';

export interface OptimizerDetProgressBarProps {
  readonly scenarioIdx: number;
  readonly method: ProjectionMethod;
  readonly cumulativeIdx: number;
  readonly totalTicks: number;
  readonly scenarios: number;
}

const DET_PROGRESS_LABEL_FORMAT = (
  scenarioIdx: number,
  scenarios: number,
  method: ProjectionMethod,
): string => {
  const label = PROJECTION_METHOD_LABELS[method];
  return `scenario ${scenarioIdx} / ${scenarios}, method ${label}`;
};

export const OptimizerDetProgressBar: React.FC<OptimizerDetProgressBarProps> = ({
  scenarioIdx,
  method,
  cumulativeIdx,
  totalTicks,
  scenarios,
}) => (
  <ProgressBar
    minValue={0}
    maxValue={Math.max(1, totalTicks)}
    value={cumulativeIdx}
    aria-label={DET_PROGRESS_LABEL_FORMAT(scenarioIdx, scenarios, method)}
    className="flex min-w-80 flex-col gap-1"
  >
    {({ percentage, valueText }) => (
      <>
        <span className="text-xs text-ink">
          Scenario {scenarioIdx} of {scenarios} · {Math.round(percentage ?? 0)}%
        </span>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="h-full bg-accent w-[var(--optimizer-det-progress-pct)]"
            // eslint-disable-next-line no-restricted-syntax -- runtime-dynamic progress width bridged via --optimizer-det-progress-pct
            style={{ ['--optimizer-det-progress-pct' as string]: `${percentage ?? 0}%` }}
          />
        </div>
        <span className="sr-only">{valueText}</span>
      </>
    )}
  </ProgressBar>
);
