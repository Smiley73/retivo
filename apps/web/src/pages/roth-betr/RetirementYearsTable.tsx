/**
 * Retirement-years BETR table. One row per projected drawdown
 * year that carries probeable tax state — year, T_now, T_future, n, BETR, the
 * all-in effective rate, and the per-tranche convert/hold verdict.
 *
 * Read-only. Rows missing `magiCents`/`taxableSsCents` or with n=0 are already
 * filtered out by `computeRetirementYearsBETR`, so every row here renders a
 * defined number (never NaN/blank).
 */
import React from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { TableScroll } from '../../components/TableScroll';
import { formatPercent } from '../../components/PercentInput';
import { tableClass, thStickyClass, thStickyNumClass, tdClass, tdNumClass } from '../accounts-page-chrome';
import type { BETRSource, RetirementYearBETRRow } from '../../lib/betr-calculator';
import {
  computeBETR,
  DEFAULT_DRAG_BY_SOURCE,
  DEFAULT_IRA_GROWTH_RATE,
} from '../../lib/betr-calculator';
import { comparisonLabel } from './betr-presentation-shared';

interface RetirementYearsTableProps {
  rows: readonly RetirementYearBETRRow[];
  source: BETRSource;
  dragPct: number;
  /** When set, from-IRA rows whose year is `<= year` fall before the owner's
   *  59½ boundary, so their break-even carries the 10% early-withdrawal penalty
   *  and a `†` marker; `firstName` names that owner in the footnote.
   *  Undefined → no penalty markers anywhere (today's behavior). */
  iraOwnerBoundary?: { year: number; firstName: string };
}

/** The drag fraction for the displayed source: the user's slider for the
 *  selected taxable variant, the Vanguard per-source default otherwise. */
function dragForSource(source: BETRSource, dragPct: number): number {
  if (source === 'taxEfficient' || source === 'taxInefficient') return dragPct / 100;
  return DEFAULT_DRAG_BY_SOURCE[source];
}

/** True when this row falls before/at the owner's 59½ boundary under the IRA
 *  source, so its from-IRA tax withholding carries the 10% penalty (the
 *  crossing year is inclusive). */
function rowIsPenalized(
  row: RetirementYearBETRRow,
  source: BETRSource,
  iraOwnerBoundary: { year: number; firstName: string } | undefined,
): boolean {
  return (
    source === 'ira' &&
    iraOwnerBoundary !== undefined &&
    row.drawdownYear.year <= iraOwnerBoundary.year
  );
}

/** Whole-year BETR for a row under the page's selected source variant. Applies
 *  the under-59½ penalty when the row falls before the IRA owner's 59½ boundary. */
function rowBetr(
  row: RetirementYearBETRRow,
  source: BETRSource,
  dragPct: number,
  iraOwnerBoundary?: { year: number; firstName: string },
): number {
  return computeBETR(source, row.T_now, row.n, DEFAULT_IRA_GROWTH_RATE, {
    dragPct: dragForSource(source, dragPct),
    under59Penalty: rowIsPenalized(row, source, iraOwnerBoundary),
  });
}

/** Verdict for the DISPLAYED source/drag: convert when `T_future > BETR`.
 *  Derived from the same `rowBetr` the
 *  Break-even column shows — forwarding the same `iraOwnerBoundary` — so the two
 *  columns can never disagree, penalized rows included. */
function rowVerdict(
  row: RetirementYearBETRRow,
  source: BETRSource,
  dragPct: number,
  iraOwnerBoundary?: { year: number; firstName: string },
): 'Convert' | 'Hold' {
  return row.T_future > rowBetr(row, source, dragPct, iraOwnerBoundary) ? 'Convert' : 'Hold';
}

export const RetirementYearsTable: React.FC<RetirementYearsTableProps> = ({
  rows,
  source,
  dragPct,
  iraOwnerBoundary,
}) => {
  const anyRowPenalized = rows.some((row) => rowIsPenalized(row, source, iraOwnerBoundary));
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No retirement years carry the income and tax detail needed for a per-year
        break-even analysis yet.
      </p>
    );
  }
  return (
    <>
      <TableScroll label="Per-year retirement break-even tax rate table">
        <Table aria-label="Per-year retirement break-even tax rate table" className={tableClass}>
          <TableHeader>
            <Column isRowHeader className={thStickyClass}>
              Year
            </Column>
            <Column className={thStickyNumClass}>Convert-now rate</Column>
            <Column className={thStickyNumClass}>RMD-era rate</Column>
            <Column className={thStickyNumClass}>Growth years</Column>
            <Column className={thStickyNumClass}>Break-even rate</Column>
            <Column className={thStickyNumClass}>All-in rate</Column>
            <Column className={thStickyClass}>Comparison</Column>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <Row key={row.drawdownYear.year}>
                <Cell className={tdClass}>{row.drawdownYear.year}</Cell>
                <Cell className={tdNumClass}>{formatPercent(row.T_now * 100)}</Cell>
                <Cell className={tdNumClass}>{formatPercent(row.T_future * 100)}</Cell>
                <Cell className={tdNumClass}>{row.n}</Cell>
                <Cell className={tdNumClass}>
                  {formatPercent(rowBetr(row, source, dragPct, iraOwnerBoundary) * 100)}
                  {rowIsPenalized(row, source, iraOwnerBoundary) && (
                    <>
                      <span aria-hidden="true">&thinsp;†</span>
                      <span className="sr-only">
                        {' '}
                        before 59½ penalty applies; see note below
                      </span>
                    </>
                  )}
                </Cell>
                <Cell className={tdNumClass}>{formatPercent(row.allInRate * 100)}</Cell>
                <Cell className={tdClass}>
                  {comparisonLabel(rowVerdict(row, source, dragPct, iraOwnerBoundary))}
                </Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      <dl className="mt-3 space-y-1 text-xs text-muted">
        <div>
          <dt className="inline font-medium text-ink">Convert-now rate</dt>{' '}
          <dd className="inline">
            — your marginal federal tax rate if you convert in that year.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">RMD-era rate</dt>{' '}
          <dd className="inline">
            — the average marginal rate you'd otherwise pay later, once required
            minimum distributions begin.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Growth years</dt>{' '}
          <dd className="inline">
            — how long the converted money keeps compounding tax-free, from that
            year to your life expectancy.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Break-even rate</dt>{' '}
          <dd className="inline">
            — the future tax rate at which converting now exactly breaks even.
            The Comparison column shows whether the RMD-era rate is above the
            modeled break-even rate in that year.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">All-in rate</dt>{' '}
          <dd className="inline">
            — a modeled, federal-only estimate of the cost of converting, layering
            Social Security taxation, IRMAA Medicare surcharges, and ACA
            premium-credit effects on top of federal income tax. It excludes state
            tax and other factors, so it is an approximation, not a complete cost.
          </dd>
        </div>
        {anyRowPenalized && iraOwnerBoundary !== undefined && (
          <div>
            <dt className="inline font-medium text-ink">†</dt>{' '}
            <dd className="inline">
              — before 59½ (through {iraOwnerBoundary.year}, including{' '}
              {iraOwnerBoundary.firstName}), paying the conversion tax from the IRA
              adds a 10% early-withdrawal penalty to that tax, so the break-even is
              higher. Paying it from cash or a taxable account avoids the penalty;
              a §72(t) exception can be marked exempt in the Tax-assumptions
              settings.
            </dd>
          </div>
        )}
      </dl>
    </>
  );
};
