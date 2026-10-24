/** Year-by-year table sub-section: the MAGI-cap breach banner, the show/hide disclosure and the collapsible TableScroll projection table. */
import React from 'react';
import {
  Cell,
  Column,
  Row as AriaRow,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Alert } from '../components/Alert';
import { TableScroll } from '../components/TableScroll';
import { Tooltip } from '../components/Tooltip';
import { WarningIcon, InfoIcon } from '../components/icons';
import { formatCurrency } from '../lib/format-currency';
import type { DisplayMode } from '../lib/view-deflator';
import type { ProjectionMethod } from '../components/ProjectionChart';
import {
  btnSecondarySmClass,
  stripeRowFor,
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
  valueNegativeClass,
} from './accounts-page-chrome';
import type { YearlyTableRow } from './balance-projection-page-yearly';

export interface BalanceProjectionYearlyTableProps {
  readonly activeMethod: ProjectionMethod;
  readonly yearTableOpen: boolean;
  readonly onToggleYearTable: () => void;
  readonly yearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly displayMode: DisplayMode;
  readonly magiCapBreachYears?: ReadonlyArray<number>;
  readonly isMagiCapActive?: boolean;
}

export const BalanceProjectionYearlyTable: React.FC<
  BalanceProjectionYearlyTableProps
