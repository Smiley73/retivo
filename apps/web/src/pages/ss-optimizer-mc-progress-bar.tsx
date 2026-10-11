/**
 * MC progress bar — linear React Aria `ProgressBar` rendered next to
 * the Cancel button while a Monte Carlo sweep is running. Verbatim
 * progress label rides on `aria-label`; sighted users see the
 * "Scenario X of Y" line + the visual bar.
 */
import React from 'react';
import { ProgressBar } from 'react-aria-components';

export interface OptimizerMcProgressBarProps {
  readonly scenarioIdx: number;
  readonly pairIdx: number;
  readonly scenarios: number;
  readonly pairs: number;
  /** Global triple-index across all scenarios (1-based). Used as the
   *  bar's `value` so 1-D fallback scenarios contribute their actual
   *  triple count instead of the joint-product overestimate. */
  readonly cumulativeIdx: number;
  /** Global triple total. Bar's `maxValue`. */
  readonly totalPairs: number;
  readonly progressLabel: (
    scenarioIdx: number,
    pairIdx: number,
    total: { scenarios: number; pairs: number },
  ) => string;
}

export const OptimizerMcProgressBar: React.FC<OptimizerMcProgressBarProps> = ({
  scenarioIdx,
  pairIdx,
  scenarios,
  pairs,
  cumulativeIdx,
  totalPairs,
  progressLabel,
}) => (
  <ProgressBar
    minValue={0}
    maxValue={Math.max(1, totalPairs)}
    value={cumulativeIdx}
    aria-label={progressLabel(scenarioIdx, pairIdx, { scenarios, pairs })}
    className="flex min-w-80 flex-col gap-1"
  >
    {({ percentage, valueText }) => (
      <>
        <span className="text-xs text-ink">
          Scenario {scenarioIdx} of {scenarios} · {Math.round(percentage ?? 0)}%
        </span>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="h-full bg-accent w-[var(--optimizer-mc-progress-pct)]"
            // eslint-disable-next-line no-restricted-syntax -- runtime-dynamic progress width bridged via --optimizer-mc-progress-pct
            style={{ ['--optimizer-mc-progress-pct' as string]: `${percentage ?? 0}%` }}
          />
        </div>
        <span className="sr-only">{valueText}</span>
      </>
    )}
  </ProgressBar>
);
