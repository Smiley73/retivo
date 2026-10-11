/**
 * Balance Projection page — per-account breakdown sub-section: a
 * show/hide disclosure button wrapping the "Projected at retirement"
 * per-account grid + totals row + hidden-account footer counts. Collapsed
 * by default (matching the year-by-year table). The projection method is
 * now chosen by the page-header "Basis" select (Graphite Spectrum
 * redesign) — the buried per-card method tab strip is gone, so the active
 * deterministic method arrives as a read-only prop. Extracted from
 * `balance-projection-page-yearly.tsx` to keep the yearly
 * section file under the file shape cap.
 */
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

/** Short tax-treatment label for the per-account breakdown column. */
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
  /** When an MC basis is the resolved basis, render an explanatory note
   *  instead of the per-account projected-at-retirement table (the MC engine
   *  runs a single pooled portfolio — no per-account counterpart). The
   *  expand/collapse toggle is hidden too. */
  readonly isMcBasisActive: boolean;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly primaryRetirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Disclosure state for the collapsible breakdown table. */
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
  // Under an MC basis the per-account projected-at-retirement table has
  // no counterpart (the MC engine runs a single pooled portfolio). Show a note
  // pointing the user back to a deterministic method instead of the table, and
  // hide the expand/collapse toggle.
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
      {/* Always mounted but `display:none`/out of the a11y tree when collapsed
         : print reveals only `.bp-print-expand[hidden]` so the table
          force-expands on paper without un-hiding unrelated DOM. */}
      <div hidden={!breakdownTableOpen} className="bp-print-expand">
      {/* Canonical scrollable card matching its sibling projection tables
          (year-by-year, tax detail): TableScroll + sticky headers. */}
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
              // Deflate at this owner's retirement year if known; the
              // page-level deflator collapses to 1 in "Future dollars"
              // mode so the nominal values pass through unchanged.
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
                    // Now inside a TableScroll region — pin the totals
                    // row to the bottom so it stays visible while the body
                    // scrolls (see "Tables" in docs/ui-conventions.md).
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
