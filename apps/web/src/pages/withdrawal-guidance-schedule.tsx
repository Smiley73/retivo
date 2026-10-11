/**
 * Projected withdrawals page — full year-by-year per-account schedule. A
 * show/hide disclosure button wrapping a React Aria `Table` inside the shared
 * `TableScroll` wrapper (locked sticky-thead pattern). One row per (year,
 * account) withdrawal line; the selected/current year is tinted. Extracted from
 * `WithdrawalGuidancePage` so the page stays under the file shape cap.
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
import { TableScroll } from '../components/TableScroll';
import { Muted } from '../components/Muted';
import {
  btnSecondarySmClass,
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from './accounts-page-chrome';
import type { GuidanceYearRow } from './withdrawal-guidance-data';

export interface WithdrawalGuidanceScheduleProps {
  readonly rows: ReadonlyArray<GuidanceYearRow>;
  readonly selectedYear: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Format a nominal-dollar value for display (applies the dollar-basis
   *  deflator + currency formatting). `year` drives today's-dollars deflation. */
  readonly formatAt: (dollars: number, year: number) => string;
}

/** Flatten the per-year rows into per-(year, account) display lines. */
interface ScheduleLine {
  readonly key: string;
  readonly year: number;
  readonly accountName: string;
  readonly withdrawnDollars: number;
  readonly rmdDollars: number;
  readonly endingBalanceDollars: number;
  /** MIXED accounts only: true when sub-account split data is available. */
  readonly isMixed?: boolean;
  /** MIXED named-strategy only: pre-tax portion of withdrawal (nominal dollars). */
  readonly preTaxWithdrawnDollars?: number;
  /** MIXED named-strategy only: post-tax/Roth portion of withdrawal (nominal
   *  dollars). Residual: `withdrawnDollars − preTaxWithdrawnDollars`. */
  readonly postWithdrawnDollars?: number;
  /** MIXED named-strategy only: label for the post bucket ('Roth' or
   *  'after-tax contributions (gains taxable)'). */
  readonly postLabel?: string;
}

function toLines(rows: ReadonlyArray<GuidanceYearRow>): ScheduleLine[] {
  const lines: ScheduleLine[] = [];
  for (const row of rows) {
    if (row.accounts.length === 0) {
      lines.push({
        key: `${row.year}:_none`,
        year: row.year,
        accountName: '—',
        withdrawnDollars: 0,
        rmdDollars: 0,
        endingBalanceDollars: 0,
      });
      continue;
    }
    for (const acc of row.accounts) {
      lines.push({
        key: `${row.year}:${acc.accountId}`,
        year: row.year,
        accountName: acc.accountName,
        withdrawnDollars: acc.withdrawnDollars,
        rmdDollars: acc.rmdDollars,
        endingBalanceDollars: acc.endingBalanceDollars,
        isMixed: acc.isMixed,
        preTaxWithdrawnDollars: acc.preTaxWithdrawnDollars,
        postWithdrawnDollars: acc.postWithdrawnDollars,
        postLabel: acc.postLabel,
      });
    }
  }
  return lines;
}

export const WithdrawalGuidanceSchedule: React.FC<
  WithdrawalGuidanceScheduleProps
> = ({ rows, selectedYear, open, onToggle, formatAt }) => {
  const lines = toLines(rows);
  return (
    <div className="mt-4">
      <button
        type="button"
        className={btnSecondarySmClass}
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? 'Hide full schedule' : 'Show full year-by-year schedule'}
      </button>
      {open && (
        <div className="mt-3">
          <TableScroll label="Year-by-year withdrawal schedule">
            <Table
              aria-label="Year-by-year withdrawal schedule"
              className={tableClass}
            >
              <TableHeader>
                <Column isRowHeader className={thStickyClass}>
                  Year
                </Column>
                <Column className={thStickyClass}>Account</Column>
                <Column className={thStickyNumClass}>Withdrawal</Column>
                <Column className={thStickyNumClass}>Required min.</Column>
                <Column className={thStickyNumClass}>Ending balance</Column>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <AriaRow
                    key={line.key}
                    className={
                      line.year === selectedYear
                        ? 'bg-surface-sunken font-medium'
                        : undefined
                    }
                  >
                    <Cell className={tdClass}>{line.year}</Cell>
                    <Cell className={tdClass}>{line.accountName}</Cell>
                    <Cell className={tdNumClass}>
                      <span className="flex flex-col items-end gap-0.5">
                        <span>{formatAt(line.withdrawnDollars, line.year)}</span>
                        {line.isMixed && line.preTaxWithdrawnDollars !== undefined && (
                          <Muted as="span" className="text-xs">
                            {formatAt(line.preTaxWithdrawnDollars, line.year)} pre-tax
                            {' · '}
                            {formatAt(line.postWithdrawnDollars ?? 0, line.year)}{' '}
                            {line.postLabel ?? 'post-tax'}
                          </Muted>
                        )}
                      </span>
                    </Cell>
                    <Cell className={tdNumClass}>
                      {line.rmdDollars > 0
                        ? formatAt(line.rmdDollars, line.year)
                        : '—'}
                    </Cell>
                    <Cell className={tdNumClass}>
                      {formatAt(line.endingBalanceDollars, line.year)}
                    </Cell>
                  </AriaRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
          <Muted as="p" className="mt-2 text-xs">
            The schedule spans every projected year. &ldquo;Required min.&rdquo;
            is the portion of the withdrawal that satisfies that account&rsquo;s
            required minimum distribution; &ldquo;Ending balance&rdquo; is the
            account balance after the year&rsquo;s withdrawal.
          </Muted>
        </div>
      )}
    </div>
  );
};
