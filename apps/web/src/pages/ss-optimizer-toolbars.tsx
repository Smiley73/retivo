/** Standing disclaimer card and per-metric toolbars beside the metric radio group. */
import React from 'react';
import { Alert } from '../components/Alert';
import { RefreshIcon } from '../components/icons';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { OptimizerMcProgressBar } from './ss-optimizer-mc-progress-bar';
import { OptimizerDetProgressBar } from './ss-optimizer-det-progress-bar';
import {
  btnDangerToolbarClass,
  btnPrimaryToolbarClass,
} from './accounts-page-chrome';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';

/** Wraps the shared InlineDisclaimerCard with the SS-scope middle; kept exported because a position test depends on it. The body stays fineprint text-xs (a typography exception). */
export const OptimizerDisclaimerCard: React.FC = () => (
  <InlineDisclaimerCard
    ariaLabel="Social Security claim-age comparison disclaimer"
    className="my-3"
  >
    This compares a fixed set of options under the goal you selected: each
    eligible whole-year claim age, plus the claim age already set on the
    scenario (months included). Every option is projected to one assumed death
    age, the scenario&apos;s Life expectancy setting. It shows the option with
    the highest modeled result. That is a comparison, not a proven best age
    and not advice; it does not tell you when to claim. The model leaves out some real-world Social
    Security rules — including divorced-spouse benefits (see the full list on
    the Social Security page) — so verify claim-age
    figures with the Social Security Administration. Monte Carlo results also
    leave out the earnings test (the benefit reduction for work income earned
    before full retirement age); only the single-path results apply it.
  </InlineDisclaimerCard>
);

/** Notice while the Monte Carlo sweep runs (MC metric only): an info-tone Alert, so its role="status" live region announces the long-run heads-up; the spinning icon is aria-hidden and respects prefers-reduced-motion. */
export const OptimizerRunningNotice: React.FC = () => (
  <Alert tone="info" className="mb-3 flex items-start gap-2.5">
    <span
      aria-hidden="true"
      className="mt-0.5 inline-flex shrink-0 items-center justify-center leading-none animate-spin motion-reduce:animate-none"
    >
      <RefreshIcon />
    </span>
    <p className="m-0">
      <strong>Comparing…</strong> This can take several minutes. Keep this
      screen open and avoid switching tabs — the calculation runs in your
      browser and pauses if you navigate away.
    </p>
  </Alert>
);

const PATH_COUNT_OPTIONS: Array<{ value: '1000' | '5000' | '10000'; label: string }> = [
  { value: '1000', label: '1k scenarios' },
  { value: '5000', label: '5k scenarios' },
  { value: '10000', label: '10k scenarios' },
];

interface OptimizerMcToolbarProps {
  readonly mcRunning: boolean;
  readonly canRun: boolean;
  readonly pathCount: number;
  readonly onPathCountChange: (next: number) => void;
  readonly progress: {
    scenarioIdx: number; pairIdx: number;
    scenarios: number; pairs: number;
    cumulativeIdx: number; totalPairs: number;
  } | null;
  readonly progressLabel: (
    scenarioIdx: number,
    pairIdx: number,
    total: { scenarios: number; pairs: number },
  ) => string;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

/** Run / Cancel, path-count selector and live progress beside the metric radios. The standalone toolbar button classes keep the height at 34px to match the radio row (see btnPrimaryToolbarClass in accounts-page-chrome.tsx). */
export const OptimizerMcToolbar: React.FC<OptimizerMcToolbarProps> = ({
  mcRunning,
  canRun,
  pathCount,
  onPathCountChange,
  progress,
  progressLabel,
  onRun,
  onCancel,
}) => (
  <>
    <SegmentedRadioGroup
      ariaLabel="Monte Carlo path count"
      options={PATH_COUNT_OPTIONS}
      value={String(pathCount) as '1000' | '5000' | '10000'}
      onChange={(v) => onPathCountChange(Number(v))}
      disabled={mcRunning}
    />
    {!mcRunning ? (
      <button
        type="button"
        className={btnPrimaryToolbarClass}
        onClick={onRun}
        disabled={!canRun}
      >
        Run comparison
      </button>
    ) : (
      <>
        <button
          type="button"
          className={btnDangerToolbarClass}
          onClick={onCancel}
        >
          Cancel
        </button>
        {progress && (
          <OptimizerMcProgressBar {...progress} progressLabel={progressLabel} />
        )}
      </>
    )}
  </>
);

interface OptimizerDetToolbarProps {
  readonly detRunning: boolean;
  readonly progress: {
    scenarioIdx: number;
    method: ProjectionMethod;
    cumulativeIdx: number;
    totalTicks: number;
    scenarios: number;
  } | null;
}

/** Live progress bar while the deterministic dispatch loop runs; mounts and unmounts with the run. */
export const OptimizerDetToolbar: React.FC<OptimizerDetToolbarProps> = ({
  detRunning,
  progress,
}) =>
  !detRunning || !progress ? null : (
    <OptimizerDetProgressBar
      scenarioIdx={progress.scenarioIdx}
      method={progress.method}
      cumulativeIdx={progress.cumulativeIdx}
      totalTicks={progress.totalTicks}
      scenarios={progress.scenarios}
    />
  );
