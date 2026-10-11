/**
 * One category's expense-list card for the /expenses page, plus the
 * shared row/group shapes it consumes. Extracted from `ExpensesPage`
 * so that already-oversized page stays small; visual style is the
 * Tailwind-defaults vocabulary (every fg/bg pair AA-safe per contrast.ts).
 */
import React from 'react';
import { Badge } from '../components/Badge';
import { Muted } from '../components/Muted';
import {
  iactEditClass,
  iactDeleteClass,
  PencilIcon,
  TrashIcon,
  BucketBar,
} from './accounts-page-chrome';
import {
  describeExpenseEnd,
  describeExpenseStart,
  formatExpenseAmount,
} from '../lib/expense-format';
import type {
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';

export interface ExpenseRow {
  id: string;
  version: number;
  payload: ExpensePayload;
  categoryName: string;
}

export interface CategoryGroup {
  categoryId: string;
  categoryName: string;
  rows: ExpenseRow[];
}

interface ExpenseGroupCardProps {
  group: CategoryGroup;
  members: Aggregate<HouseholdMemberPayload>[];
  onEdit: (id: string) => void;
  onDelete: (row: ExpenseRow) => void;
}

export const ExpenseGroupCard: React.FC<ExpenseGroupCardProps> = ({
  group,
  members,
  onEdit,
  onDelete,
}) => (
  <section
    className="mb-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
    aria-labelledby={`grp-${group.categoryId}`}
  >
    <h2
      id={`grp-${group.categoryId}`}
      className="m-0 mb-2 text-base font-semibold text-ink"
    >
      {group.categoryName}
    </h2>
    <ul className="m-0 list-none p-0">
      {group.rows.map((r) => (
        <li
          key={r.id}
          data-expense-id={r.id}
          className="group/row relative flex items-center justify-between gap-3 border-t border-line py-2 pl-3 first:border-t-0"
        >
          {/* Left bucket-bar marker matching the Accounts table:
              essential → taxable (cyan), discretionary → roth (violet). */}
          <BucketBar
            bucket={
              r.payload.classification === 'essential' ? 'taxable' : 'roth'
            }
          />
          <div className="min-w-0 flex-1">
            <strong>{r.payload.name}</strong>
            <Badge
              tone={
                r.payload.classification === 'essential'
                  ? 'essential'
                  : 'discretionary'
              }
              className="ml-2"
            >
              {r.payload.classification === 'essential'
                ? 'Essential'
                : 'Discretionary'}
            </Badge>
            {r.payload.hsaQualified === true && (
              <Badge tone="success" className="ml-1">
                HSA
              </Badge>
            )}
            {r.payload.description && (
              <Muted as="div" className="text-sm">
                {r.payload.description}
              </Muted>
            )}
            <Muted as="div" className="text-sm">
              {describeExpenseStart(r.payload.start, members)} →{' '}
              {describeExpenseEnd(r.payload.end, r.payload.frequency, members)}
            </Muted>
          </div>
          {/* Tabular numbers: amounts compared down the column render in
              JetBrains Mono with tabular widths (see "Typography" in docs/ui-conventions.md). */}
          <div className="min-w-32 text-right font-mono tabular-nums">
            {formatExpenseAmount(r.payload.amount, r.payload.frequency)}
          </div>
          {/* Icon row-actions matching Accounts / Account Balances —
              the `row-actions` cluster reveals on hover / focus-within
              (pointer) and stays visible on touch. */}
          <div className="row-actions items-center">
            <button
              type="button"
              className={iactEditClass}
              aria-label="Edit"
              onClick={() => onEdit(r.id)}
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
        </li>
      ))}
    </ul>
  </section>
);
