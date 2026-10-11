/**
 * Per-member income-stream section used by `IncomePage`. Renders the
 * member header + the React Aria Table of that member's streams + the
 * row-level Edit / Delete affordances. Extracted from `IncomePage.tsx`
 * so the page stays under the ≤400 line shape limit.
 */
import React from 'react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Badge, badgeToneForBucket } from '../components/Badge';
import { NotesIndicator } from '../components/NotesIndicator';
import type { AccountBucket } from '../lib/account-bucket';
import {
  tableClass,
  thClass,
  thNumClass,
  tdClass,
  tdNumClass,
} from './scenarios-page-chrome';
import {
  iactEditClass,
  iactDeleteClass,
  PencilIcon,
  TrashIcon,
  BucketBar,
} from './accounts-page-chrome';
import {
  formatIncomeAmount,
  formatIncomeKind,
  formatIncomeSchedule,
} from '../lib/income-format';
import { formatCurrency } from '../lib/format-currency';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';

export interface IncomeRow {
  id: string;
  version: number;
  payload: IncomeStreamPayload;
  ownerName: string;
}

/**
 * Income-kind → account-bucket, per the Graphite Spectrum mockup
 * (`rp-screens.js` income list `kindCls`): pension → roth (violet),
 * part-time → cash (amber), one-off → taxable (cyan); anything else falls
 * back to pretax (iris). Drives both the colour-coded Kind chip and the
 * left `BucketBar` marker so streams scan by type at a glance (the same
 * left-bar + bucket-tone treatment the Accounts table uses).
 */
function kindBucket(kind: IncomeStreamPayload['kind']): AccountBucket {
  switch (kind) {
    case 'pension':
      return 'roth';
    case 'partTime':
      return 'cash';
    case 'oneOff':
      return 'taxable';
    default:
      return 'pretax';
  }
}

interface Props {
  ownerName: string;
  rows: IncomeRow[];
  householdMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Stream id → projected linked-CBP balance at the lump-sum's event
   *  month (only populated for `payoutType: 'lumpSum'` streams with a
   *  resolvable linked CBP account). The cell renders the projected
   *  amount with a tooltip when present, otherwise the stored amount. */
  projectedLumpSumByStreamId: ReadonlyMap<string, number>;
  onEdit: (row: IncomeRow) => void;
  onDelete: (row: IncomeRow) => void;
}

export const IncomePageMemberSection: React.FC<Props> = ({
  ownerName,
  rows,
  householdMembers,
  projectedLumpSumByStreamId,
  onEdit,
  onDelete,
}) => {
  return (
    <section className="mb-4 flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-5 shadow-sm">
      <h2 className="m-0 text-xl font-semibold text-ink">
        {ownerName}
      </h2>
      {/* Fixed column widths so both member tables align across the
          page — without this each table sizes columns from its own
          content, producing different layouts when one member has long
          source names and another has short. Row separators use the
          shared decorative `line` token (the same hairline the `tdClass`
          border ships), scoped to this table via a descendant variant.
          React Aria Table renders native table markup with role="grid" +
          keyboard row navigation. */}
      <Table
        aria-label={`Income sources for ${ownerName}`}
        className={`${tableClass} [&_td]:border-line`}
      >
        <TableHeader>
          <Column isRowHeader className={thClass}>Source</Column>
          <Column className={thClass}>Kind</Column>
          <Column className={thNumClass}>Amount</Column>
          <Column className={thClass}>Schedule</Column>
          <Column className={thClass}>
            <span className="sr-only">Actions</span>
          </Column>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <Row key={r.id} id={r.id} className="group/row" data-income-id={r.id}>
              {/* Name cell hosts the absolutely-positioned left bucket
                  bar, so it must be `relative` (matches the Accounts table). */}
              <Cell className={`${tdClass} relative`}>
                <BucketBar bucket={kindBucket(r.payload.kind)} />
                <span className="inline-flex items-center gap-1.5">
                  <strong>{r.payload.name}</strong>
                  <NotesIndicator notes={r.payload.notes} />
                </span>
              </Cell>
              <Cell className={tdClass}>
                <Badge tone={badgeToneForBucket(kindBucket(r.payload.kind))}>
                  {formatIncomeKind(r.payload)}
                </Badge>
              </Cell>
              <Cell className={tdNumClass}>
                {(() => {
                  const projected = projectedLumpSumByStreamId.get(r.id);
                  if (projected !== undefined) {
                    return (
                      <span
                        title="Projected balance of the linked Cash Balance Pension account at the event month, using your base scenario's retirement age and the CBP's planning return rate. Updates as you edit the CBP's balance or return assumption."
                      >
                        ~{formatCurrency(projected)}
                      </span>
                    );
                  }
                  return formatIncomeAmount(r.payload);
                })()}
              </Cell>
              <Cell className={tdClass}>
                {formatIncomeSchedule(r.payload, householdMembers)}
              </Cell>
              <Cell className={tdNumClass}>
                {/* Icon row-actions matching Accounts / Account Balances —
                    the `row-actions` cluster reveals on hover / focus-within
                    (pointer) and stays visible on touch. Each icon carries
                    its accessible name via aria-label. */}
                <div className="row-actions items-center">
                  <button
                    type="button"
                    className={iactEditClass}
                    aria-label="Edit"
                    onClick={() => onEdit(r)}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className={iactDeleteClass}
                    aria-label={`Delete ${r.payload.name}`}
                    onClick={() => onDelete(r)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </Cell>
            </Row>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};
