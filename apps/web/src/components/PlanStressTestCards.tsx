/**
 * Plan stress-test stat-card slot renderers, extracted from
 * `PlanStressTestSection.tsx` to keep that file under the shape limit.
 *
 * These are pure presentation components over the shared
 * `PlanStressTestVm` (built by `usePlanStressTestVm` in the section
 * module). They render the success-probability headline plus the
 * "At retirement" / "At horizon" Typical / Pessimistic / Bad-luck stat
 * tiles that interleave with the deterministic cards in the host page's
 * `.stat-grid`. No engine access, no hashing —
 * they read only off the resolved `vm`.
 *
 * Re-exported from `PlanStressTestSection.tsx` so existing importers and
 * the section's test suite keep their import paths unchanged.
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

/** Compact success-probability delta pill shown under the headline number
 *  when the active scenario enables spending guardrails. Reuses the same
 *  conservative unpaired-SE-bound "meaningful" gate as
 *  `GuardrailsComparisonCallout` (balance-projection-page-stats.tsx) — the
 *  headline pill and the detailed sentence under "Monte Carlo outcomes"
 *  read the same `guardrailComparison` VM, so they never disagree on
 *  whether a delta is signal. Renders nothing while the
 *  comparison is pending/erroring/absent — those transient states are
 *  already surfaced by the detailed callout further down the page. */
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
  // A statistically meaningful delta can still round to 0 at whole-point
  // display precision (e.g. a 0.3pp shift on a tiny SE) — showing "0pp"
  // would contradict the badge's own colour/sign, so it falls back to the
  // same "about the same" pill the sub-SE case renders.
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

/** Success-probability card. Sits next to the disclaimer at the top
 *  of the Balance Projection page. The percentage is the headline of
 *  the page — render it as an oversized, centered value. */
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
        {/* Show the rounded integer, not the one-decimal raw — keeps the
            headline number consistent with the colour band it drives. */}
        {vm.successPct == null ? '—' : `${vm.successPct}%`}
      </div>
      <GuardrailDeltaBadge comparison={vm.guardrailComparison} />
    </div>
  );
}

/** Three stat cards rendered as fragments inside the host page's
 *  "At retirement" `.stat-grid`: Typical, Pessimistic, Bad-luck. Labels
 *  follow the same `At retirement — <method>` shape as the deterministic
 *  cards next to them. All three render neutral/default ink — the
 *  at-retirement balance is always positive so no danger flip applies
 *  here. */
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

/** Three stat cards rendered as fragments inside the host page's
 *  "At horizon" StatGrid: Typical, Pessimistic, Bad-luck. Labels
 *  match the `At horizon — <method>` shape of the deterministic cards.
 *  All three render neutral/default ink; the only color is the danger
 *  flip (STATUS_HEX.danger) via the shared `horizonStatus` helper when
 *  the chosen percentile path depletes before the last surviving
 *  member dies. */