> = ({
  activeMethod,
  yearTableOpen,
  onToggleYearTable,
  yearTableRows,
  displayMode,
  magiCapBreachYears,
  isMagiCapActive = false,
}) => {
  // Hidden entirely unless some year has a conversion (Fill mode ran), so a Minimize or no-cap scenario never renders an always-empty column.
  const showRothConverted = yearTableRows.some((r) => (r.rothConverted ?? 0) > 0);
  const breachCount = magiCapBreachYears?.length ?? 0;
  const breachBanner =
    breachCount > 0 && magiCapBreachYears ? (
      (() => {
        const sorted = [...magiCapBreachYears].sort((a, b) => a - b);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const yearRange = first === last ? `${first}` : `${first}–${last}`;
        return (
          <Alert tone="warning">
            Cap breached in {breachCount} year
            {breachCount === 1 ? '' : 's'} ({yearRange}), taxable depleted,
            drew from pre-tax to meet spending.
          </Alert>
        );
      })()
    ) : null;

  return (
    <>
      {breachBanner}
      <button
        type="button"
        className={`report-print-hide ${btnSecondarySmClass} mt-3 self-start`}
        aria-expanded={yearTableOpen}
        onClick={onToggleYearTable}
      >
        {yearTableOpen ? 'Hide year-by-year table' : 'Show year-by-year table'}
      </button>
      {/* Always mounted but hidden when collapsed; print reveals only .bp-print-expand[hidden]. */}
      <div hidden={!yearTableOpen} className="bp-print-expand">
        <TableScroll label="Year-by-year projection table">
          <Table className={tableClass} aria-label="Year-by-year projection">
            <TableHeader>
              <Column isRowHeader className={thStickyClass}>Year</Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="Income arriving from outside your savings: Social Security, pensions, part-time / earned, and one-off windfalls (e.g. inheritance)."
                >
                  Earned
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="The year's net need, expenses minus earned income, met from your retirement accounts. Actual portfolio outflow (which can differ slightly in a partial or transition year) is shown in the Annual Portfolio Flow chart. Reflects the selected Income method."
                >
                  Withdrawal
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="Earned income plus portfolio withdrawal, every dollar that lands in the household budget that year."
                >
                  Total income
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content={
                    displayMode === 'today'
                      ? "Annual essential + discretionary spending for the year, in today's dollars, the amount you entered with any discretionary adjustment and discretionary spending glide applied; inflation removed."
                      : 'Annual essential + discretionary spending for the year, in future dollars, with inflation, any discretionary adjustment, and any discretionary spending glide applied.'
                  }
                >
                  Expenses
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="The unfunded gap when your portfolio runs out and total income can't cover expenses. Zero in funded years."
                >
                  Shortfall
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="Investment gains for the year, dollars added by compounding on the portfolio at the selected Income method's blended rate. Explains why the balance can keep growing even after a withdrawal."
                >
                  Gains
                </Tooltip>
              </Column>
              <Column className={thStickyNumClass}>
                <Tooltip
                  multiline
                  content="End-of-year portfolio balance under the selected Income method (pre-retirement: contributions + growth; post-retirement: post-drawdown balance)."
                >
                  Balance
                </Tooltip>
              </Column>
              {showRothConverted && (
                <Column className={thStickyNumClass}>
                  <Tooltip
                    multiline
                    content="Dollars moved from a pre-tax account into your Roth this year under the income cap's Fill mode. This is an internal transfer, not income; federal tax applies on the converted amount in the conversion year."
                  >
                    Roth converted
                  </Tooltip>
                </Column>
              )}
              {isMagiCapActive && (
                <Column className={thStickyClass}>
                  <Tooltip
                    multiline
                    content="MAGI cap status. Warning marker: cap breached (taxable depleted, drew from pre-tax). Info marker: cap honored by routing dollars to a later taxable tier."
                  >
                    Cap
                  </Tooltip>
                </Column>
              )}
            </TableHeader>
            <TableBody>
              {yearTableRows.map((r, i) => (
                <AriaRow key={r.year} id={String(r.year)} className={stripeRowFor(i)}>
                  <Cell className={tdClass}>{r.year}</Cell>
                  <Cell className={tdNumClass}>
                    {r.earned !== null ? formatCurrency(r.earned) : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {r.withdrawal !== null ? formatCurrency(r.withdrawal) : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {r.totalIncome !== null ? formatCurrency(r.totalIncome) : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {r.expenses !== null ? formatCurrency(r.expenses) : '—'}
                  </Cell>
                  <Cell
                    className={
                      r.shortfall !== null && r.shortfall >= 1
                        ? `${tdNumClass} ${valueNegativeClass}`
                        : tdNumClass
                    }
                  >
                    {r.shortfall !== null && r.shortfall >= 1
                      ? formatCurrency(r.shortfall)
                      : '—'}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {r.gainsBreakdown !== null ? (
                      <Tooltip
                        multiline
                        content={
                          <>
                            <span className="block">
                              Growth bucket: {formatCurrency(r.gainsBreakdown.growth)}
                            </span>
                            <span className="block">
                              Income bucket: {formatCurrency(r.gainsBreakdown.income)}
                            </span>
                            <span className="block">
                              Total: {formatCurrency(r.gains as number)}
                            </span>
                          </>
                        }
                      >
                        {formatCurrency(r.gains as number)}
                      </Tooltip>
                    ) : r.gains !== null ? (
                      formatCurrency(r.gains)
                    ) : (
                      '—'
                    )}
                  </Cell>
                  <Cell className={tdNumClass}>
                    {r.balanceByMethod[activeMethod] !== null
                      ? formatCurrency(r.balanceByMethod[activeMethod] as number)
                      : '—'}
                  </Cell>
                  {showRothConverted && (
                    <Cell className={tdNumClass}>
                      {(r.rothConverted ?? 0) > 0
                        ? formatCurrency(r.rothConverted as number)
                        : '—'}
                    </Cell>
                  )}
                  {isMagiCapActive && (
                    <Cell className={tdClass}>
                      {(r.magiCapBreachDollars ?? 0) > 0 ? (
                        <Tooltip
                          multiline
                          content={`MAGI cap breached by ${formatCurrency(r.magiCapBreachDollars as number)}, taxable depleted, drew from pre-tax to meet spending.`}
                        >
                          <span
                            aria-label={`MAGI cap breached by ${formatCurrency(r.magiCapBreachDollars as number)}`}
                            className="inline-flex cursor-help text-warning"
                          >
                            <WarningIcon />
                          </span>
                        </Tooltip>
                      ) : (r.magiCapTierOverrideDollars ?? 0) > 0 ? (
                        <Tooltip
                          multiline
                          content={`MAGI cap routed ${formatCurrency(r.magiCapTierOverrideDollars as number)} from pre-tax to a later taxable tier (cap honored by overriding tier order).`}
                        >
                          <span
                            aria-label={`MAGI cap tier override: ${formatCurrency(r.magiCapTierOverrideDollars as number)}`}
                            className="inline-flex cursor-help text-muted"
                          >
                            <InfoIcon />
                          </span>
                        </Tooltip>
                      ) : null}
                    </Cell>
                  )}
                </AriaRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </div>
    </>
  );
};
