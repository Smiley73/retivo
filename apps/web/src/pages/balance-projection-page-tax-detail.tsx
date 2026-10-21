/**
 * Balance Projection page — "Taxes & health costs" year-by-year sub-table.
 * Renders the six visible tax-cashflow fields per retirement
 * year — federal tax, IRMAA withheld from Social Security, IRMAA cash-paid,
 * ACA premium-tax-credit offset, the total tax-funded withdrawal, and the
 * credit applied to premiums that lowers the draw — in a
 * dedicated `<TableScroll>` below the main balance table, so the main 8–9
 * column table is not widened.
 *
 * Tax cashflow AFFECTS balances: the engine raised each year's
 * withdrawal target by the tax need, so these dollars were drawn from the
 * portfolio. Years where the solver could not fully fund the bill (or did
 * not converge) surface a per-year warning icon plus a section-level alert,
 * reusing the MAGI-cap breach diagnostic pattern.
 */
import React, { useMemo } from 'react';
import {
  Cell,
  Column,
  Row as AriaRow,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { TableScroll } from '../components/TableScroll';
import { Tooltip } from '../components/Tooltip';
import { WarningIcon } from '../components/icons';
import { formatCurrency } from '../lib/format-currency';
import type { DrawdownYear } from '../lib/drawdown-engine';
import {
  bandSectionH2Class,
  stripeRowFor,
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from './accounts-page-chrome';

interface TaxDetailRow {
  readonly year: number;
  readonly federalTax: number;
  readonly irmaaWithheld: number;
  readonly irmaaCashPaid: number;
  readonly acaPtcOffset: number;
  readonly taxFundedWithdrawals: number;
  /** ACA credit left after the offset that lowered the year's draw because the
   *  premium is a modeled Medical expense. */
  readonly acaCreditApplied: number;
  /** Net TAXABLE required minimum distribution after the QCD offset for the year
   *  (`gross IRA-pool RMD − min(Q, gross)`). 0 in years with no QCD. */
  readonly netTaxableRmd: number;
  /** True when a Qualified Charitable Distribution applied this year — gates the
   *  conditional "Net taxable IRA RMD" column display. */
  readonly hasQcd: boolean;
  /** True when the solver did not converge OR could not fully fund the
   *  year's tax bill — drives the per-year warning icon + section alert. */
  readonly unfunded: boolean;
}

export interface BalanceProjectionTaxDetailProps {
  /** Active method's runner drawdown years (carry the tax-cashflow fields). */
  readonly drawdownYears: ReadonlyArray<DrawdownYear>;
  /** Year-end (Dec) deflator → today's dollars when displayMode === 'today'. */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** When rendered inside the Tax Burden chart's collapsible disclosure, the
   *  surrounding section already carries the heading + the toggle-button label
   *  ("Show taxes & health costs table"), so the component's own `<h2>` would
   *  be redundant — suppress it. Standalone (default) keeps the heading. */
  readonly embedded?: boolean;
}

/** Map runner drawdown years into the displayed tax-detail rows. */
function buildTaxDetailRows(
  drawdownYears: ReadonlyArray<DrawdownYear>,
  viewDeflator: (year: number, monthIndex?: number) => number,
): TaxDetailRow[] {
  return drawdownYears.map((yr) => {
    const d = viewDeflator(yr.year, 11);
    const shortfall = yr.taxCashflowShortfallCents ?? 0;
    const converged = yr.taxCashflowConverged ?? true;
    return {
      year: yr.year,
      federalTax: ((yr.federalTaxCashNeedCents ?? 0) / 100) * d,
      irmaaWithheld: ((yr.irmaaWithheldFromSsCents ?? 0) / 100) * d,
      irmaaCashPaid: ((yr.irmaaCashNeedCents ?? 0) / 100) * d,
      acaPtcOffset: ((yr.acaPtcCashflowOffsetCents ?? 0) / 100) * d,
      taxFundedWithdrawals: ((yr.totalTaxCashflowNeedCents ?? 0) / 100) * d,
      acaCreditApplied: ((yr.acaCreditAppliedToPremiumsCents ?? 0) / 100) * d,
      netTaxableRmd: ((yr.netTaxableRmdCents ?? 0) / 100) * d,
      hasQcd: (yr.qcdCents ?? 0) > 0,
      // A sub-$1 shortfall is fp residue, not a real funding gap.
      unfunded: shortfall >= 100 || !converged,
    };
  });
}

/** Column header row for the tax-detail table. The "Net taxable IRA RMD" column
 *  is shown only when a Qualified Charitable Distribution applies in the
 *  projection (QCD) so the table is not widened for the common no-QCD
 *  case. */
const TaxDetailHeader: React.FC<{ readonly showQcdColumn: boolean }> = ({
  showQcdColumn,
}) => (
  <TableHeader>
    <Column isRowHeader className={thStickyClass}>Year</Column>
    {showQcdColumn && (
      <Column className={thStickyNumClass}>
        <Tooltip multiline content="The part of the year's required minimum distribution you still owe income tax on, after subtracting any Qualified Charitable Distribution given directly from your IRA (the gift counts toward the minimum but is excluded from taxable income).">
          Net taxable IRA RMD
        </Tooltip>
      </Column>
    )}
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="Federal income tax funded from the portfolio as a same-year cash need (already incorporates any taxable Social Security per IRS §86).">
        Federal tax
      </Tooltip>
    </Column>
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="Medicare IRMAA surcharge withheld from a member's Social Security benefit, netted from SS, not drawn from the portfolio.">
        IRMAA withheld
      </Tooltip>
    </Column>
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="Medicare IRMAA surcharge paid as a same-year cash need (member on Medicare but not yet receiving Social Security), funded from the portfolio.">
        IRMAA cash-paid
      </Tooltip>
    </Column>
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="ACA premium tax credit applied against the year's tax / health-cost cash need, reduces the amount drawn from the portfolio.">
        ACA PTC offset
      </Tooltip>
    </Column>
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="Total extra withdrawal the portfolio funded this year to cover taxes and health costs: federal tax + IRMAA cash-paid − ACA PTC offset.">
        Tax-funded withdrawals
      </Tooltip>
    </Column>
    <Column className={thStickyNumClass}>
      <Tooltip multiline content="The part of the ACA premium tax credit left after federal tax and IRMAA cash that lowers the year's withdrawal, because you entered the premium as a Medical expense. Never more than that year's Medical expenses or the year's withdrawal. The net change in the withdrawal is Tax-funded withdrawals minus this column.">
        Credit applied to premiums
      </Tooltip>
    </Column>
  </TableHeader>
);

/** Section-level warning alert for years the solver could not fully fund. */
const UnfundedBanner: React.FC<{ readonly unfundedYears: ReadonlyArray<number> }> = ({
  unfundedYears,
}) => {
  if (unfundedYears.length === 0) return null;
  const sorted = [...unfundedYears].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const range = first === last ? `${first}` : `${first}–${last}`;
  return (
    <Alert tone="warning">
      Tax cashflow could not be fully funded in {unfundedYears.length} year
      {unfundedYears.length === 1 ? '' : 's'} ({range}), the portfolio ran
      short of the grossed-up tax bill, or the estimate did not settle.
    </Alert>
  );
};

/** Body rows for the tax-detail table (one per retirement year). */
const TaxDetailRows: React.FC<{
  readonly rows: ReadonlyArray<TaxDetailRow>;
  readonly showQcdColumn: boolean;
}> = ({ rows, showQcdColumn }) => (
  <>
    {rows.map((r, i) => (
      <AriaRow key={r.year} id={String(r.year)} className={stripeRowFor(i)}>
        <Cell className={tdClass}>
          {r.unfunded ? (
            <Tooltip multiline content="Tax cashflow could not be fully funded this year. The portfolio ran short of the grossed-up tax bill, or the estimate did not settle.">
              <span
                aria-label={`Tax cashflow unfunded in ${r.year}`}
                className="inline-flex items-center gap-1"
              >
                <span className="text-warning">
                  <WarningIcon />
                </span>
                {r.year}
              </span>
            </Tooltip>
          ) : (
            r.year
          )}
        </Cell>
        {showQcdColumn && (
          <Cell className={tdNumClass}>
            {r.hasQcd ? formatCurrency(r.netTaxableRmd) : '—'}
          </Cell>
        )}
        <Cell className={tdNumClass}>{formatCurrency(r.federalTax)}</Cell>
        <Cell className={tdNumClass}>{formatCurrency(r.irmaaWithheld)}</Cell>
        <Cell className={tdNumClass}>{formatCurrency(r.irmaaCashPaid)}</Cell>
        <Cell className={tdNumClass}>{formatCurrency(r.acaPtcOffset)}</Cell>
        <Cell className={tdNumClass}>{formatCurrency(r.taxFundedWithdrawals)}</Cell>
        <Cell className={tdNumClass}>{formatCurrency(r.acaCreditApplied)}</Cell>
      </AriaRow>
    ))}
  </>
);

export const BalanceProjectionTaxDetail: React.FC<
  BalanceProjectionTaxDetailProps
> = ({ drawdownYears, viewDeflator, embedded = false }) => {
  const rows = useMemo(
    () => buildTaxDetailRows(drawdownYears, viewDeflator),
    [drawdownYears, viewDeflator],
  );

  const hasSignal = rows.some(
    (r) =>
      r.federalTax !== 0 ||
      r.irmaaWithheld !== 0 ||
      r.irmaaCashPaid !== 0 ||
      r.acaPtcOffset !== 0 ||
      r.taxFundedWithdrawals !== 0 ||
      r.acaCreditApplied !== 0 ||
      r.hasQcd,
  );

  const unfundedYears = useMemo(
    () => rows.filter((r) => r.unfunded).map((r) => r.year),
    [rows],
  );

  // Show the net-taxable-IRA-RMD-after-QCD column only when a QCD applies
  // — the common no-QCD projection keeps the original six columns.
  const showQcdColumn = rows.some((r) => r.hasQcd);

  return (
    <>
      {!embedded && (
        <h2 id="tax-detail-heading" className={bandSectionH2Class}>
          Taxes &amp; health costs
        </h2>
      )}
      {!hasSignal ? (
        <Muted>
          No tax-funded withdrawals in this projection. Every year has $0
          federal tax, $0 Medicare IRMAA, and $0 ACA premium tax credit. The
          table fills in once drawdowns or RMDs generate taxable income.
        </Muted>
      ) : (
        <>
          <UnfundedBanner unfundedYears={unfundedYears} />
          <TableScroll label="Year-by-year taxes and health costs table">
            <Table className={tableClass} aria-label="Year-by-year taxes and health costs">
              <TaxDetailHeader showQcdColumn={showQcdColumn} />
              <TableBody>
                <TaxDetailRows rows={rows} showQcdColumn={showQcdColumn} />
              </TableBody>
            </Table>
          </TableScroll>
        </>
      )}
    </>
  );
};
