/**
 * Deterministic-tab child row (`Planned` / `TWR`) + the apply-button
 * adapter that drives the per-method Apply flow. Extracted from
 * `ss-optimizer-row-variants.tsx` so each file stays under the ≤400-ln
 * shape limit. Sibling-file lives `ChildLoadingRow` / `ChildStatusRow`
 * scaffolding for the narrow non-result branches.
 */
import React from 'react';
import { CheckIcon, PlayIcon } from '../components/icons';
import { Link } from 'react-router';
import { Cell, Row } from 'react-aria-components';
import { Tooltip } from '../components/Tooltip';
import { formatCurrencyShort } from '../lib/format-currency';
import {
  btnPrimarySmClass,
  tdClass,
  tdNumClass,
  valueNegativeClass,
} from './accounts-page-chrome';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import { APPLY_RUNNING_TIP_DETERMINISTIC } from './ss-optimizer-page-chrome';
import type {
  MethodChildResult,
  OptimizerAggregates,
  ScenarioRow,
} from './ss-optimizer-page-chrome';
import {
  EMPTY_REASON_COPY,
  FEATURE_COPY,
  TwrInsufficientRow,
} from './ss-optimizer-row-variants';
import { AgeTransition, MetricTransition } from './ss-optimizer-age-cell';
import {
  claimAgeMatches,
  resolveCurrentClaimAges,
  type CurrentClaimAges,
} from './ss-optimizer-row-view';
import { textLinkClass } from '../components/TextLink';
import { PROJECTION_METHOD_LABELS } from '../lib/projection-method-labels';

const LINK_CLASS = textLinkClass;
const METHOD_LABEL: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

interface MethodChildRowProps {
  readonly row: ScenarioRow;
  readonly aggregates: OptimizerAggregates;
  readonly method: ProjectionMethod;
  readonly child: MethodChildResult;
  readonly hasSecondary: boolean;
  readonly onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  /** True while an optimizer run is in flight — disables Apply. */
  readonly running: boolean;
}

/** One of the two child rows that sit under each scenario parent on the
 *  deterministic tab (Planned + TWR). Dispatches per result-kind to a
 *  narrow sub-renderer so this top-level fn stays under the 40-line
 *  shape cap. */
export const MethodChildRow: React.FC<MethodChildRowProps> = ({
  row,
  aggregates,
  method,
  child,
  hasSecondary,
  onApply,
  running,
}) => {
  const id = `${row.scenario.id}-${method}`;
  const label = METHOD_LABEL[method];
  if (child.loading || !child.result) return <ChildLoadingRow id={id} label={label} />;
  const result = child.result;
  if (result.kind === 'twr-insufficient') return <TwrInsufficientRow id={id} label={label} />;
  if (result.kind === 'error') {
    return (
      <ChildStatusRow id={id} label={label}>
        <span className={valueNegativeClass}>Error: {result.message}</span>
      </ChildStatusRow>
    );
  }
  if (result.kind === 'empty') {
    return (
      <ChildStatusRow id={id} label={label}>
        {EMPTY_REASON_COPY[result.reason].message}
      </ChildStatusRow>
    );
  }
  if (result.kind === 'unsupported') {
    return (
      <ChildStatusRow id={id} label={label}>
        {FEATURE_COPY[result.reason]}
      </ChildStatusRow>
    );
  }
  if (!result.winner) {
    return (
      <ChildStatusRow id={id} label={label}>
        Past claim-age window
      </ChildStatusRow>
    );
  }
  return (
    <ChildResultRow
      id={id}
      label={label}
      row={row}
      method={method}
      result={result}
      winner={result.winner}
      aggregates={aggregates}
      hasSecondary={hasSecondary}
      onApply={onApply}
      running={running}
    />
  );
};

const ChildLoadingRow: React.FC<{ id: string; label: string }> = ({ id, label }) => (
  <Row id={id}>
    <Cell className={`${tdClass} pl-8`}>{label}</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>Calculating…</Cell>
    <Cell className={tdClass} />
  </Row>
);

const ChildStatusRow: React.FC<{
  id: string;
  label: string;
  children: React.ReactNode;
}> = ({ id, label, children }) => (
  <Row id={id}>
    <Cell className={`${tdClass} pl-8`}>{label}</Cell>
    <Cell className={tdClass} colSpan={3}>
      {children}
    </Cell>
    <Cell className={tdClass} />
  </Row>
);

interface ChildResultRowProps {
  readonly id: string;
  readonly label: string;
  readonly row: ScenarioRow;
  readonly method: ProjectionMethod;
  readonly result: Extract<
    NonNullable<MethodChildResult['result']>,
    { kind: 'result' }
  >;
  readonly winner: NonNullable<
    Extract<NonNullable<MethodChildResult['result']>, { kind: 'result' }>['winner']
  >;
  readonly aggregates: OptimizerAggregates;
  readonly hasSecondary: boolean;
  readonly onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  /** True while an optimizer run is in flight — disables Apply. */
  readonly running: boolean;
}

