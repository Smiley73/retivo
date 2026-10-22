/**
 * Roth conversion comparison table: one row per candidate plan, the current
 * plan at its rank, unranked plans last. Flags are text, never colour alone.
 */
import React, { useRef, useState } from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { Badge } from '../../components/Badge';
import { btnSecondarySmClass } from '../../components/dialog-chrome';
import { TableScroll } from '../../components/TableScroll';
import {
  tableClass,
  tdClass,
  tdNumClass,
  thStickyClass,
  thStickyNumClass,
} from '../accounts-page-chrome';
import { RothSuggestionYearDetail } from './RothSuggestionYearDetail';
import { canSaveRow } from './roth-suggestion-save-view';
import type { RothSuggestionRow } from './roth-suggestion-view-model';

interface RothSuggestionTableProps {
  readonly rows: readonly RothSuggestionRow[];
  /** The leftover-tax rate the after-tax balance used, in percent. */
  readonly leftoverTaxPct: number;
  /** Opens the save dialog for a row. Rows that cannot be saved (the current
   *  plan, a plan whose cap was not met) get no action, and none do while this
   *  is absent (the results are out of date). */
  readonly onSave?: (row: RothSuggestionRow) => void;
}

const TABLE_LABEL = 'Roth conversion plan comparison';

function detailId(rowId: string): string {
  return `roth-suggestion-detail-${rowId}`;
}

function yearList(years: readonly number[]): string {
  return years.join(', ');
}

const PlanCell: React.FC<{ row: RothSuggestionRow }> = ({ row }) => (
  <div className="flex flex-wrap items-center gap-2">
    <span>{row.label}</span>
    {row.isTop && <Badge tone="success">Highest after-tax ending balance</Badge>}
    {row.notRanked !== '' && <Badge tone="negative">{row.notRanked}</Badge>}
    {row.reroutedYears.length > 0 && (
      <>
        <span aria-hidden="true">†</span>
        <span className="sr-only">
          Spending withdrawals moved to a later account in {yearList(row.reroutedYears)}; see
          note below
        </span>
      </>
    )}
  </div>
);

export const RothSuggestionTable: React.FC<RothSuggestionTableProps> = ({
  rows,
  leftoverTaxPct,
  onSave,
}) => {
  const anyRerouted = rows.some((row) => row.reroutedYears.length > 0);
  // One plan's years open at a time; closing refocuses the toggle that opened it.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const open = rows.find((row) => row.id === openId);
  const close = (): void => {
    if (openId === null) return;
    setOpenId(null);
    toggles.current.get(openId)?.focus();
  };
  return (
    <>
      <TableScroll label={TABLE_LABEL}>
        <Table aria-label={TABLE_LABEL} className={tableClass}>
          <TableHeader>
            <Column className={thStickyNumClass}>Rank</Column>
            <Column isRowHeader className={thStickyClass}>
              Plan
            </Column>
            <Column className={thStickyNumClass}>Target bracket</Column>
            <Column className={thStickyClass}>Cliffs respected</Column>
            <Column className={thStickyNumClass}>After-tax ending balance</Column>
            <Column className={thStickyNumClass}>Years converted</Column>
            <Column className={thStickyNumClass}>Total converted</Column>
            <Column className={thStickyNumClass}>Extra income tax</Column>
            <Column className={thStickyNumClass}>Medicare surcharges</Column>
            <Column className={thStickyNumClass}>Health-subsidy credit change</Column>
            <Column className={thStickyClass}>Years</Column>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <Row key={row.id} id={row.id}>
                <Cell className={tdNumClass}>
                  {row.rank === null ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">Not ranked</span>
                    </>
                  ) : (
                    row.rank
                  )}
                </Cell>
                <Cell className={tdClass}>
                  <PlanCell row={row} />
                </Cell>
                <Cell className={tdNumClass}>{row.bracket}</Cell>
                <Cell className={tdClass}>{row.cliffs}</Cell>
                <Cell className={tdNumClass}>{row.afterTaxEnding}</Cell>
                <Cell className={tdNumClass}>{row.yearsConverted}</Cell>
                <Cell className={tdNumClass}>{row.totalConverted}</Cell>
                <Cell className={tdNumClass}>{row.extraIncomeTax}</Cell>
                <Cell className={tdNumClass}>{row.irmaaSurcharges}</Cell>
                <Cell className={tdNumClass}>{row.acaCreditChange}</Cell>
                <Cell className={tdClass}>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      ref={(el) => {
                        if (el === null) toggles.current.delete(row.id);
                        else toggles.current.set(row.id, el);
                      }}
                      className={btnSecondarySmClass}
                      aria-label={`Why each year for ${row.detailLabel}`}
                      aria-expanded={openId === row.id}
                      aria-controls={openId === row.id ? detailId(row.id) : undefined}
                      onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && openId === row.id) close();
                      }}
                    >
                      Why each year
                    </button>
                    {onSave !== undefined && canSaveRow(row) && (
                      <button
                        type="button"
                        className={btnSecondarySmClass}
                        aria-label={`Save plan to scenario: ${row.detailLabel}`}
                        onClick={() => onSave(row)}
                      >
                        Save plan to scenario
                      </button>
                    )}
                  </div>
                </Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      {open !== undefined && (
        <RothSuggestionYearDetail
          id={detailId(open.id)}
          label={open.detailLabel}
          rows={open.detail}
          onClose={close}
        />
      )}
      <dl className="mt-3 space-y-1 text-xs text-muted">
        <div>
          <dt className="inline font-medium text-ink">Rank</dt>{' '}
          <dd className="inline">
            — by after-tax ending balance, highest first. The current plan is ranked with the
            others. A plan whose cap could not be met is listed last and not ranked.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Cliffs respected</dt>{' '}
          <dd className="inline">
            — whether the plan kept income under the line where Medicare surcharges (the
            income-related monthly adjustment, IRMAA) step up and under the line where the
            health-insurance premium credit (ACA) ends.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">After-tax ending balance</dt>{' '}
          <dd className="inline">
            — the balance at the end of the projection in today&rsquo;s dollars, after taking{' '}
            {leftoverTaxPct}% off money still in pre-tax accounts. Roth and already-taxed
            balances count in full.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Extra income tax</dt>{' '}
          <dd className="inline">
            — federal income tax over the projection compared with the current plan, in
            today&rsquo;s dollars. A minus sign means less tax than the current plan.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Medicare surcharges</dt>{' '}
          <dd className="inline">
            — the total over the projection, with the difference from the current plan in
            brackets.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Health-subsidy credit change</dt>{' '}
          <dd className="inline">
            — the premium credit kept compared with the current plan; a minus sign is credit
            lost. These are the projection&rsquo;s credits, which it limits to the tax and
            Medicare surcharges they offset, so they can be smaller than the credit lost on
            paper.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Why each year</dt>{' '}
          <dd className="inline">
            — opens a year-by-year table for the plan: what each year converted, what stopped
            it and what the year cost.
          </dd>
        </div>
        {anyRerouted && (
          <div>
            <dt className="inline font-medium text-ink">†</dt>{' '}
            <dd className="inline">
              — to keep income under the plan&rsquo;s ceiling, the projection drew spending
              from a later account in the years listed for the row, so part of that
              plan&rsquo;s result comes from a change in withdrawal order, not only from the
              conversions.
            </dd>
          </div>
        )}
      </dl>
    </>
  );
};
