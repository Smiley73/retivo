/**
 * Standing disclaimer card + per-metric toolbars beside the metric
 * radio group. Extracted from `ss-optimizer-page-chrome.tsx` so that
 * file stays under the ≤400-ln shape limit.
 */
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

/** Standing disclaimer card under the page header. A thin wrapper over the
 *  shared `InlineDisclaimerCard` (kept exported — a position test depends on
 *  it). Body text stays `text-xs` deliberate fineprint (a typography
 *  exception); the shared card supplies the canonical lead +
 *  closing, this wrapper supplies the SS-scope middle. */
export const OptimizerDisclaimerCard: React.FC = () => (
  <InlineDisclaimerCard
    ariaLabel="Social Security claim-age comparison disclaimer"
    className="my-3"
  >
    This compares the projected result at each eligible whole-year claim age
    under the goal you selected and shows the claim age with the highest
    modeled result; it does
    not tell you when to claim. The model leaves out some real-world Social
    Security rules — including divorced-spouse benefits (see the full list on
    the Social Security page) — so verify claim-age
    figures with the Social Security Administration. Monte Carlo results also
    leave out the earnings test (the benefit reduction for work income earned
    before full retirement age); only the single-path results apply it.
  </InlineDisclaimerCard>
);

/** Pre-run notice shown while the Monte Carlo sweep is in flight (MC
 *  metric only). The deterministic tab is fast and shows no warning.
 *  Reuses the shared info-tone `Alert` (→ `role="status"`, polite live
 *  region) so assistive tech announces the long-run heads-up when the run
 *  starts. The spinning `RefreshIcon` is `aria-hidden` decorative — the
 *  text carries the announcement — and respects `prefers-reduced-motion`. */
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

/** Label + numeric value pairs for the MC path-count selector. */
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

/** Run / Cancel button + path-count selector + live progress bar beside
 *  the metric radio group when the MC metric is selected. Buttons use
 *  the standalone toolbar-variant classes `btnPrimaryToolbarClass` /
 *  `btnDangerToolbarClass` (not the default role classes) so their
 *  outer height matches the surrounding `<SegmentedRadioGroup>` row at
 *  34px (1px border + 8px py-2 + 16px text-xs line-height) — see the
 *  height-parity math on `btnPrimaryToolbarClass` in
 *  accounts-page-chrome.tsx. The role-class default (`px-4 py-2 text-sm
 *  font-medium`) towers above the radios. */
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

/** Live progress bar shown beside the metric radio group while the
 *  deterministic dispatch loop is in flight. Mirrors the MC toolbar's
 *  shape — mounts and unmounts with the run lifecycle. */
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