const ChildResultRow: React.FC<ChildResultRowProps> = ({
  id,
  label,
  row,
  method,
  result,
  winner,
  aggregates,
  hasSecondary,
  onApply,
  running,
}) => {
  const primary = aggregates.members.find((m) => m.payload.isPrimary);
  const secondary = aggregates.members.find((m) => !m.payload.isPrimary);
  const missingPia = result.missingPiaMembers;
  const primaryHasPia = primary !== undefined && !missingPia.includes(primary.id);
  const secondaryHasPia =
    secondary !== undefined && !missingPia.includes(secondary.id);
  const resolvedFromAncestor =
    row.scenario.payload.overrides.socialSecurity === undefined &&
    row.scenario.payload.parentScenarioId !== null;
  // Live current claim ages → "current → recommended" cell + applied state.
  // Derived from `aggregates` so applying a recommendation immediately
  // flips the row to "Applied" without trusting the engine's baked flag.
  const current = resolveCurrentClaimAges(row.scenario.id, aggregates.scenarios);
  const alreadyAtOptimum =
    claimAgeMatches(current.primary, winner.primaryAgeYears, winner.primaryAgeMonths) &&
    (!hasSecondary ||
      claimAgeMatches(
        current.secondary,
        winner.secondaryAgeYears,
        winner.secondaryAgeMonths,
      ));
  return (
    <Row id={id}>
      <Cell className={`${tdClass} pl-8`}>{label}</Cell>
      <Cell className={tdNumClass}>
        <PrimaryAgeChildCell
          hasPia={primaryHasPia}
          current={current.primary}
          age={winner.primaryAgeYears}
          months={winner.primaryAgeMonths}
        />
      </Cell>
      <Cell className={tdNumClass}>
        <SecondaryAgeChildCell
          hasSecondary={hasSecondary}
          hasPia={secondaryHasPia}
          current={current.secondary}
          age={winner.secondaryAgeYears}
          months={winner.secondaryAgeMonths}
        />
      </Cell>
      <Cell className={tdNumClass}>
        <MetricTransition
          baseline={result.baselineMetricValue}
          recommended={winner.metricValue}
          format={formatCurrencyShort}
        />
      </Cell>
      <Cell className={tdClass}>
        <MethodApplyButton
          row={row}
          method={method}
          alreadyAtOptimum={alreadyAtOptimum}
          parentName={row.parentName}
          resolvedFromAncestor={resolvedFromAncestor}
          onApply={onApply}
          running={running}
        />
      </Cell>
    </Row>
  );
};

const PrimaryAgeChildCell: React.FC<{
  hasPia: boolean;
  current: CurrentClaimAges['primary'];
  age: number;
  months: number | undefined;
}> = ({ hasPia, current, age, months }) =>
  hasPia ? (
    <AgeTransition
      current={current}
      recommendedYears={age}
      recommendedMonths={months}
    />
  ) : (
    <span>
      PIA not set{' '}
      <Link to="/social-security" className={LINK_CLASS}>
        Add
      </Link>
    </span>
  );

const SecondaryAgeChildCell: React.FC<{
  hasSecondary: boolean;
  hasPia: boolean;
  current: CurrentClaimAges['secondary'];
  age: number | null;
  months: number | undefined;
}> = ({ hasSecondary, hasPia, current, age, months }) => {
  if (!hasSecondary) return <>—</>;
  if (!hasPia) {
    return (
      <span>
        PIA not set{' '}
        <Link to="/social-security" className={LINK_CLASS}>
          Add
        </Link>
      </span>
    );
  }
  if (age === null) return <>Past claim-age window</>;
  return (
    <AgeTransition
      current={current}
      recommendedYears={age}
      recommendedMonths={months}
    />
  );
};

interface MethodApplyButtonProps {
  readonly row: ScenarioRow;
  readonly method: ProjectionMethod;
  readonly alreadyAtOptimum: boolean;
  readonly parentName: string | null;
  readonly resolvedFromAncestor: boolean;
  readonly onApply: (row: ScenarioRow, method?: ProjectionMethod) => void;
  /** True while an optimizer run is in flight — disables Apply. */
  readonly running: boolean;
}

const MethodApplyButton: React.FC<MethodApplyButtonProps> = ({
  row,
  method,
  alreadyAtOptimum,
  parentName,
  resolvedFromAncestor,
  onApply,
  running,
}) => {
  const className = `${btnPrimarySmClass} gap-1.5 min-w-24`;
  if (alreadyAtOptimum) {
    const tip =
      resolvedFromAncestor && parentName
        ? `Already at the highest modeled result (inherited from ${parentName})`
        : 'Already at the highest modeled result';
    return (
      <Tooltip content={tip}>
        <button type="button" disabled className={className}>
          <CheckIcon />
          Already set
        </button>
      </Tooltip>
    );
  }
  if (running) {
    // Method child rows are deterministic-tab only (the balance toolbar
    // has no Cancel button) → use the no-cancel copy.
    return (
      <Tooltip content={APPLY_RUNNING_TIP_DETERMINISTIC}>
        <button type="button" disabled className={className}>
          <PlayIcon />
          Save to scenario
        </button>
      </Tooltip>
    );
  }
  return (
    <button type="button" className={className} onClick={() => onApply(row, method)}>
      <PlayIcon />
      Save to scenario
    </button>
  );
};
