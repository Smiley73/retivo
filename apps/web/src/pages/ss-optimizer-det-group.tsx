/**
 * Deterministic-tab rendering helpers — extracted from
 * `ss-optimizer-page-chrome.tsx` so that file stays under the ≤400-ln
 * shape limit. Owns the parent + Planned/TWR child layout plus the
 * "collapse to single status row when both methods agree" rule (a
 * non-result outcome that is scenario-wide, e.g. `cbp-unconfigured`,
 * `no-retirement-date`, both-past-window — emitting two duplicate rows
 * would be visual noise).
 */
import React from 'react';
import { MethodChildRow, ScenarioParentRow } from './ss-optimizer-row-variants';
import type {
  OptimizerAggregates,
  ScenarioRow,
} from './ss-optimizer-page-chrome';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';

interface DetGroupArgs {
  readonly row: ScenarioRow;
  readonly aggregates: OptimizerAggregates;
  readonly hasSecondary: boolean;
  readonly onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  /** True while an optimizer run is in flight — disables the child Apply
   *  buttons so saving a scenario can't abort the sweep mid-run. */
  readonly running: boolean;
  readonly renderSingleRow: (row: ScenarioRow) => React.ReactElement;
}

/**
 * Returns the React rows for one deterministic-tab scenario. When both
 * methods produce the same scenario-wide non-result outcome the helper
 * synthesizes a single legacy single-row render via `renderSingleRow`
 * (the caller's `<OptimizerRow>` factory); otherwise it emits the
 * parent + two child rows.
 */
export function renderDeterministicGroup(
  args: DetGroupArgs,
): React.ReactElement[] {
  const { row, aggregates, hasSecondary, onApply, running, renderSingleRow } =
    args;
  if (!row.methods) return [];
  const collapsed = collapsedStatusFor(row);
  if (collapsed) {
    return [renderSingleRow({ ...row, result: collapsed, loading: false })];
  }
  return [
    <ScenarioParentRow key={`${row.scenario.id}-parent`} row={row} />,
    <MethodChildRow
      key={`${row.scenario.id}-planned`}
      row={row}
      aggregates={aggregates}
      method="planned"
      child={row.methods.planned}
      hasSecondary={hasSecondary}
      onApply={onApply}
      running={running}
    />,
    <MethodChildRow
      key={`${row.scenario.id}-twr`}
      row={row}
      aggregates={aggregates}
      method="twr"
      child={row.methods.twr}
      hasSecondary={hasSecondary}
      onApply={onApply}
      running={running}
    />,
  ];
}

/**
 * Returns a synthetic outbound when both methods agree on a non-result
 * outcome (empty / unsupported / error / both-past-window). The
 * TWR-insufficient variant is NOT collapsed — only the TWR child
 * carries that copy; Planned still has a real winner.
 */
function collapsedStatusFor(row: ScenarioRow): OptimizerWorkerOutbound | null {
  if (!row.methods) return null;
  const a = row.methods.planned.result;
  const b = row.methods.twr.result;
  if (!a || !b) return null;
  if (a.kind === 'result' && b.kind === 'result') {
    if (a.winner === null && b.winner === null) return a;
    return null;
  }
  if (a.kind === b.kind && a.kind !== 'twr-insufficient') return a;
  return null;
}
