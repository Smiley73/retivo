/**
 * One row of the scenarios tree view, extracted from `ScenariosPage.tsx`
 * to keep that file under the ≤400-line shape limit.
 *
 * The row renders the Graphite Spectrum scenario card (the mock `.scn`):
 * a two-zone card sitting inside the pure-CSS connector rail.
 *  - **Top zone** (`.scn-top`): the scenario name + an inline "Active"
 *    chip on the active card, an optional description sub-line + the
 *    notes presentation, and a right-side hover-revealed icon-action
 *    cluster — Edit (pencil), Delete (trash). A card with a parent also
 *    carries an always-visible "Compare with parent" link-styled button
 *    under the name (outside the hover-revealed cluster); the page builds
 *    its handler, which makes the card active and opens the Compare tab.
 *    Switching the active scenario otherwise lives in the sidebar
 *    Active-Scenario picker.
 *  - **Footer zone** (`.scn-foot`): a "Plan success" metric leads, then four
 *    graph+value groups — **Planned** (deterministic), **Historical**
 *    (deterministic TWR), **Typical** (MC P50), **Pessimistic** (MC P25) —
 *    each pairing an at-horizon dollar value with a balance sparkline. The
 *    Planned + Historical at-horizon metrics + sparklines are filled LAZILY
 *    from the deterministic projection (Historical shows `—` when TWR is
 *    unavailable); MC metrics are read from the PERSISTED Monte Carlo cache
 *    (no worker on render — see scenarios-page-metrics.ts). On a cache hit
 *    the success percent shows, tinted by the shared green / amber / red
 *    tier (`successTierForPct`, same thresholds as the Dashboard +
 *    projection stress card); on a miss the card
 *    shows "—" plus a per-card "Recalculate" affordance that runs MC for
 *    just that scenario, with an inline progress bar while it runs.
 *
 * The row owns the connector rail rendering + the card presentation;
 * selection, edit-link href, the delete callback, and tree expansion
 * still live in the page.
 */
import React from 'react';
import { RefreshIcon } from '../components/icons';
import { useNavigate } from 'react-router';
import { Badge } from '../components/Badge';
import { Muted } from '../components/Muted';
import { NotesIndicator } from '../components/NotesIndicator';
import { formatCurrencyShort } from '../lib/format-currency';
import {
  PROJECTION_METHOD_LABELS,
  TWR_METHOD_LABEL,
} from '../lib/projection-method-labels';
import {
  STATUS_TEXT_CLASS,
  successTierForPct,
} from '../components/plan-stress-test-chrome';
import {
  iactEditClass,
  iactDeleteClass,
  PencilIcon,
  TrashIcon,
} from './accounts-page-chrome';
import { ScenarioSparkline } from './scenarios-page-sparkline';
import { McProgressBar } from '../components/McProgressBar';
import { btnSecondarySmClass } from '../components/dialog-chrome';
import { textLinkClass } from '../components/TextLink';
import type { ScenarioCardMetrics } from './scenarios-page-metrics';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

export interface ScenariosPageRowProps {
  scenario: ScenarioAggregate;
  ancestorIsLast: boolean[];
  isSelected: boolean;
  /** Deterministic metrics for this card. `undefined` while the lazy
   *  projection is still pending (the footer shows a `—` placeholder). */
  metrics: ScenarioCardMetrics | undefined;
  /** Delete this scenario (reuses the detail page's confirm + cascade).
   *  Omitted on the active card and the base scenario. */
  onDelete: (() => void) | null;
  /** Run Monte Carlo for THIS scenario on demand (per-card "Recalculate").
   *  `null` when MC can't run for the scenario (no recalc affordance). */
  onRecalc: (() => void) | null;
  /** True while THIS card's MC run is in flight — renders the inline
   *  progress bar in place of the Recalculate button. */
  isRecalculating: boolean;
  /** Path progress for this card's in-flight run (from the provider).
   *  Ignored unless `isRecalculating`. */
  recalcDone: number;
  recalcTotal: number;
  /** "Compare with parent" control: the parent's name (for the accessible
   *  name) and the activation handler. `null` for the base scenario and for
   *  a card whose parent is not in the loaded list — no control renders. */
  compareWithParent: { parentName: string; onActivate: () => void } | null;
}

