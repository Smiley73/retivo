/**
 * Deterministic-tab progress bar — sibling of `OptimizerMcProgressBar`,
 * same React Aria `ProgressBar` shape. Ticks are scenario+method pairs
 * (≈ 2N ticks for N non-deleted scenarios — one per method). The
 * verbatim aria-label is `"scenario X / N, method Planned/Historical"` —
 * the method label comes from the canonical `PROJECTION_METHOD_LABELS` map.
 */
import React from 'react';
import { ProgressBar } from 'react-aria-components';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';

export interface OptimizerDetProgressBarProps {
  readonly scenarioIdx: number;
  readonly method: ProjectionMethod;
  /** Global 1-based tick index (scenario × method). Bar's `value`. */
  readonly cumulativeIdx: number;
  /** Total ticks across the run — `2 × scenarios`. Bar's `maxValue`. */
  readonly totalTicks: number;
  /** Total non-deleted scenarios; drives the sighted "Scenario X of Y"
   *  line so the user sees per-scenario rather than tick progress. */
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
