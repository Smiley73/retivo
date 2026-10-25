/**
 * Stat-card slot renderers and the market-stress comparison table, presentation over `PlanStressTestVm`. Re-exported
 * from `PlanStressTestSection.tsx`.
 */
import { useState } from 'react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { MonteCarloMethodologyModal } from './MonteCarloMethodologyModal';
import { Badge } from './Badge';
import { formatCurrencyShort } from '../lib/format-currency';
import { horizonStatus } from '../lib/horizon-status';
import { useTheme } from '../contexts/ThemeContext';
import { TableScroll } from './TableScroll';
import { btnSecondarySmClass } from './dialog-chrome';
import {
  STAT_BOX,
  STAT_LABEL,
  STAT_VALUE,
  STATUS_HEX,
  STATUS_TEXT_CLASS,
  TABLE_CLASS,
  TD_CENTER_CLASS,
  TD_NUM_CLASS,
  successTierForPct,
} from './plan-stress-test-chrome';
import {
  thStickyClass,
  thStickyNumClass,
} from '../pages/accounts-page-chrome';
import {
  useMarketStressComparison,
  type MarketStressComparisonVm,
} from './plan-market-stress-comparison';
import { PlanStressTestStressFanChart } from './PlanStressTestChart';
import { SegmentedRadioGroup } from './SegmentedRadioGroup';
import {
  STRESS_CASE_COPY,
  STRESS_CASE_IDS,
  longerLifeChangedText,
  stressExtendsHorizon,
  type StressCaseId,
} from '../lib/market-stress';
import { McProgressBar } from './McProgressBar';
import type { PlanStressTestVm } from './PlanStressTestSection';

/**
 * Success-probability delta pill under the headline number; nothing while the comparison is
 * pending, erroring or absent. Shares the unpaired-SE gate with `GuardrailsComparisonCallout`.
 */
export function GuardrailDeltaBadge({
  comparison,
}: {
  comparison: PlanStressTestVm['guardrailComparison'];
}) {
  if (comparison === undefined) return null;
  if (comparison.state === 'pending' || comparison.state === 'error') return null;
  const { withPct, withoutPct, deltaPct, se } = comparison;
  if (withPct === null || withoutPct === null || deltaPct === null || se === null) {
    return null;
  }
  const meaningful = Math.abs(deltaPct) > se;
  const deltaPp = Math.round(deltaPct * 100);
  // A meaningful delta can still round to 0 at whole-point precision; "0pp" would contradict the
  // badge, so it shows "no change".
  if (!meaningful || deltaPp === 0) {
    return (
      <Badge tone="neutral" className="mt-2">
        ≈ no change with guardrails
      </Badge>
    );
  }
  return (
    <Badge tone={deltaPp > 0 ? 'success' : 'disabled'} className="mt-2">
      {deltaPp > 0 ? `+${deltaPp}pp` : `${deltaPp}pp`} with guardrails
    </Badge>
  );
}

/** Success-probability headline card. */
export function PlanStressTestSuccessCard({ vm }: { vm: PlanStressTestVm }) {
  const dim = vm.isStale || vm.isRunning;
  return (
    <div
      className={`${STAT_BOX} flex h-full flex-col items-center justify-center text-center transition-opacity duration-150 ${
        dim ? 'opacity-50' : 'opacity-100'
      }`}
      aria-busy={dim}
    >
      <div className={`${STAT_LABEL} mb-2 flex items-center justify-center gap-1`}>
        Success probability
        <MonteCarloMethodologyModal />
      </div>
      <div
        className={`font-bold leading-none text-4xl sm:text-5xl lg:text-6xl ${STATUS_TEXT_CLASS[vm.successTier]}`}
      >
        {vm.successPct == null ? '—' : `${vm.successPct}%`}
      </div>
      <GuardrailDeltaBadge comparison={vm.guardrailComparison} />
    </div>
  );
}

