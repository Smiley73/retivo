import React from 'react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { TableScroll } from '../components/TableScroll';
import { Muted } from '../components/Muted';
import { AccountHistorySection } from './account-history-section';
import type { BalanceRow } from './AccountBalancesPage';
import type { AccountPayload, Aggregate } from '../db/types';
import { formatCurrency, formatCurrencyExact } from '../lib/format-currency';
import { formatPercent } from '../components/PercentInput';
import { NotesIndicator } from '../components/NotesIndicator';
import { Tooltip } from '../components/Tooltip';
import { WarningIcon } from '../components/icons';
import {
  PencilIcon,
  TrashIcon,
  iactEditClass,
  iactDeleteClass,
  tableClass,
  tdClass,
  tdNumClass,
  thClass,
  thNumClass,
  valueNegativeClass,
  valuePositiveClass,
} from './accounts-page-chrome';

interface BalanceTableProps {
  rows: BalanceRow[];
  account: Aggregate<AccountPayload>;
  onEdit: (b: BalanceRow) => void;
  onDelete: (b: BalanceRow) => void;
}

export const BalanceTable: React.FC<BalanceTableProps> = ({
  rows,
  account,
  onEdit,
  onDelete,
}) => {
  const active = account.payload.active === true;
  return (
    <>
      {/* scroll={false}: the active rows carry the hover-revealed .row-actions cluster (WebKit stuck-:hover bug, see TableScroll). */}
      <TableScroll label="Annual balance entries" scroll={false}>
        <Table aria-label="Annual balance entries" className={tableClass}>
          <TableHeader>
            <Column isRowHeader className={thClass}>Year</Column>
            <Column className={thNumClass}>Starting Balance</Column>
            <Column className={thNumClass}>Contributions</Column>
            <Column className={thNumClass}>Ending Balance</Column>
            <Column className={thNumClass}>Rollover</Column>
            <Column className={thNumClass}>Distributions</Column>
            <Column className={thNumClass}>Gain/Loss</Column>
            <Column className={thNumClass}>Return</Column>
            {active && (
              <Column className={thClass}>
                <span className="sr-only">Actions</span>
              </Column>
            )}
          </TableHeader>
          <TableBody>
            {rows.map((b) => {
              const sorted = [...rows].sort((a, c) => a.year - c.year);
              const idx = sorted.findIndex((s) => s.year === b.year);
              const prevYear = idx > 0 ? sorted[idx - 1] : null;
              const mismatch =
                prevYear && prevYear.endingBalance !== b.startingBalance;
              return (
                <Row
                  key={b.year}
                  id={String(b.year)}
                  className={
                    mismatch
                      ? 'group/row bg-surface-sunken'
                      : 'group/row'
                  }
                >
                  <Cell className={tdClass}>
                    <span className="inline-flex items-center gap-1.5">
                      {b.year}
                      <NotesIndicator notes={b.comment} />
                    </span>
                  </Cell>
                  <Cell
                    className={
                      mismatch
                        ? `${tdNumClass} font-medium ${valueNegativeClass}`
                        : tdNumClass
                    }
                  >
                    <span className="inline-flex items-center justify-end gap-1">
                      {formatCurrency(b.startingBalance)}
                      {mismatch && (
                        <Tooltip
                          multiline
                          content={
                            <>
                              <span className="block">
                                Previous year ({prevYear.year}) ending:{' '}
                                {formatCurrencyExact(prevYear.endingBalance)}
                              </span>
                              <span className="block">
                                This year starting:{' '}
                                {formatCurrencyExact(b.startingBalance)}
                              </span>
                            </>
                          }
                        >
                          <span
                            className="text-warning"
                            aria-label="Balance mismatch"
                          >
                            <WarningIcon />
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  </Cell>
                  <Cell className={tdNumClass}>
                    {formatCurrency(b.totalContributions)}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {formatCurrency(b.endingBalance)}
                  </Cell>
                  <Cell
                    className={
                      b.rollover < 0
                        ? `${tdNumClass} ${valueNegativeClass}`
                        : tdNumClass
                    }
                  >
                    {formatCurrency(b.rollover)}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {formatCurrency(b.distributions)}
                  </Cell>
                  <Cell
                    className={`${tdNumClass} font-medium ${
                      b.gainLoss < 0 ? valueNegativeClass : valuePositiveClass
                    }`}
                  >
                    {formatCurrency(b.gainLoss)}
                  </Cell>
                  <Cell
                    className={`${tdNumClass} font-medium ${
                      b.returnPct < 0
                        ? valueNegativeClass
                        : valuePositiveClass
                    }`}
                  >
                    {formatPercent(b.returnPct)}
                  </Cell>
                  {active && (
                    <Cell className={tdClass}>
                      <div className="row-actions items-center">
                        <button
                          type="button"
                          className={iactEditClass}
                          onClick={() => onEdit(b)}
                          aria-label={`Edit ${b.year}`}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          className={iactDeleteClass}
                          onClick={() => onDelete(b)}
                          aria-label={`Delete ${b.year}`}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </Cell>
                  )}
                </Row>
              );
            })}
          </TableBody>
        </Table>
      </TableScroll>
      <Muted as="p" className="mt-2 text-xs">
        Return % uses the Modified Dietz method: gain/loss divided by average capital
        (starting balance + ½ × contributions − ½ × distributions).
        For new accounts (starting balance = 0), full contributions are used as capital
        instead of half, since otherwise the return reads artificially high. Rollovers are
        excluded from the capital calculation since they represent transfers of existing
        assets. Distributions (e.g. withdrawals you take from the account) are added back to
        gain/loss because they represent spent capital, not market loss. They stay
        half-weighted in the denominator since they are outflows of already-deployed
        capital rather than basis.
      </Muted>
      <AccountHistorySection
        rows={rows.map((b) => ({
          year: b.year,
          endingBalance: b.endingBalance,
          returnPct: b.returnPct,
        }))}
      />
    </>
  );
};
