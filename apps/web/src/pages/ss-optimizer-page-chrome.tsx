/** Optimizer page chrome: the small UI subcomponents rendered inside the React Aria Table. */
import React from 'react';
import { CheckIcon, PlayIcon } from '../components/icons';
import { textLinkClass } from '../components/TextLink';
import { Link } from 'react-router';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Card } from '../components/Card';
import { TableScroll } from '../components/TableScroll';
import { Tooltip } from '../components/Tooltip';
import { formatCurrencyShort } from '../lib/format-currency';
import { formatPercent } from '../components/PercentInput';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import {
  btnPrimarySmClass,
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from './accounts-page-chrome';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import { useRowView, type EmptyReason, type RowView, type UnsupportedReason } from './ss-optimizer-row-view';

export type { EmptyReason, UnsupportedReason,  };
export type { RowProgress };
import {
  BothMissingPiaRow,
  CancelledRow,
  EmptyReasonRow,
  ErrorRow,
  LoadingRow,
  PastWindowRow,
  UnsupportedRow,
  type RowProgress,
} from './ss-optimizer-row-variants';
import { renderDeterministicGroup } from './ss-optimizer-det-group';
import { AgeTransition, MetricTransition } from './ss-optimizer-age-cell';

export type Metric = 'balance' | 'mc';

// Apply saves the scenario, which would abort a running sweep, so it is disabled mid-run; the balance variant must not tell users to cancel, since only the MC toolbar has Cancel.
const APPLY_RUNNING_TIP_MC =
  'Calculations in progress — cancel or wait for them to finish';
export const APPLY_RUNNING_TIP_DETERMINISTIC =
  'Calculations in progress — wait for them to finish';

export interface OptimizerAggregates {
  readonly scenarios: ScenarioAggregate[];
  readonly members: Aggregate<HouseholdMemberPayload>[];
  readonly accounts: Aggregate<AccountPayload>[];
  readonly balances: Aggregate<AccountBalancePayload>[];
  readonly ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
  readonly expenses: Aggregate<ExpensePayload>[];
  readonly incomeStreams: Aggregate<IncomeStreamPayload>[];
  readonly medicalCategoryIds: ReadonlyArray<string>;
}

export interface MethodChildResult {
  readonly loading: boolean;
  readonly result: OptimizerWorkerOutbound | null;
}

export interface ScenarioRow {
  readonly scenario: ScenarioAggregate;
  readonly parentName: string | null;
  readonly result: OptimizerWorkerOutbound | null;
  readonly loading: boolean;
  readonly cancelled?: boolean;
  readonly methods?: {
    readonly planned: MethodChildResult;
    readonly twr: MethodChildResult;
  };
}

function metricFormatter(metric: Metric): (value: number) => string {
  return metric === 'balance'
    ? formatCurrencyShort
    : (value: number) => formatPercent(value * 100);
}

const MetricCell: React.FC<{ view: RowView; metric: Metric }> = ({ view, metric }) => {
  if (view.kind !== 'ready') return <>—</>;
  return (
    <MetricTransition
      baseline={view.baselineMetricValue}
      recommended={view.winner.metricValue}
      format={metricFormatter(metric)}
    />
  );
};

interface OptimizerRowProps {
  row: ScenarioRow;
  aggregates: OptimizerAggregates;
  metric: Metric;
  hasSecondary: boolean;
  onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  progress?: RowProgress;
  running: boolean;
}

const OptimizerRow: React.FC<OptimizerRowProps> = ({
  row,
  aggregates,
  metric,
  hasSecondary,
  onApply,
  progress,
  running,
}) => {
  const view = useRowView(row, aggregates);
  if (view.kind === 'loading') return <LoadingRow row={row} progress={progress} />;
  if (view.kind === 'cancelled') return <CancelledRow row={row} />;
  if (view.kind === 'both-missing-pia') return <BothMissingPiaRow row={row} />;
  if (view.kind === 'past-window') return <PastWindowRow row={row} />;
  if (view.kind === 'unsupported') return <UnsupportedRow row={row} reason={view.reason} />;
  if (view.kind === 'empty') return <EmptyReasonRow row={row} reason={view.reason} />;
  if (view.kind === 'error') return <ErrorRow row={row} message={view.message} />;
  return (
    <Row id={row.scenario.id}>
      <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
      <Cell className={tdNumClass}>
        <PrimaryAgeCell view={view} />
      </Cell>
      <Cell className={tdNumClass}>
        <SecondaryAgeCell view={view} hasSecondary={hasSecondary} />
      </Cell>
      <Cell className={tdNumClass}>
        <MetricCell view={view} metric={metric} />
      </Cell>
      <Cell className={tdClass}>
        <ApplyButton
          row={row}
          view={view}
          onApply={onApply}
          running={running}
          metric={metric}
        />
      </Cell>
    </Row>
  );
};

const PrimaryAgeCell: React.FC<{ view: Extract<RowView, { kind: 'ready' }> }> = ({ view }) => {
  if (!view.primaryHasPia) {
    return (
      <span>
        PIA not set{' '}
        <Link to="/social-security" className={textLinkClass}>
          Add
        </Link>
      </span>
    );
  }
  return (
    <AgeTransition
      current={view.current.primary}
      recommendedYears={view.winner.primaryAgeYears}
      recommendedMonths={view.winner.primaryAgeMonths}
    />
  );
};

const SecondaryAgeCell: React.FC<{
  view: Extract<RowView, { kind: 'ready' }>;
  hasSecondary: boolean;
}> = ({ view, hasSecondary }) => {
  if (!hasSecondary) return <>—</>;
  if (!view.secondaryHasPia) {
    return (
      <span>
        PIA not set{' '}
        <Link to="/social-security" className={textLinkClass}>
          Add
        </Link>
      </span>
    );
  }
  if (view.winner.secondaryAgeYears === null) {
    return <>Past claim-age window</>;
  }
  return (
    <AgeTransition
      current={view.current.secondary}
      recommendedYears={view.winner.secondaryAgeYears}
      recommendedMonths={view.winner.secondaryAgeMonths}
    />
  );
};

interface ApplyButtonProps {
  row: ScenarioRow;
  view: Extract<RowView, { kind: 'ready' }>;
  onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  running: boolean;
  metric: Metric;
}

const ApplyButton: React.FC<ApplyButtonProps> = ({
  row,
  view,
  onApply,
  running,
  metric,
}) => {
  const className = `${btnPrimarySmClass} gap-1.5 min-w-24`;
  if (view.alreadyAtOptimum) {
    const inheritedTip =
      view.resolvedFromAncestor && view.parentName
        ? `Already at the highest modeled result (inherited from ${view.parentName})`
        : 'Already at the highest modeled result';
    return (
      <Tooltip content={inheritedTip}>
        <button type="button" disabled className={className}>
          <CheckIcon />
          Already set
        </button>
      </Tooltip>
    );
  }
  if (running) {
    const tip =
      metric === 'mc' ? APPLY_RUNNING_TIP_MC : APPLY_RUNNING_TIP_DETERMINISTIC;
    return (
      <Tooltip content={tip}>
        <button type="button" disabled className={className}>
          <PlayIcon />
          Save to scenario
        </button>
      </Tooltip>
    );
  }
  return (
    <button type="button" className={className} onClick={() => onApply(row)}>
      <PlayIcon />
      Save to scenario
    </button>
  );
};

interface OptimizerResultsTableProps {
  rows: ScenarioRow[];
  aggregates: OptimizerAggregates | null;
  metric: Metric;
  onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  rowProgress?: ReadonlyMap<string, RowProgress>;
  running: boolean;
}

// Re-exported from ss-optimizer-toolbars.tsx to keep the page's import surface intact.
export {
  OptimizerDisclaimerCard,
  OptimizerMcToolbar,
  OptimizerDetToolbar,
  OptimizerRunningNotice,
} from './ss-optimizer-toolbars';

export const OptimizerResultsTable: React.FC<OptimizerResultsTableProps> = ({
  rows,
  aggregates,
  metric,
  onApply,
  rowProgress,
  running,
}) => {
  if (!aggregates || aggregates.members.length === 0) {
    return (
      <Card>
        <p>
          Add household members on the{' '}
          <Link to="/household" className={textLinkClass}>
            Household
          </Link>{' '}
          page to include this scenario in the comparison.
        </p>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <p>No scenarios yet. Create one on the Scenarios page.</p>
      </Card>
    );
  }
  const hasSecondary = aggregates.members.some((m) => !m.payload.isPrimary);
  // Name the age columns after members; fall back to the role label when a member has no first name.
  const firstNameOf = (isPrimary: boolean): string | undefined =>
    aggregates.members
      .find((m) => !!m.payload.isPrimary === isPrimary)
      ?.payload.firstName?.trim() || undefined;
  const primaryAgeHeader = firstNameOf(true)
    ? `${firstNameOf(true)}'s age`
    : 'Primary age';
  const secondaryAgeHeader = firstNameOf(false)
    ? `${firstNameOf(false)}'s age`
    : 'Secondary age';
  const metricHeader = metric === 'balance' ? 'Ending Balance' : 'Plan success %';
  return (
    <TableScroll label="Social Security claim-age comparison results per scenario">
      <Table className={tableClass} aria-label="Social Security claim-age comparison results per scenario">
        <TableHeader>
          <Column isRowHeader className={thStickyClass}>
            Scenario
          </Column>
          <Column className={thStickyNumClass}>{primaryAgeHeader}</Column>
          <Column className={thStickyNumClass}>{secondaryAgeHeader}</Column>
          <Column className={thStickyNumClass}>{metricHeader}</Column>
          <Column className={thStickyClass}>
            <span className="sr-only">Actions</span>
          </Column>
        </TableHeader>
        <TableBody>
          {rows.flatMap((row) =>
            row.methods
              ? renderDeterministicGroup({
                  row,
                  aggregates,
                  hasSecondary,
                  onApply,
                  running,
                  renderSingleRow: (collapsed) => (
                    <OptimizerRow
                      key={row.scenario.id}
                      row={collapsed}
                      aggregates={aggregates}
                      metric={metric}
                      hasSecondary={hasSecondary}
                      onApply={onApply}
                      running={running}
                    />
                  ),
                })
              : [
                  <OptimizerRow
                    key={row.scenario.id}
                    row={row}
                    aggregates={aggregates}
                    metric={metric}
                    hasSecondary={hasSecondary}
                    onApply={onApply}
                    progress={rowProgress?.get(row.scenario.id)}
                    running={running}
                  />,
                ],
          )}
        </TableBody>
      </Table>
    </TableScroll>
  );
};