/**
 * Typical, Pessimistic and Bad-luck "At retirement" cards, rendered as fragments in the host page's
 * `.stat-grid`.
 */
export function PlanStressTestRetirementCards({ vm }: { vm: PlanStressTestVm }) {
  const dim = vm.isStale || vm.isRunning;
  const boxClass = `${STAT_BOX} transition-opacity duration-150 ${
    dim ? 'opacity-50' : 'opacity-100'
  }`;
  return (
    <>
      <div className={boxClass} aria-busy={dim}>
        <div data-testid="stress-stat-label" className={STAT_LABEL}>At retirement: Typical</div>
        <div data-testid="stress-stat-value" className={STAT_VALUE}>
          {vm.startTypical != null ? formatCurrencyShort(vm.startTypical) : '—'}
        </div>
      </div>
      <div className={boxClass} aria-busy={dim}>
        <div data-testid="stress-stat-label" className={STAT_LABEL}>At retirement: Pessimistic</div>
        <div data-testid="stress-stat-value" className={STAT_VALUE}>
          {vm.startPessimistic != null
            ? formatCurrencyShort(vm.startPessimistic)
            : '—'}
        </div>
      </div>
      <div className={boxClass} aria-busy={dim}>
        <div data-testid="stress-stat-label" className={STAT_LABEL}>At retirement: Bad-luck</div>
        <div data-testid="stress-stat-value" className={STAT_VALUE}>
          {vm.startBadLuck != null ? formatCurrencyShort(vm.startBadLuck) : '—'}
        </div>
      </div>
    </>
  );
}

/**
 * Typical, Pessimistic and Bad-luck "At horizon" cards; a path that depletes before the last member
 * dies tints danger.
 */
export function PlanStressTestHorizonCards({ vm }: { vm: PlanStressTestVm }) {
  // Danger tint resolved against the live theme.
  const { resolvedTheme } = useTheme();
  const dangerHex = STATUS_HEX[resolvedTheme].danger;
  const dim = vm.isStale || vm.isRunning;
  const boxClass = `${STAT_BOX} transition-opacity duration-150 ${
    dim ? 'opacity-50' : 'opacity-100'
  }`;
  const lastDeathYear = vm.lastDeathYear;
  const typicalStatus = horizonStatus({
    balance: vm.endTypical,
    depletionYear: vm.typicalDepletionYear,
    lastDeathYear,
  });
  const pessimisticStatus = horizonStatus({
    balance: vm.endPessimistic,
    depletionYear: vm.pessimisticDepletionYear,
    lastDeathYear,
  });
  const badLuckStatus = horizonStatus({
    balance: vm.endBadLuck,
    depletionYear: vm.badLuckDepletionYear,
    lastDeathYear,
  });
  // Neutral ink by default; only a depleted path tints red.
  const dangerStyle = (isDanger: boolean): { color: string } | undefined =>
    isDanger ? { color: dangerHex } : undefined;
  const depletionLine = (year: number | null, balance: number | null): string => {
    if (balance === null) return '';
    return year !== null ? `Runs out ${year}` : 'Funds the full horizon';
  };
  const subLineClass =
    'mt-1 text-center text-sm text-muted';
  return (
    <>
      <div className={boxClass} aria-busy={dim}>
        <div
          data-testid="stress-stat-label"
          className={STAT_LABEL}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(typicalStatus.isDanger)}
        >
          At horizon: Typical
        </div>
        <div
          data-testid="stress-stat-value"
          className={STAT_VALUE}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(typicalStatus.isDanger)}
        >
          {vm.endTypical != null ? formatCurrencyShort(vm.endTypical) : '—'}
        </div>
        {vm.endTypical !== null && (
          <div
            className={subLineClass}
            // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
            style={dangerStyle(typicalStatus.isDanger)}
          >
            {depletionLine(vm.typicalDepletionYear, vm.endTypical)}
          </div>
        )}
      </div>
      <div className={boxClass} aria-busy={dim}>
        <div
          data-testid="stress-stat-label"
          className={STAT_LABEL}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(pessimisticStatus.isDanger)}
        >
          At horizon: Pessimistic
        </div>
        <div
          data-testid="stress-stat-value"
          className={STAT_VALUE}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(pessimisticStatus.isDanger)}
        >
          {vm.endPessimistic != null ? formatCurrencyShort(vm.endPessimistic) : '—'}
        </div>
        {vm.endPessimistic !== null && (
          <div
            className={subLineClass}
            // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
            style={dangerStyle(pessimisticStatus.isDanger)}
          >
            {depletionLine(vm.pessimisticDepletionYear, vm.endPessimistic)}
          </div>
        )}
      </div>
      <div className={boxClass} aria-busy={dim}>
        <div
          data-testid="stress-stat-label"
          className={STAT_LABEL}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(badLuckStatus.isDanger)}
        >
          At horizon: Bad-luck
        </div>
        <div
          data-testid="stress-stat-value"
          className={STAT_VALUE}
          // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
          style={dangerStyle(badLuckStatus.isDanger)}
        >
          {vm.endBadLuck != null ? formatCurrencyShort(vm.endBadLuck) : '—'}
        </div>
        {vm.endBadLuck !== null && (
          <div
            className={subLineClass}
            // eslint-disable-next-line no-restricted-syntax -- runtime danger tint computed at render from the horizon status (theme-reactive STATUS_HEX)
            style={dangerStyle(badLuckStatus.isDanger)}
          >
            {depletionLine(vm.badLuckDepletionYear, vm.endBadLuck)}
          </div>
        )}
      </div>
    </>
  );
}

