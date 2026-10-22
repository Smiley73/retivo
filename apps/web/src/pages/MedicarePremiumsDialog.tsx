/**
 * Preview dialog for the Expenses page "Add Medicare premiums" helper. Confirm
 * writes one monthly Medical expense per included row through the expense form's
 * create path; the row and payload logic is in `medicare-premium-helper.ts`.
 */
import React, { useState } from 'react';
import { Alert } from '../components/Alert';
import { Modal } from '../components/Modal';
import { Muted } from '../components/Muted';
import { MoneyInput } from '../components/MoneyInput';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { btnPrimaryClass, btnSecondaryClass } from '../components/dialog-chrome';
import { withBatchedStoreSignals } from '../db/store';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';
import { cryptoUuid } from '../lib/crypto-uuid';
import { formatCurrencyExact } from '../lib/format-currency';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useSync } from '../sync/SyncContext';
import {
  buildMedicarePremiumPreview,
  buildPremiumPayloads,
  isRowIncluded,
  type PremiumBlock,
  type PremiumMemberGroup,
  type PremiumRow,
} from './medicare-premium-helper';

interface MedicarePremiumsDialogProps {
  householdId: string;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  onClose: () => void;
}

function blockText(block: PremiumBlock, row: PremiumRow): string {
  switch (block.kind) {
    case 'nameTaken':
      return `An expense named "${block.expense.name}" already exists in ${block.expense.categoryName}, so this one cannot be added. Rename or delete that expense to add this row.`;
    case 'nameRepeated':
      return `Another row in this list would be named "${row.expenseName}", so this one cannot be added.`;
    case 'nameTooLong':
      return `The name "${row.expenseName}" is longer than 60 characters, so this one cannot be added.`;
  }
}

const PremiumRowItem: React.FC<{
  row: PremiumRow;
  included: boolean;
  amount: number;
  onToggle: (next: boolean) => void;
  onAmount: (next: number) => void;
}> = ({ row, included, amount, onToggle, onAmount }) => (
  <li className="border-t border-line py-3 first:border-t-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ToggleSwitch
        checked={included}
        onChange={onToggle}
        disabled={row.block !== null}
        label={<span className="font-medium text-ink">{row.expenseName}</span>}
      />
      <div className="flex items-center gap-2">
        <div className="w-32">
          <MoneyInput
            variant="cell"
            ariaLabel={`${row.expenseName} monthly amount`}
            value={amount}
            onChange={onAmount}
            disabled={row.block !== null || !included}
          />
        </div>
        <Muted className="text-sm">a month</Muted>
      </div>
    </div>
    <Muted as="p" className="m-0 mt-1 text-sm">
      Built-in amount: {formatCurrencyExact(row.monthly)} a month.
    </Muted>
    {row.alreadyEntered.length > 0 && (
      <Muted as="p" className="m-0 mt-1 text-sm">
        <strong className="text-ink">Looks already entered.</strong> It may match{' '}
        {row.alreadyEntered
          .map((m) => `"${m.name}" in ${m.categoryName}`)
          .join(', ')}
        . Turn this row on if that is not the same premium.
      </Muted>
    )}
    {row.block !== null && (
      <Muted as="p" className="m-0 mt-1 text-sm">
        <strong className="text-ink">Cannot be added.</strong>{' '}
        {blockText(row.block, row)}
      </Muted>
    )}
  </li>
);

const MemberSection: React.FC<{
  group: PremiumMemberGroup;
  includeEdits: Record<string, boolean>;
  amountEdits: Record<string, number>;
  setInclude: (key: string, next: boolean) => void;
  setAmount: (key: string, next: number) => void;
}> = ({ group, includeEdits, amountEdits, setInclude, setAmount }) => (
  <section aria-label={group.label} className="rounded-lg border border-line p-4">
    <h3 className="m-0 mb-1 text-base font-semibold text-ink">{group.label}</h3>
    {group.missingBirthdate ? (
      <Muted as="p" className="m-0 text-sm">
        Add a birthdate for {group.label} on the Household page to offer
        Medicare premiums for them.
      </Muted>
    ) : (
      <ul className="m-0 list-none p-0">
        {group.rows.map((row) => (
          <PremiumRowItem
            key={row.key}
            row={row}
            included={isRowIncluded(row, includeEdits)}
            amount={amountEdits[row.key] ?? row.monthly}
            onToggle={(next) => setInclude(row.key, next)}
            onAmount={(next) => setAmount(row.key, next)}
          />
        ))}
      </ul>
    )}
  </section>
);

export const MedicarePremiumsDialog: React.FC<MedicarePremiumsDialogProps> = ({
  householdId,
  members,
  expenses,
  categories,
  onClose,
}) => {
  const { notifyPending } = useSync();
  const [includeEdits, setIncludeEdits] = useState<Record<string, boolean>>({});
  const [amountEdits, setAmountEdits] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = buildMedicarePremiumPreview({ members, expenses, categories });
  const payloads = buildPremiumPayloads(preview, includeEdits, amountEdits);

  const onConfirm = async (): Promise<void> => {
    if (payloads.length === 0) return;
    setSubmitting(true);
    setError(null);
    let written = 0;
    try {
      await withBatchedStoreSignals(async (batch) => {
        for (const payload of payloads) {
          await queueLocalMutation<ExpensePayload>(
            {
              type: 'expense',
              aggregateId: cryptoUuid(),
              householdId,
              operation: 'create',
              expectedVersion: 0,
              payload,
            },
            batch,
          );
          written += 1;
        }
      });
      notifyPending();
      onClose();
    } catch {
      // Rows already written stay; the preview now shows them as already
      // entered, so a retry cannot add them twice.
      if (written > 0) notifyPending();
      setError(
        written > 0
          ? `Added ${written} of ${payloads.length} premiums before something went wrong. The rows that were added now show as already entered.`
          : 'Failed to add the premiums.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Medicare premiums"
      size="4xl"
      scrollBodyLabel="Medicare premiums"
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm">
          Adds each person&apos;s Medicare Part B and Part D premiums as
          monthly Medical expenses that start at age 65 and last for life.
          The built-in amounts are the {preview.year} figures from the
          Centers for Medicare &amp; Medicaid Services: the standard Part B
          premium and the national base Part D premium. They are in
          today&apos;s dollars and grow with the scenario&apos;s medical
          inflation rate, like any Medical expense. The extra charge for
          higher incomes is estimated separately, so it is not included. Your
          actual Part D plan price, Medigap and Medicare Advantage premiums
          are yours to enter yourself. Nothing is saved until you confirm.
        </p>
        {preview.medicalCategoryId === null ? (
          <Alert tone="warning">
            This household has no Medical expense category, so there is
            nowhere to add these. Create one on the Expense Categories page and
            mark it as Medical, then come back.
          </Alert>
        ) : (
          preview.members.map((group) => (
            <MemberSection
              key={group.memberId}
              group={group}
              includeEdits={includeEdits}
              amountEdits={amountEdits}
              setInclude={(key, next) =>
                setIncludeEdits((prev) => ({ ...prev, [key]: next }))
              }
              setAmount={(key, next) =>
                setAmountEdits((prev) => ({ ...prev, [key]: next }))
              }
            />
          ))
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {/* Left-aligned, primary action first — AGENTS modal-action rule. */}
        <div className="flex justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onConfirm}
            disabled={submitting || payloads.length === 0}
          >
            {submitting
              ? 'Adding…'
              : `Add ${payloads.length} ${payloads.length === 1 ? 'premium' : 'premiums'}`}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};
