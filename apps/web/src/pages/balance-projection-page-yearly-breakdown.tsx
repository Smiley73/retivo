/** Per-account breakdown sub-section: a show/hide disclosure wrapping the "Projected at retirement" per-account grid, totals row and hidden-account footer counts, collapsed by default. The active method arrives as a read-only prop from the page-header Basis select. */
import React from 'react';
import {
  Cell,
  Column,
  Row as AriaRow,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Tooltip } from '../components/Tooltip';
import { Muted } from '../components/Muted';
import { WarningIcon } from '../components/icons';
import { TableScroll } from '../components/TableScroll';
import { formatCurrency } from '../lib/format-currency';
import {
  PROJECTION_METHOD_LABELS,
  TWR_METHOD_LABEL,
} from '../lib/projection-method-labels';
import { assertNever } from '../lib/assert-never';
import type { AccountTaxTreatment } from '../db/types';
import type { ProjectionMethod } from '../components/ProjectionChart';
import {
  btnSecondarySmClass,
  rowStickyBottomClass,
  rowTotalsClass,
  stripeRowFor,
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from './accounts-page-chrome';
import type {
  BalanceProjectionMethodTotal,
  BreakdownAccountRow,
} from './balance-projection-page-yearly';

const METHOD_TOTAL_LABELS: Readonly<Record<ProjectionMethod, string>> =
  PROJECTION_METHOD_LABELS;

function treatmentShortLabel(tt: AccountTaxTreatment): string {
  switch (tt) {
    case 'PRE_TAX':
      return 'Deferred';
    case 'POST_TAX':
      return 'Taxable';
    case 'MIXED':
      return 'Mixed';
    case 'HSA':
      return 'HSA';
    case 'ROTH':
      return 'Roth';
    default:
      return assertNever(tt);
  }
}

export interface BalanceProjectionYearlyBreakdownProps {
  readonly accountRows: ReadonlyArray<BreakdownAccountRow>;
  readonly activeMethod: ProjectionMethod;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  /** Under an MC basis an explanatory note replaces the table and the toggle is hidden (the MC engine runs one pooled portfolio). */
  readonly isMcBasisActive: boolean;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly primaryRetirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  readonly breakdownTableOpen: boolean;
  readonly onToggleBreakdownTable: () => void;
}

export const BalanceProjectionYearlyBreakdown: React.FC<
  BalanceProjectionYearlyBreakdownProps
> = ({
  accountRows,
  activeMethod,
  displayedTotals,
  isMcBasisActive,
  hiddenInactiveCount,
  hiddenZeroHistoryCount,
  primaryRetirementYear,
  viewDeflator,
  breakdownTableOpen,
  onToggleBreakdownTable,
}) => {
  const totalFactor =
    primaryRetirementYear !== null ? viewDeflator(primaryRetirementYear, 11) : 1;
  if (isMcBasisActive) {
    return (
      <Muted as="p" className="m-0 text-sm">
        Per-account breakdown is not available for Monte Carlo scenarios. Switch
        to a deterministic method to view it.
      </Muted>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`report-print-hide ${btnSecondarySmClass} self-start`}
        aria-expanded={breakdownTableOpen}
        onClick={onToggleBreakdownTable}
      >
        {breakdownTableOpen
          ? 'Hide account-by-account projection'
          : 'Show account-by-account projection'}
      </button>
      {/* Always mounted but hidden when collapsed; print reveals only .bp-print-expand[hidden]. */}
      <div hidden={!breakdownTableOpen} className="bp-print-expand">
      <TableScroll label="Projected at retirement: account-by-account">
      <Table
        className={tableClass}
        aria-label={`Projected at retirement: ${METHOD_TOTAL_LABELS[activeMethod]}`}
      >
        <TableHeader>
          <Column isRowHeader className={thStickyClass}>Account</Column>
          <Column className={thStickyClass}>Owner</Column>
          <Column className={thStickyClass}>Tax</Column>
          <Column className={thStickyNumClass}>Today</Column>
          <Column className={thStickyNumClass}>Projected: Pre-tax</Column>
          <Column className={thStickyNumClass}>Projected: Post-tax</Column>
          <Column className={thStickyNumClass}>Projected: Total</Column>
        </TableHeader>
        <TableBody>
          {[
            ...accountRows.map((row, i) => {
              const out = row.outputs[activeMethod];
              const showWarning =
                row.hasInsufficientHistory && activeMethod !== 'planned';
              // The page-level deflator collapses to 1 in Future dollars, so nominal values pass through.
              const accountRetirementYear = row.ownerRetirementDate
                ? Number(row.ownerRetirementDate.slice(0, 4))
                : primaryRetirementYear;
              const rowFactor =
                accountRetirementYear !== null
                  ? viewDeflator(accountRetirementYear, 11)
                  : 1;
              return (
                <AriaRow
                  key={row.account.id}
                  id={row.account.id}
                  className={stripeRowFor(i)}
                >
                  <Cell className={tdClass}>{row.account.payload.name}</Cell>
                  <Cell className={tdClass}>{row.ownerDisplay}</Cell>
                  <Cell className={tdClass}>
                    {treatmentShortLabel(row.account.payload.taxTreatment)}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {row.latestBalance !== null
                      ? formatCurrency(row.latestBalance)
                      : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {out ? formatCurrency(out.preTax * rowFactor) : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {out ? formatCurrency(out.postTax * rowFactor) : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    <span className="inline-flex items-center justify-end gap-1">
                      {out ? formatCurrency(out.total * rowFactor) : '—'}
                      {showWarning && (
                        <Tooltip
                          multiline
                          content={
                            'This account uses its planned return here — it ' +
                            "doesn't have 2+ years of balance history yet to " +
                            'estimate an actual return. Its projected balance ' +
                            `is included in the ${TWR_METHOD_LABEL} total at ` +
                            'the planned rate.'
                          }
                        >
                          <span
                            aria-label="Insufficient history for this method"
                            className="inline-flex text-warning"
                          >
                            <WarningIcon />
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  </Cell>
                </AriaRow>
              );
            }),
            ...(displayedTotals
              ? [
                  <AriaRow
                    key="__totals"
                    id="__totals"
                    data-totals="true"
                    className={`${rowTotalsClass} ${rowStickyBottomClass}`}
                  >
                    <Cell className={tdClass}>Total</Cell>
                    <Cell className={tdClass}></Cell>
                    <Cell className={tdClass}></Cell>
                    <Cell className={tdNumClass}>
                      {formatCurrency(
                        accountRows.reduce(
                          (sum, r) => sum + (r.latestBalance ?? 0),
                          0,
                        ),
                      )}
                    </Cell>
                    <Cell className={tdNumClass}>
                      {formatCurrency(
                        accountRows.reduce(
                          (sum, r) => sum + (r.outputs[activeMethod]?.preTax ?? 0),
                          0,
                        ) * totalFactor,
                      )}
                    </Cell>
                    <Cell className={tdNumClass}>
                      {formatCurrency(
                        accountRows.reduce(
                          (sum, r) => sum + (r.outputs[activeMethod]?.postTax ?? 0),
                          0,
                        ) * totalFactor,
                      )}
                    </Cell>
                    <Cell className={tdNumClass}>
                      {formatCurrency(displayedTotals[activeMethod].total)}
                    </Cell>
                  </AriaRow>,
                ]
              : []),
          ]}
        </TableBody>
      </Table>
      </TableScroll>

      {(hiddenInactiveCount > 0 ||
        hiddenZeroHistoryCount > 0 ||
        (displayedTotals && displayedTotals[activeMethod].plannedRateCount > 0)) && (
        <div className="text-sm text-muted">
          {hiddenInactiveCount > 0 && (
            <p className="my-1">
              {hiddenInactiveCount} inactive account
              {hiddenInactiveCount === 1 ? '' : 's'} hidden (zero balance).
            </p>
          )}
          {hiddenZeroHistoryCount > 0 && (
            <p className="my-1">
              {hiddenZeroHistoryCount} account
              {hiddenZeroHistoryCount === 1 ? '' : 's'} hidden. No balance history yet.
            </p>
          )}
          {displayedTotals &&
            displayedTotals[activeMethod].plannedRateCount > 0 &&
            activeMethod !== 'planned' && (
              <p className="my-1">
                {displayedTotals[activeMethod].plannedRateCount} account
                {displayedTotals[activeMethod].plannedRateCount === 1 ? '' : 's'} use
                {displayedTotals[activeMethod].plannedRateCount === 1 ? 's' : ''} their
                planned return here. Needs at least 2 years of history for an
                actual return.
              </p>
            )}
        </div>
      )}
      </div>
    </>
  );
};
