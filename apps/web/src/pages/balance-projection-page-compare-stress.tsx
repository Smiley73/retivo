/**
 * Balance Projection page — the Compare tab's "Plan success" row. Renders
 * only: states and the noise-gate verdict come from `useCompareStress`. A side
 * reads "—", dimmed and `aria-busy`, until its stress test has settled for the
 * plan on screen; the difference is a glyph plus a word, or "about the same"
 * with its reason, never colour.
 */
import React, { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { McProgressBar } from '../components/McProgressBar';
import { Muted } from '../components/Muted';
import { formatSignedDifference } from '../lib/signed-difference';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import type { SuccessDeltaVerdict } from '../lib/success-delta-noise';
import type { CompareStressSide, CompareStressVm } from '../monte-carlo/use-compare-stress';
import { btnSecondarySmClass } from './accounts-page-chrome';

const HEADING_ID = 'balance-projection-compare-stress-heading';

const NUMBER_CLASS = 'm-0 font-mono text-lg tabular-nums text-ink';

const INTRO =
  `The stress test runs ${MC_PATH_COUNT.toLocaleString('en-US')} randomized market ` +
  'simulations of a plan and counts how often the savings last the whole plan. ' +
  'Each scenario is simulated on its own, so two runs differ a little by chance.';

const SAME_TEXT = 'About the same';

const percent = (side: CompareStressSide): string =>
  side.state === 'ready' && side.probability !== null
    ? `${Math.round(side.probability * 100)}%`
    : '—';

function reasonLine(verdict: SuccessDeltaVerdict): string {
  const points = Math.round(verdict.se * 1000) / 10;
  const noise =
    points > 0
      ? `about ${points} point${points === 1 ? '' : 's'} here`
      : 'the two runs agree';
  if (verdict.kind === 'signal') {
    return `The gap is larger than the stress test's sampling noise (${noise}).`;
  }
  if (verdict.reason === 'rounds-to-zero') {
    return 'The gap is under half a percentage point, so it rounds to 0 points at the precision shown.';
  }
  return `The stress test is a random sample, so a gap this small is within its sampling noise (${noise}).`;
}

const Figure: React.FC<{
  readonly label: string;
  readonly children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="flex min-w-32 flex-col gap-0.5">
    <dt className="text-sm text-muted">{label}</dt>
    <dd className="m-0">{children}</dd>
  </div>
);

const isBusy = (side: CompareStressSide): boolean =>
  side.state === 'pending' || side.state === 'running';

const SideProgress: React.FC<{ readonly name: string; readonly side: CompareStressSide }> = ({
  name,
  side,
}) => (
  <McProgressBar
    label={`Stress test for ${name}`}
    done={side.progress?.done ?? 0}
    total={side.progress?.total ?? 0}
  />
);

const SideStatus: React.FC<{
  readonly name: string;
  readonly side: CompareStressSide;
  readonly viewed: boolean;
  readonly onRetry?: () => void;
  readonly onRun?: () => void;
}> = ({ name, side, viewed, onRetry, onRun }) => {
  // Try again stays mounted, disabled, through the retry it started: unmounting
  // it dropped keyboard focus to `document.body`.
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    if (side.state !== 'error' && !isBusy(side)) setRetried(false);
  }, [side]);
  if (!viewed && onRetry && (side.state === 'error' || (retried && isBusy(side)))) {
    const retrying = side.state !== 'error';
    return (
      <div className="flex flex-wrap items-center gap-3">
        {retrying ? (
          <SideProgress name={name} side={side} />
        ) : (
          <p className="m-0 text-sm text-muted">
            {side.message ?? `Couldn't calculate the stress test for ${name}.`}
          </p>
        )}
        <Button
          type="button"
          className={`${btnSecondarySmClass} disabled:cursor-not-allowed disabled:opacity-50`}
          isDisabled={retrying}
          onPress={() => {
            setRetried(true);
            onRetry();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (isBusy(side)) return <SideProgress name={name} side={side} />;
  if (side.state === 'stopped') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 text-sm text-muted">
          The stress test for {name} was stopped before it finished.
        </p>
        {onRun && (
          <Button type="button" className={btnSecondarySmClass} onPress={onRun}>
            Run the stress test
          </Button>
        )}
      </div>
    );
  }
  if (side.state === 'unavailable') {
    return (
      <p className="m-0 text-sm text-muted">
        {viewed
          ? `${name} has no stress test to show: it needs an active account and a complete setup.`
          : `${name} can't run a stress test: it needs a retirement age, an active account and a complete setup.`}
      </p>
    );
  }
  if (side.state === 'error' && viewed) {
    return (
      <p className="m-0 text-sm text-muted">
        The stress test for {name} didn&rsquo;t finish. Use Try again in the
        stress test controls at the top of the page.
      </p>
    );
  }
  if (side.state === 'error') {
    return (
      <p className="m-0 text-sm text-muted">
        {side.message ?? `Couldn't calculate the stress test for ${name}.`}
      </p>
    );
  }
  return null;
};

export const CompareStressRow: React.FC<{
  readonly viewedName: string;
  readonly comparisonName: string;
  readonly stress: CompareStressVm;
}> = ({ viewedName, comparisonName, stress }) => {
  const { viewed, comparison, verdict } = stress;
  const busy = isBusy(viewed) || isBusy(comparison);
  let difference = '—';
  if (verdict !== null && viewed.probability !== null && comparison.probability !== null) {
    difference =
      verdict.kind === 'signal'
        ? formatSignedDifference('percentagePoints', viewed.probability, comparison.probability)
        : SAME_TEXT;
  }
  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col gap-3">
      <h3 id={HEADING_ID} className="m-0 text-base font-semibold text-ink">
        Plan success
      </h3>
      <Muted as="p" className="m-0 text-sm">
        {INTRO}
      </Muted>
      <dl
        aria-busy={busy}
        className={`m-0 flex flex-wrap gap-x-10 gap-y-3 transition-opacity duration-150 ${
          busy ? 'opacity-50' : 'opacity-100'
        }`}
      >
        <Figure label={viewedName}>
          <span className={NUMBER_CLASS}>{percent(viewed)}</span>
        </Figure>
        <Figure label={comparisonName}>
          <span className={NUMBER_CLASS}>{percent(comparison)}</span>
        </Figure>
        <Figure label="Difference">
          <span className={NUMBER_CLASS} aria-live="polite">
            {difference}
          </span>
        </Figure>
      </dl>
      {verdict !== null && (
        <p className="m-0 text-sm text-muted">{reasonLine(verdict)}</p>
      )}
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        <SideStatus name={viewedName} side={viewed} viewed onRun={stress.runViewed} />
        <SideStatus
          name={comparisonName}
          side={comparison}
          viewed={false}
          onRetry={stress.retry}
        />
      </div>
    </section>
  );
};