function successPercentText(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

// Takes the two already-rounded whole percentages: differencing the raw probabilities can disagree
// by a point with the displayed readings.
function successDeltaText(stressPct: number, basePct: number): string {
  const pp = stressPct - basePct;
  if (pp === 0) return 'No change';
  return pp > 0 ? `+${pp}pp` : `${pp}pp`;
}

// Colour comes from the same rounded number the cell prints, so it never contradicts the sign.
function deltaToneClass(rounded: number): string {
  return rounded >= 0 ? 'text-positive' : 'text-negative';
}

// Terse because the column header says "Median path runs out". A null year is a median-path
// statistic, not a guarantee.
function depletionText(base: number | null, stress: number | null): string {
  if (stress === null) return 'Fully funded';
  if (base === null) return `${stress}`;
  const years = base - stress;
  if (years === 0) return `${stress} (unchanged)`;
  return `${stress} (${years > 0 ? `${years} yr sooner` : `${-years} yr later`})`;
}

// Rows for the render before the automatic walk is armed, so the table is never withheld while
// figures are coming.
const IDLE_ROWS: MarketStressComparisonVm['cases'] = STRESS_CASE_IDS.map(
  (caseId) => ({ caseId, state: 'pending', delta: null, summary: null, progress: null }),
);

/**
 * Market-stress comparison table: each stress runs against the same random paths as the base result
 * and reports success and shortfall deltas. Renders nothing until a base result exists.
 */
export function PlanStressTestMarketStress({
  vm,
  yScale = 'linear',
}: {
  vm: PlanStressTestVm;
  /** Y-axis scale of the page's charts, so a plotted stressed fan shares the base fan's axis. */
  yScale?: 'linear' | 'log';
}) {
  const [plotted, setPlotted] = useState<StressCaseId | 'none'>('none');
  // Hooks run before the early returns, so the states that render only a line must withhold the
  // input or the walk would arm behind them.
  const withheld =
    vm.hasNoAccounts || (vm.cbpValidation != null && !vm.cbpValidation.ok);
  const comparison = useMarketStressComparison({
    baseInput: withheld ? null : vm.stressBaseInput,
    baseResult: vm.result,
    baseSignature: vm.stressPairSignature,
    longestLivedBirthYear: vm.longestLivedBirthYear,
    baseRunInFlight: vm.isRunning,
  });
  // Remembered past the click because the retry button unmounts itself when the retry starts.
  const [retried, setRetried] = useState(false);
  if (vm.hasNoAccounts) return null;
  if (vm.cbpValidation && !vm.cbpValidation.ok) {
    // `PlanStressTestChart` already shows the remediation banner in this state; say only why the
    // comparison is unavailable.
    return (
      <p className="m-0 text-sm text-muted">
        Finish setting up the cash balance plan to compare against market
        stresses.
      </p>
    );
  }
  if (!comparison.canRun) {
    // Running the stress test cannot supply a birthdate, so name the missing input.
    if (vm.longestLivedBirthYear === null) {
      return (
        <p className="m-0 text-sm text-muted">
          Add each person&rsquo;s birthdate on the Household page to compare
          your plan against a longer life.
        </p>
      );
    }
    // A settled base run exists but the plan moved on.
    const supersededByAnEdit = vm.result !== null;
    return (
      <p className="m-0 text-sm text-muted">
        {supersededByAnEdit
          ? 'Your plan changed. The comparison is available again once the updated stress-test result is ready.'
          : 'Run the stress test first to compare your plan against higher fees, lower returns, higher inflation, and a longer life.'}
      </p>
    );
  }
  const readyCases = comparison.cases.filter((c) => c.summary !== null);
  // Re-running resets every case to pending, so a pick can outlive its option and React Aria's
  // RadioGroup would render with nothing checked. Fall back to "none" for display only and leave
  // `plotted` alone.
  const plottedReady = readyCases.some((c) => c.caseId === plotted);
  const selected = plotted === 'none' || plottedReady ? plotted : 'none';
  const plottedCase =
    selected === 'none'
      ? null
      : (comparison.cases.find((c) => c.caseId === selected) ?? null);
  // The longevity row names the last survivor's age, since the plan ends at their death; the cap
  // anchor stays the youngest member.
  const changedTextFor = (caseId: StressCaseId): string =>
    caseId === 'longerLife' &&
    vm.stressBaseInput !== null &&
    vm.longestLivedBirthYear !== null
      ? longerLifeChangedText(
          vm.stressBaseInput.horizonYear,
          vm.longestLivedBirthYear,
          vm.lastSurvivor,
        )
      : STRESS_CASE_COPY[caseId].changed;
  const rows = comparison.cases.length > 0 ? comparison.cases : IDLE_ROWS;
  const running = comparison.state === 'running';
  // A retry is the only action left: cases are cache-first on a seed-inclusive key, so re-running
  // an unchanged plan re-serves what is on screen.
  const anyError = rows.some((c) => c.state === 'error');
  // Stays mounted and disabled through its retry; unmounting under the pointer would drop focus to
  // `body`.
  const showRetry = anyError || (retried && running);
  return (
    <div className="flex flex-col gap-3">
      {(running || showRetry) && (
        <div className="flex flex-wrap items-center gap-3">
          {showRetry && (
            <button
              type="button"
              className={`report-print-hide ${btnSecondarySmClass} disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => {
                setRetried(true);
                comparison.run();
              }}
              disabled={running}
            >
              {/* Named for its table: the page's own error banner has a "Try again" button too. */}
              Try the market stress comparison again
            </button>
          )}
          {/* Not in a live region: the user did not start this work. `aria-busy` goes on the
              named table region, where it is exposed. */}
          {running && (
            <McProgressBar
              done={comparison.completed}
              total={comparison.total}
              label="Comparing market stresses"
              unit="done"
            />
          )}
        </div>
      )}
      {/* A retry is user-initiated, so its outcome is announced. */}
      {retried && (
        <div role="status" aria-live="polite" className="sr-only">
          {running
            ? 'Retrying the market stress comparison.'
            : anyError
              ? 'Some market stress comparisons are still unavailable.'
              : 'Market stress comparison finished.'}
        </div>
      )}
      <TableScroll label="Market stress comparison" busy={running}>
        <Table className={TABLE_CLASS} aria-label="Market stress comparison">
          <TableHeader>
            <Column isRowHeader className={`${thStickyClass} pl-4`}>
              Stress
            </Column>
            <Column className={thStickyClass}>What changes</Column>
            <Column className={thStickyNumClass}>Success</Column>
            <Column className={thStickyNumClass}>Change</Column>
            <Column className={`${thStickyClass} text-center`}>
              Median path runs out
            </Column>
          </TableHeader>
          <TableBody>
            {rows.map((c) => {
              const copy = STRESS_CASE_COPY[c.caseId];
              const d = c.delta;
              const successPp = d
                ? Math.round(d.stressSuccessProbability * 100) -
                  Math.round(d.baseSuccessProbability * 100)
                : 0;
              return (
                <Row key={c.caseId} id={c.caseId}>
                  <Cell className="pl-4">{copy.name}</Cell>
                  <Cell>{changedTextFor(c.caseId)}</Cell>
                  <Cell
                    className={`${TD_NUM_CLASS} ${
                      d
                        ? STATUS_TEXT_CLASS[
                            successTierForPct(
                              Math.round(d.stressSuccessProbability * 100),
                            )
                          ]
                        : ''
                    }`}
                  >
                    {d ? (
                      successPercentText(d.stressSuccessProbability)
                    ) : c.state === 'error' ? (
                      'Unavailable'
                    ) : c.progress ? (
                      // Path-level bar for the case on the worker; queued cases show "…".
                      <McProgressBar
                        done={c.progress.done}
                        total={c.progress.total}
                        label={`Comparing ${copy.name}`}
                        hideLabel
                        className="ml-auto flex w-24 flex-col"
                      />
                    ) : comparison.state === 'running' ? (
                      '…'
                    ) : (
                      '—'
                    )}
                  </Cell>
                  <Cell
                    className={`${TD_NUM_CLASS} ${d ? deltaToneClass(successPp) : ''}`}
                  >
                    {d
                      ? successDeltaText(
                          Math.round(d.stressSuccessProbability * 100),
                          Math.round(d.baseSuccessProbability * 100),
                        )
                      : '—'}
                  </Cell>
                  <Cell className={TD_CENTER_CLASS}>
                    {d
                      ? depletionText(
                          d.baseMedianDepletionYear,
                          d.stressMedianDepletionYear,
                        )
                      : '—'}
                  </Cell>
                </Row>
              );
            })}
        </TableBody>
      </Table>
      </TableScroll>
      {/* Above the chart it controls, so picking a case does not push the control out from
          under the pointer. */}
      {readyCases.length > 0 && (
        <SegmentedRadioGroup<StressCaseId | 'none'>
          size="sm"
          ariaLabel="Plot a stressed outcome band"
          value={selected}
          onChange={setPlotted}
          options={[
            { value: 'none', label: 'No stress plotted' },
            ...readyCases.map((c) => ({
              value: c.caseId,
              label: STRESS_CASE_COPY[c.caseId].name,
            })),
          ]}
        />
      )}
      {plottedCase?.summary && (
        <PlanStressTestStressFanChart
          caseName={STRESS_CASE_COPY[plottedCase.caseId].name}
          stressResult={plottedCase.summary}
          extendsHorizon={stressExtendsHorizon(plottedCase.caseId)}
          vm={vm}
          yScale={yScale}
        />
      )}
      {comparison.cases.length > 0 && (
        <p className="m-0 text-sm text-muted">
          Each comparison re-runs your plan with only that assumption changed,
          against the same simulated market histories as the result above, so
          the difference is the assumption and not luck. The longer-life row
          matches only up to the original end of your plan: the extra years
          use fresh market draws, and in those years Social Security and other
          income simply repeat their last dollar amount with no further
          cost-of-living increase, so their buying power falls. Those years also
          keep whichever tax return you were already filing rather than working
          out a new one. These are illustrations, not forecasts.
        </p>
      )}
    </div>
  );
}
