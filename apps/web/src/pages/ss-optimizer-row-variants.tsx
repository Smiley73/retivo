/**
 * Optimizer table row variants for non-`ready` states. Extracted from
 * `ss-optimizer-page-chrome.tsx` to keep that file under the ≤400-ln
 * shape limit.
 */
import React from 'react';
import { Link } from 'react-router';
import { Cell, Row } from 'react-aria-components';
import type {
  ScenarioRow,
  UnsupportedReason,
  EmptyReason,
} from './ss-optimizer-page-chrome';
import {
  btnPrimarySmClass,
  tdClass,
  tdNumClass,
  valueNegativeClass,
} from './accounts-page-chrome';
import { textLinkClass } from '../components/TextLink';
import { McProgressBar } from '../components/McProgressBar';

const LINK_CLASS = textLinkClass;
// Re-export the dual-method child-row component from the sibling file
// so consumers (the chrome group renderer) keep their import surface.
export { MethodChildRow } from './ss-optimizer-method-child-row';

/** Smooth per-scenario path progress for the in-flight MC row. */
export interface RowProgress {
  readonly done: number;
  readonly total: number;
}

export const LoadingRow: React.FC<{
  row: ScenarioRow;
  /** Present while the MC sweep is simulating this scenario — renders a
   *  determinate per-row bar in the metric cell instead of plain text. */
  progress?: RowProgress;
}> = ({ row, progress }) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>
      {progress ? (
        <McProgressBar
          done={progress.done}
          total={progress.total}
          label="Calculating"
          hideLabel
          className="flex min-w-32 flex-col gap-1"
        />
      ) : (
        'Calculating…'
      )}
    </Cell>
    <Cell className={tdClass} />
  </Row>
);

/** Renders for scenarios the MC sweep did not finish before the user
 *  clicked Cancel. Distinct from LoadingRow so unprocessed scenarios
 *  don't keep showing "Calculating…" forever. */
export const CancelledRow: React.FC<{ row: ScenarioRow }> = ({ row }) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdNumClass}>—</Cell>
    <Cell className={tdClass}>
      <span className="text-sm text-muted">Cancelled</span>
    </Cell>
  </Row>
);

export const BothMissingPiaRow: React.FC<{ row: ScenarioRow }> = ({ row }) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={3}>
      Add PIAs on the{' '}
      <Link to="/social-security" className={LINK_CLASS}>
        Social Security page
      </Link>{' '}
      to include this scenario in the comparison.
    </Cell>
    <Cell className={tdClass}>
      <button type="button" disabled className={btnPrimarySmClass}>
        Save to scenario
      </button>
    </Cell>
  </Row>
);

export const ErrorRow: React.FC<{ row: ScenarioRow; message: string }> = ({
  row,
  message,
}) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={3}>
      <span className={valueNegativeClass}>Error: {message}</span>
    </Cell>
    <Cell className={tdClass} />
  </Row>
);

export const PastWindowRow: React.FC<{ row: ScenarioRow }> = ({ row }) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={3}>
      Past claim-age window
    </Cell>
    <Cell className={tdClass}>
      <button type="button" disabled className={btnPrimarySmClass}>
        Save to scenario
      </button>
    </Cell>
  </Row>
);

export const FEATURE_COPY: Record<UnsupportedReason, React.ReactNode> = {
  'cbp-unconfigured': (
    <>
      Comparison unavailable: this scenario has a Cash Balance Pension
      account whose election (lump-sum vs annuity) is still unresolved. Set
      the election in{' '}
      <Link to="/balance-projection" className={LINK_CLASS}>
        Balance Projection
      </Link>{' '}
      and the comparison will compute this row.
    </>
  ),
};

export const UnsupportedRow: React.FC<{
  row: ScenarioRow;
  reason: UnsupportedReason;
}> = ({ row, reason }) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={3}>
      {FEATURE_COPY[reason]}
    </Cell>
    <Cell className={tdClass}>
      <button type="button" disabled className={btnPrimarySmClass}>
        Save to scenario
      </button>
    </Cell>
  </Row>
);

export const EMPTY_REASON_COPY: Record<EmptyReason, { message: React.ReactNode }> = {
  'no-primary-member': {
    message: (
      <>
        Add a primary member on the{' '}
        <Link to="/household" className={LINK_CLASS}>
          Household
        </Link>{' '}
        page to include this scenario in the comparison.
      </>
    ),
  },
  'no-retirement-date': {
    message: (
      <>
        Set a primary retirement age on the{' '}
        <Link to="/scenarios" className={LINK_CLASS}>
          Scenarios
        </Link>{' '}
        page to include this scenario in the comparison.
      </>
    ),
  },
};

export const EmptyReasonRow: React.FC<{ row: ScenarioRow; reason: EmptyReason }> = ({
  row,
  reason,
}) => (
  <Row id={row.scenario.id}>
    <Cell className={tdClass}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={3}>
      {EMPTY_REASON_COPY[reason].message}
    </Cell>
    <Cell className={tdClass}>
      <button type="button" disabled className={btnPrimarySmClass}>
        Save to scenario
      </button>
    </Cell>
  </Row>
);

/** Parent row on the deterministic tab — carries the scenario name and
 *  spans the metric cells; the two `MethodChildRow` siblings render
 *  Planned / TWR underneath. */
export const ScenarioParentRow: React.FC<{ row: ScenarioRow }> = ({ row }) => (
  <Row id={`${row.scenario.id}-parent`}>
    <Cell className={`${tdClass} font-semibold`}>{row.scenario.payload.name}</Cell>
    <Cell className={tdClass} colSpan={4} />
  </Row>
);

/** TWR-insufficient row variant — surfaces when an active non-CBP
 *  account has under two years of balance history; the empirical TWR
 *  rate is undefined so the metric is unranked. The Planned child row
 *  is unaffected. */
export const TwrInsufficientRow: React.FC<{ id: string; label: string }> = ({
  id,
  label,
}) => (
  <Row id={id}>
    <Cell className={`${tdClass} pl-8`}>{label}</Cell>
    <Cell className={tdClass} colSpan={3}>
      <span className="text-muted">Insufficient history</span>
    </Cell>
    <Cell className={tdClass} />
  </Row>
);