export function PlanStressTestHorizonCards({ vm }: { vm: PlanStressTestVm }) {
  // Danger tint resolved against the live theme — see the
  // STATUS_HEX doc comment.
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
  // Neutral by default; only a depleted/horizon-zero path tints the
  // card red. No inline color = the default stat ink.
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

/** Whole-percent success reading from an engine probability (0–1). */
function successPercentText(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/** Signed percentage-point change, or "no change" when it is zero.
 *  Sign convention matches `GuardrailDeltaBadge` above (plain ASCII sign).
 *
 *  Takes the two ALREADY-ROUNDED whole percentages, not the raw probabilities:
 *  rounding the difference independently of the two displayed readings lets the
 *  visible arithmetic disagree by a point (49.6 % → 50 % against 45.4 % → 45 %
 *  reads as "-4pp"). Differencing what is on screen keeps the row self-consistent. */
function successDeltaText(stressPct: number, basePct: number): string {
  const pp = stressPct - basePct;
  if (pp === 0) return 'No change';
  return pp > 0 ? `+${pp}pp` : `${pp}pp`;
}

/** Green at or above zero, red below — the reading the Change column carries.
 *  Applied off the SAME rounded number the cell prints, so the colour can never
 *  contradict the sign on screen. */
function deltaToneClass(rounded: number): string {
  return rounded >= 0 ? 'text-positive' : 'text-negative';
}

/**
 * How the money runs out under the stress, relative to the base run.
 *
 * Deliberately terse: the column header already says "Median path runs out", so
 * the cell repeats neither "median path" nor "runs out" and carries only the
 * year plus how it moved. A `null` depletion year is still a MEDIAN-PATH
 * statistic and not a guarantee — no more than half the simulated paths ran
 * out, so up to half of them still can — which is why the header keeps the
 * "median path" qualifier the cell drops.
 */
function depletionText(base: number | null, stress: number | null): string {
  if (stress === null) return 'Fully funded';
  if (base === null) return `${stress}`;
  const years = base - stress;
  if (years === 0) return `${stress} (unchanged)`;
  return `${stress} (${years > 0 ? `${years} yr sooner` : `${-years} yr later`})`;
}

/** The table's rows in the one render before the automatic walk is armed. The
 *  four stresses and the assumption each changes are worth reading on their
 *  own, so the table is never withheld while its figures are still coming. */
const IDLE_ROWS: MarketStressComparisonVm['cases'] = STRESS_CASE_IDS.map(
  (caseId) => ({ caseId, state: 'pending', delta: null, summary: null, progress: null }),
);

/**
 * Market-stress comparison. Each approved sensitivity is run against
 * the SAME random paths as the base result on screen — automatically, once that
 * result has settled — and reported as a success-probability and shortfall
 * delta.
 *
 * Colour reuses the page's existing success thresholds via
 * `STATUS_TEXT_CLASS`/`successTierForPct` semantics: the stressed success
 * reading carries the same green / amber / red banding as the headline number,
 * so a stress that drops the plan out of the safe band reads as such at a
 * glance. Renders nothing until a base result exists.
 */
export function PlanStressTestMarketStress({
  vm,
  yScale = 'linear',
}: {
  vm: PlanStressTestVm;
  /** Y-axis scale of the page's own charts, threaded through so a plotted
   *  stressed fan is drawn on the SAME axis as the base fan it is compared
   *  against — a log base chart beside a linear stressed one is not the
   *  like-for-like read this surface promises. */
  yScale?: 'linear' | 'log';
}) {
  // Which stressed run is plotted beneath the table. `'none'` (the default)
  // keeps the extra fan chart out of the DOM until asked for.
  const [plotted, setPlotted] = useState<StressCaseId | 'none'>('none');
  // Whether this surface renders a comparison AT ALL. The hook has to be called
  // before the early returns below (rules of hooks), so the states that render
  // an explanatory line instead of a table have to reach it as a withheld
  // INPUT — otherwise the walk arms behind a panel showing nothing but "Finish
  // setting up the cash balance plan" and quietly runs four 10,000-path
  // simulations. `stressBaseInput` does happen to be null in both states today,
  // but that is an invariant of a different module; this states it here, where
  // the cost is paid.
  const withheld =
    vm.hasNoAccounts || (vm.cbpValidation != null && !vm.cbpValidation.ok);
  const comparison = useMarketStressComparison({
    baseInput: withheld ? null : vm.stressBaseInput,
    baseResult: vm.result,
    baseSignature: vm.stressPairSignature,
    longestLivedBirthYear: vm.longestLivedBirthYear,
    baseRunInFlight: vm.isRunning,
  });
  // A retry is the one thing here the user initiates, so it is the one thing
  // worth announcing — and it has to be remembered past the click, because the
  // button unmounts itself the moment the retry starts.
  const [retried, setRetried] = useState(false);
  if (vm.hasNoAccounts) return null;
  if (vm.cbpValidation && !vm.cbpValidation.ok) {
    // The page renders this surface's heading for every scenario that has
    // accounts, so returning nothing here left a bordered section with a
    // heading and no content. `PlanStressTestChart` already shows the cash
    // balance plan remediation banner in exactly this state, so say only why
    // the comparison is unavailable rather than repeating the banner.
    return (
      <p className="m-0 text-sm text-muted">
        Finish setting up the cash balance plan to compare against market
        stresses.
      </p>
    );
  }
  if (!comparison.canRun) {
    // No member has a usable birthdate, so the longevity stress has no age to
    // anchor its cap on. Name the missing input: running the stress test
    // again can never supply it, so the "run it first" line below would send
    // the user after an action that cannot fix this state.
    if (vm.longestLivedBirthYear === null) {
      return (
        <p className="m-0 text-sm text-muted">
          Add each person&rsquo;s birthdate on the Household page to compare
          your plan against a longer life.
        </p>
      );
    }
    // A settled base run exists but the plan moved on: say so, rather than
    // telling the user to run a stress test they already ran. The birth year is
    // known by here, so a settled result is the only remaining discriminator.
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
  // The option set SHRINKS whenever the comparison re-runs — a re-run resets
  // every case to pending — so a pick made from the previous, longer set can
  // outlive its own option (plot "Longer life", let an edit or a retry restart
  // the walk, and the control re-appears offering only the first case to land).
  // React Aria's RadioGroup then renders with NOTHING checked, not even "No
  // stress plotted", so the user's visible selection silently vanishes from a
  // control that stays on screen. Fall back to "none" for DISPLAY only and
  // leave `plotted` alone, so the original pick returns the moment that case
  // resolves again.
  const plottedReady = readyCases.some((c) => c.caseId === plotted);
  const selected = plotted === 'none' || plottedReady ? plotted : 'none';
  const plottedCase =
    selected === 'none'
      ? null
      : (comparison.cases.find((c) => c.caseId === selected) ?? null);
  // The longevity row names the age the LAST SURVIVOR reaches — the plan ends
  // at their death, so those are the years being added to their life — instead
  // of the abstract age-105 ceiling, which binds only for a plan already
  // running past 100. The cap anchor stays the youngest member: it bounds how
  // far the stress may run, not whose life it extends. Both inputs are non-null
  // whenever `canRun` holds; the guard is for the type, and falls back to the
  // generic copy rather than a wrong age.
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
  // The walk starts on its own once the base run settles, so the table is
  // populated (or filling) whenever this renders; IDLE_ROWS covers only the
  // render before that effect is armed.
  const rows = comparison.cases.length > 0 ? comparison.cases : IDLE_ROWS;
  const running = comparison.state === 'running';
  // A retry is the ONLY thing left for a button to do. The comparison cannot be
  // usefully re-run otherwise: each case is cache-first on a seed-inclusive key
  // and a stress run is a pure function of its input, so a "Compare again"
  // button on an unchanged plan re-served the numbers already on screen. A
  // failed case, though, has nothing cached and may well succeed on a second
  // attempt — a worker crash or a per-case timeout is not a permanent verdict.
  const anyError = rows.some((c) => c.state === 'error');
  // The button stays MOUNTED and disabled through the retry it started, rather
  // than disappearing the instant `anyError` clears. Unmounting the control
  // under the pointer dropped keyboard focus to `document.body` at the exact
  // moment the user acted, and — with no live region on the automatic path —
  // left them with no evidence anything had happened at all.
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
              {/* Named for its table: the page's own stress-test error banner
                  carries a "Try again" button too, and out of context — a
                  screen reader's button list, say — the two were
                  indistinguishable. */}
              Try the market stress comparison again
            </button>
          )}
          {/* Coarse determinate bar in CASE units, with the per-row bars below
              carrying the path-level detail for the case actually on the
              worker — the same two-level shape the Scenarios "Recalculate all"
              toolbar uses. Deliberately NOT inside a `role="status"` live
              region, unlike that toolbar: nobody pressed anything on the
              automatic path, and announcing the progress and completion of
              work the user did not start would interrupt them on every page
              visit and after every settled edit. The table's scroll REGION
              carries `aria-busy` instead — a named landmark, where the
              attribute is exposed, rather than the role-less wrapper it sat on
              first, where assistive tech simply ignores it. */}
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
      {/* The exception to the no-live-region rule: a RETRY is user-initiated,
          so its outcome is exactly what the user is waiting to hear. Mounted
          only once one has been pressed. */}
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
            {/* Depletion here is the MEDIAN path's, not the whole plan's.
                Centred: its readings are neither prose nor a figure to compare
                down the column, so left-aligning them beside the right-aligned
                number columns sat oddly. */}
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
                      // Path-level bar for the case on the worker, mirroring
                      // the Scenarios list's in-flight row. Queued cases keep
                      // the "…" placeholder — they have no progress to show.
                      <McProgressBar
                        done={c.progress.done}
                        total={c.progress.total}
                        label={`Comparing ${copy.name}`}
                        hideLabel
                        className="ml-auto flex w-24 flex-col"
                      />
                    ) : comparison.state === 'running' ? (
                      // Queued behind a run that IS happening.
                      '…'
                    ) : (
                      // Not yet armed, or stood down while the page's own run
                      // works — a plain blank like every other unfilled column.
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
      {/* Control ABOVE the chart it controls, matching the page's own
          ordering: rendering it below meant picking a case inserted a
          full-height chart above the control, pushing it down the viewport
          out from under the user's pointer and focus. */}
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