export const ScenariosPageRow: React.FC<ScenariosPageRowProps> = ({
  scenario,
  ancestorIsLast,
  isSelected,
  metrics,
  onDelete,
  onRecalc,
  isRecalculating,
  recalcDone,
  recalcTotal,
  compareWithParent,
}) => {
  const navigate = useNavigate();
  const depth = ancestorIsLast.length;
  const name = scenario.payload.name;
  // Only the description renders as a sub-line under the name (when set).
  const description = (scenario.payload.description ?? '').trim();
  const endingBalance = metrics?.endingBalance;
  const historicalEndingBalance = metrics?.historicalEndingBalance;
  const hit = metrics?.planSuccessState === 'hit';
  // While this card recomputes, blank its MC graphs + values (the cached
  // numbers are about to be replaced) so Typical / Pessimistic read "—" just
  // like Plan success. The deterministic Planned line is unaffected by MC.
  const showMc = hit && !isRecalculating;
  // The deterministic series spans retirement..horizon; the MC series span
  // today..horizon (longer). Both end on the horizon year, so tail-slicing
  // the MC series to the deterministic length lands them on a shared axis.
  const planned = metrics?.series ?? [];
  // Historical = the deterministic TWR series. Like Planned it spans
  // retirement..horizon off the same shared ctx, so it shares the Planned
  // axis directly — no `alignToPlanned` tail-slice (that helper is MC-only).
  const historical = metrics?.historicalSeries ?? [];
  const alignToPlanned = (full: ReadonlyArray<number>): ReadonlyArray<number> =>
    full.length > planned.length ? full.slice(full.length - planned.length) : full;
  const typicalSeries = showMc ? alignToPlanned(metrics?.typicalSeries ?? []) : [];
  const pessimisticSeries = showMc
    ? alignToPlanned(metrics?.pessimisticSeries ?? [])
    : [];
  // Cached MC values follow the same hit / pending (undefined) / miss (null)
  // tri-state the metric blocks already use; a recompute reads as pending.
  const mcValue = (v: number | null | undefined): number | null | undefined =>
    isRecalculating ? undefined : hit ? v : metrics === undefined ? undefined : null;
  return (
    <div className="scenario-tree__row">
      {ancestorIsLast.map((isLast, i) => {
        const isConnector = i === depth - 1;
        const cls = isConnector
          ? `scenario-tree__slot scenario-tree__slot--connector${isLast ? ' is-last' : ''}`
          : isLast
            ? 'scenario-tree__slot'
            : 'scenario-tree__slot scenario-tree__slot--rail';
        return <span key={i} className={cls} aria-hidden="true" />;
      })}
      {/* The card flexes inside the connector rail via `flex-1`; the rail
          slots are fixed-width (`.scenario-tree__slot`, @layer base). The
          `group/row` marker opts the card into the hover-reveal row-actions
          pattern (styles.css). The mock's 16px radius / 20px padding ride
          arbitrary-value utilities (no default-scale token matches). */}
      <div
        // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock .scn geometry (16px radius, 20px padding) has no nearest-token equivalent
        className="group/row flex flex-1 flex-col rounded-[16px] border border-line bg-surface-raised p-[20px] shadow-sm"
        aria-current={isSelected ? 'true' : undefined}
      >
        {/* Top zone — name + Active chip + sub-lines on the left, the
            icon-action cluster on the right (the mock `.scn-top`). */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <strong className="text-base font-bold">{name}</strong>
              <NotesIndicator notes={scenario.payload.notes} />
              {isSelected && <Badge tone="success">Active</Badge>}
              {/* Recalc state rides next to the title: the progress bar while
                  recomputing (text-less; the accessible label still names what
                  is running), otherwise the Recalculate button on a cache miss
                  — they share this slot, mutually exclusive. */}
              {isRecalculating ? (
                <McProgressBar
                  done={recalcDone}
                  total={recalcTotal}
                  hideLabel
                  className="flex w-28 shrink-0 flex-col"
                  label={`Recalculating plan success for ${name}`}
                />
              ) : (
                onRecalc &&
                metrics !== undefined &&
                !(
                  metrics.planSuccessState === 'hit' &&
                  metrics.planSuccessPct !== null
                ) && (
                  <button
                    type="button"
                    className={`${btnSecondarySmClass} gap-1.5`}
                    onClick={onRecalc}
                    aria-label={`Recalculate plan success for ${name}`}
                  >
                    <RefreshIcon />
                    Recalculate
                  </button>
                )
              )}
            </div>
            {description.length > 0 && (
              <Muted className="text-sm">{description}</Muted>
            )}
            {compareWithParent && (
              <div>
                <button
                  type="button"
                  className={`${textLinkClass} text-sm`}
                  onClick={compareWithParent.onActivate}
                  aria-label={`Compare ${name} with parent ${compareWithParent.parentName}`}
                >
                  Compare with parent
                </button>
              </div>
            )}
          </div>
          <div className="row-actions flex-shrink-0">
            <button
              type="button"
              className={iactEditClass}
              onClick={() => navigate(`/scenarios/${scenario.id}`)}
              aria-label={`Edit ${name}`}
            >
              <PencilIcon />
            </button>
            {onDelete && (
              <button
                type="button"
                className={iactDeleteClass}
                onClick={onDelete}
                aria-label={`Delete ${name}`}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
        {/* Footer zone — Plan success leads, then four graph+value groups,
            one per outcome line: Planned (deterministic) · Historical
            (deterministic TWR) · Typical (MC P50) · Pessimistic (MC P25).
            Each group pairs its sparkline with its at-horizon dollar value;
            thin vertical dividers separate them (the mock `.scn-foot`). */}
        <div className="mt-5 flex flex-wrap items-start gap-x-6 gap-y-4">
          <PlanSuccessBlock
            metrics={metrics}
            isRecalculating={isRecalculating}
          />
          <ScenarioGraphMetric
            label={PROJECTION_METHOD_LABELS.planned}
            divided
            series={planned}
            value={endingBalance}
          />
          <ScenarioGraphMetric
            label={TWR_METHOD_LABEL}
            divided
            series={historical}
            value={historicalEndingBalance}
          />
          <ScenarioGraphMetric
            label="Typical"
            divided
            series={typicalSeries}
            value={mcValue(metrics?.typicalAtHorizon)}
          />
          <ScenarioGraphMetric
            label="Pessimistic"
            divided
            series={pessimisticSeries}
            value={mcValue(metrics?.pessimisticAtHorizon)}
          />
        </div>
        {metrics?.configError && (
          <p className="mt-3 text-sm text-warning">{metrics.configError}</p>
        )}
      </div>
    </div>
  );
};

/**
 * One footer outcome group: a label, then its sparkline paired with its
 * at-horizon dollar value to the right. The sparkline only paints when it
 * has ≥2 points (a cache miss / pending MC leaves Typical & Pessimistic
 * graph-less, showing just the `—` value); the line colours itself by its
 * own at-horizon solvency (green above $0, red at/below). `series` arrives
 * already tail-aligned to the deterministic (retirement..horizon) window.
 */
const ScenarioGraphMetric: React.FC<{
  label: string;
  series: ReadonlyArray<number>;
  value: number | null | undefined;
  divided?: boolean;
}> = ({ label, series, value, divided = false }) => {
  return (
    // Fixed width (border-box, so the `pl-3` divider gutter is included) so
    // every same-indentation card lays its footer columns at identical
    // offsets — the groups line up vertically down the tree. `shrink-0`
    // keeps the width when the row wraps on a narrow card.
    <div
      className={`flex w-44 shrink-0 flex-col gap-1.5 ${divided ? 'border-l border-line pl-3' : ''}`}
    >
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex items-center gap-2">
        {series.length >= 2 && <ScenarioSparkline series={series} />}
        <ScenarioValueText value={value} />
      </div>
    </div>
  );
};

/** The at-horizon dollar figure: `—` while pending (undefined) or on a miss
 *  (null), else the short-form currency — green when positive, red at/below
 *  $0, matching the sparkline's at-horizon colour rule. */
const ScenarioValueText: React.FC<{
  value: number | null | undefined;
}> = ({ value }) => {
  if (value === undefined) {
    return (
      <span
        className="text-base font-semibold font-mono tabular-nums text-muted"
        aria-hidden="true"
      >
        —
      </span>
    );
  }
  // `null` (a cache miss) shows a muted dash; a real number tracks the
  // sparkline colour — green above $0, red at/below.
  const colour =
    value === null
      ? 'text-muted'
      : value > 0
        ? 'text-positive'
        : 'text-negative';
  return (
    <span className={`text-base font-semibold font-mono tabular-nums ${colour}`}>
      {value === null ? '—' : formatCurrencyShort(value)}
    </span>
  );
};

/**
 * "Plan success" footer block. Renders one of:
 *  - the cached percent (red when < 70 %, per the mock) on a hit;
 *  - a muted "—" otherwise — while this card recomputes, while the lazy cache
 *    read is still pending, or on a miss. The progress bar and the
 *    Recalculate button both ride next to the card title, not here.
 */
const PlanSuccessBlock: React.FC<{
  metrics: ScenarioCardMetrics | undefined;
  isRecalculating: boolean;
}> = ({ metrics, isRecalculating }) => {
  const isHit =
    !isRecalculating &&
    metrics !== undefined &&
    metrics.planSuccessState === 'hit' &&
    metrics.planSuccessPct !== null;
  return (
    // Leads the footer row, so no left divider (the graph groups that follow
    // carry the dividers). Fixed width + `shrink-0` so this first column —
    // and therefore every column after it — aligns across same-indent cards.
    <div className="flex w-20 shrink-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted">
        Plan success
      </span>
      {isHit ? (
        <span
          className={`text-base font-semibold font-mono tabular-nums ${
            STATUS_TEXT_CLASS[
              successTierForPct(Math.round(metrics.planSuccessPct as number))
            ]
          }`}
        >
          {Math.round(metrics.planSuccessPct as number)}%
        </span>
      ) : (
        // Recomputing, lazy cache read unresolved, or a miss — a muted
        // placeholder either way (the Recalculate control lives by the title).
        <span
          className="text-base font-semibold font-mono tabular-nums text-muted"
          aria-hidden="true"
        >
          —
        </span>
      )}
    </div>
  );
};
