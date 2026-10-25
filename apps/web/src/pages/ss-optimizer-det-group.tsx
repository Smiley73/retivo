/** Deterministic-tab rendering helpers: the parent + Planned/TWR child layout, collapsing to one status row when both methods agree on a scenario-wide non-result outcome. */
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
  readonly running: boolean;
  readonly renderSingleRow: (row: ScenarioRow) => React.ReactElement;
}

/** Returns the rows for one scenario: a single row via renderSingleRow when both methods agree on a non-result outcome, else the parent plus two children. */
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

// The collapsed outcome when both methods agree on a non-result; the TWR-insufficient variant is not collapsed, since Planned still has a real winner.
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
