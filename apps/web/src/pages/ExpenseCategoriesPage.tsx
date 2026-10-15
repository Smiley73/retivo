/**
 * /expense-categories — manage page for ExpenseCategory aggregates.
 *
 * Renders the household's category list (alphabetical), with Add and
 * Rename modals and a delete affordance that blocks when the category
 * is in use. The "in use" check inspects canonical Expense aggregates
 * + every Scenario's `overrides.expenses.added[*]` — Expense itself
 * lands in a follow-up commit, so this commit's delete check looks at
 * Scenarios only and gracefully treats Expense as not-yet-arrived.
 */
import React, { useMemo, useState } from 'react';
import { PlusIcon } from '../components/icons';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { TextInput } from '../components/TextInput';
import { BlockOnDeleteDialog } from '../components/BlockOnDeleteDialog';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { useSync } from '../sync/SyncContext';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from '../lib/crypto-uuid';
import { useAggregates } from '../lib/use-aggregates';
import { ensureDefaultExpenseCategories } from '../lib/expense-categories-bootstrap';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { Badge } from '../components/Badge';
import { ToggleSwitch } from '../components/ToggleSwitch';
import {
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
} from './scenarios-page-chrome';
import {
  PencilIcon,
  TrashIcon,
  iactEditClass,
  iactDeleteClass,
} from './accounts-page-chrome';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  ScenarioPayload,
} from '../db/types';

interface CategoryRow {
  id: string;
  version: number;
  name: string;
  /** Generic medical marker — drives the +2pp inflation default. */
  isMedical: boolean;
  /** Reference count across canonical expenses + scenario.added entries. */
  useCount: number;
  /** Full, uncapped, ordered reference labels (the dialog owns the cap). */
  refLabels: string[];
}

interface BlockDialogState {
  category: CategoryRow;
}

const MAX_NAME_LEN = 40;

const normalizedName = (s: string): string => s.trim().toLowerCase();

export const ExpenseCategoriesPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // Reactive reads: category rows + their reference counts re-derive on any
  // write to the `expenseCategory` / `expense` / `scenario` stores (single
  // saves/deletes via the per-store fine signal, the default-categories
  // bootstrap / demo fill / sync via the coarse workspace event).
  const categoryQuery = useAggregates('expenseCategory');
  const expenseQuery = useAggregates('expense');
  const scenarioQuery = useAggregates('scenario');
  const ready =
    categoryQuery.ready && expenseQuery.ready && scenarioQuery.ready;
  const loadError =
    categoryQuery.error || expenseQuery.error || scenarioQuery.error
      ? 'Failed to load categories.'
      : null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const error = actionError ?? loadError;

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addIsMedical, setAddIsMedical] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Rename modal
  const [renameTarget, setRenameTarget] = useState<CategoryRow | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameIsMedical, setRenameIsMedical] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Block dialog (deletion blocked because the category is in use).
  const [blockState, setBlockState] = useState<BlockDialogState | null>(null);

  // Seeding state for the empty-state CTA. Older exports (and legacy
  // imports that landed before the auto-bootstrap) leave the user with
  // zero categories; offer a one-click "use the standard 8" rather than
  // forcing 8 separate Add-category clicks.
  const [seeding, setSeeding] = useState(false);

  const isDirty = useMemo(() => {
    if (addOpen && (addName !== '' || addIsMedical)) return true;
    if (
      renameTarget &&
      (renameName !== renameTarget.name ||
        renameIsMedical !== renameTarget.isMedical)
    ) {
      return true;
    }
    return false;
  }, [addOpen, addName, addIsMedical, renameTarget, renameName, renameIsMedical]);

  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  // Derive the category rows + their reference counts from the reactive hook
  // outputs. Pure, so it lives in a `useMemo` (no load effect / loading state).
  const rows = useMemo<CategoryRow[]>(() => {
    const cats = categoryQuery.aggregates as ReadonlyArray<
      Aggregate<ExpenseCategoryPayload>
    >;
    const expenses = expenseQuery.aggregates as ReadonlyArray<
      Aggregate<ExpensePayload>
    >;
    const scenarios = scenarioQuery.aggregates as ReadonlyArray<
      Aggregate<ScenarioPayload>
    >;

    // Build the references index: categoryId -> human-readable labels.
    const refs = new Map<string, string[]>();
    for (const e of expenses) {
      const cid = e.payload.categoryId;
      if (!cid) continue;
      if (!refs.has(cid)) refs.set(cid, []);
      refs.get(cid)!.push(`${e.payload.name} (canonical)`);
    }
    for (const s of scenarios) {
      const added = s.payload.overrides?.expenses?.added ?? [];
      for (const a of added) {
        const cid = a.categoryId;
        if (!cid) continue;
        if (!refs.has(cid)) refs.set(cid, []);
        refs.get(cid)!.push(`${a.name} (in scenario "${s.payload.name}")`);
      }
      const patches = s.payload.overrides?.expenses?.patches ?? {};
      for (const p of Object.values(patches)) {
        const cid = p.categoryId;
        if (!cid) continue;
        if (!refs.has(cid)) refs.set(cid, []);
        refs.get(cid)!.push(`(patched in scenario "${s.payload.name}")`);
      }
    }

    return cats
      .map((c) => {
        const labels = refs.get(c.id) ?? [];
        return {
          id: c.id,
          version: c.version,
          name: c.payload.name,
          isMedical: c.payload.isMedical === true,
          useCount: labels.length,
          refLabels: labels,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [categoryQuery.aggregates, expenseQuery.aggregates, scenarioQuery.aggregates]);

  const nameCollidesWith = (candidate: string, exceptId?: string): boolean => {
    const norm = normalizedName(candidate);
    if (!norm) return false;
    return rows.some((r) => r.id !== exceptId && normalizedName(r.name) === norm);
  };

  const onOpenAdd = (): void => {
    setAddOpen(true);
    setAddName('');
    setAddIsMedical(false);
    setAddError(null);
  };

  const onCloseAdd = (): void => {
    setAddOpen(false);
    setAddName('');
    setAddIsMedical(false);
    setAddError(null);
  };

  const onSaveAdd = async (): Promise<void> => {
    if (!householdId) return;
    const name = addName.trim();
    if (!name) {
      setAddError('Name is required.');
      return;
    }
    if (name.length > MAX_NAME_LEN) {
      setAddError(`Max ${MAX_NAME_LEN} characters.`);
      return;
    }
    if (nameCollidesWith(name)) {
      setAddError(`A category named "${name}" already exists.`);
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await queueLocalMutation<ExpenseCategoryPayload>({
        type: 'expenseCategory',
        aggregateId: cryptoUuid(),
        householdId,
        operation: 'create',
        expectedVersion: 0,
        // New categories default off; persist the flag only when on (sparse).
        payload: addIsMedical ? { name, isMedical: true } : { name },
      });
      onCloseAdd();
      notifyPending();
      // The create writes an `expenseCategory` row, so the reactive read
      // re-runs and the new row appears — no manual reload.
    } catch {
      setActionError('Failed to add category.');
    } finally {
      setSubmitting(false);
    }
  };

  const onOpenRename = (target: CategoryRow): void => {
    setRenameTarget(target);
    setRenameName(target.name);
    setRenameIsMedical(target.isMedical);
    setRenameError(null);
  };

  const onCloseRename = (): void => {
    setRenameTarget(null);
    setRenameName('');
    setRenameIsMedical(false);
    setRenameError(null);
  };

  const onSaveRename = async (): Promise<void> => {
    if (!householdId || !renameTarget) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError('Name is required.');
      return;
    }
    if (name.length > MAX_NAME_LEN) {
      setRenameError(`Max ${MAX_NAME_LEN} characters.`);
      return;
    }
    if (nameCollidesWith(name, renameTarget.id)) {
      setRenameError(`A category named "${name}" already exists.`);
      return;
    }
    // No-op only when neither the name nor the flag changed.
    if (
      name === renameTarget.name &&
      renameIsMedical === renameTarget.isMedical
    ) {
      onCloseRename();
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      // Full-payload replace: include `isMedical` or a rename would erase the
      // flag. Persist the flag only when on (sparse — absent ⇒ not medical).
      const payload: ExpenseCategoryPayload = renameIsMedical
        ? { name, isMedical: true }
        : { name };
      await queueLocalMutation<ExpenseCategoryPayload>({
        type: 'expenseCategory',
        aggregateId: renameTarget.id,
        householdId,
        operation: 'update',
        expectedVersion: renameTarget.version,
        payload,
      });
      onCloseRename();
      notifyPending();
      // The update writes the `expenseCategory` row, so the reactive read
      // re-runs and the renamed row refreshes — no manual reload.
    } catch {
      setActionError('Failed to rename category.');
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (target: CategoryRow): Promise<void> => {
    if (!householdId) return;
    if (target.useCount > 0) {
      setBlockState({ category: target });
      return;
    }
    const ok = await confirm(
      `Delete "${target.name}"?`,
      'This category will be removed from your workspace. This cannot be undone.',
    );
    if (!ok) return;
    setActionError(null);
    try {
      await queueLocalMutation<ExpenseCategoryPayload>({
        type: 'expenseCategory',
        aggregateId: target.id,
        householdId,
        operation: 'delete',
        expectedVersion: target.version,
        payload: { name: target.name },
      });
      notifyPending();
      // The delete tombstone is an `expenseCategory` write, so the reactive
      // read re-runs and drops the row — no manual reload.
    } catch {
      setActionError('Failed to delete category.');
    }
  };

  const onSeedDefaults = async (): Promise<void> => {
    if (!householdId || seeding) return;
    setSeeding(true);
    setActionError(null);
    try {
      const created = await ensureDefaultExpenseCategories(householdId);
      if (created > 0) {
        notifyPending();
        // The bootstrap writes `expenseCategory` rows, so the reactive read
        // re-runs and the seeded rows appear — no manual reload.
      }
    } catch {
      setActionError('Failed to seed default categories.');
    } finally {
      setSeeding(false);
    }
  };

  if (!ready) return <LoadingState label="Loading expense categories…" variant="table" />;

  return (
    <section aria-labelledby="categories-heading">
      <PageHeader
        title={<span id="categories-heading">Expense categories</span>}
        subtitle="Categories organise your retirement expenses. Renamable; deletable when not in use."
        action={{ label: 'Add category', onClick: onOpenAdd }}
        actionIcon={<PlusIcon />}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {rows.length === 0 ? (
        // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.cat-list` mock width cap (760px)
        <section className="mb-4 flex max-w-[760px] flex-col items-start gap-3 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm">
          <p className="m-0">
            No categories yet. Use the standard 8 (Housing, Food,
            Transportation, Medical, Utilities, Insurance, Entertainment,
            Other) to get started, or add your own.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimaryClass}
              onClick={() => {
                void onSeedDefaults();
              }}
              disabled={seeding || !householdId}
            >
              {seeding ? 'Adding…' : 'Use the standard 8 categories'}
            </button>
            <button
              type="button"
              className={`${btnSecondaryClass} gap-1.5`}
              onClick={onOpenAdd}
              disabled={seeding}
            >
              <PlusIcon />
              Add my own
            </button>
          </div>
        </section>
      ) : (
        // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.cat-list` mock width cap (760px)
        <ul className="mb-4 m-0 max-w-[760px] list-none rounded-2xl border border-line bg-surface-raised py-2 shadow-sm">
          {rows.map((r) => (
            <li
              key={r.id}
              className="group/row flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 first:border-t-0"
            >
              <div>
                <strong>{r.name}</strong>
                {r.isMedical && (
                  <Badge tone="scenario" className="ml-2">
                    Medical
                  </Badge>
                )}
                <Muted as="div" className="text-sm">
                  {r.useCount === 0 ? 'Not used' : `Used by ${r.useCount} expense${r.useCount === 1 ? '' : 's'}`}
                </Muted>
              </div>
              {/* Hover-revealed icon cluster, matching the Accounts /
                  Account Balances row pattern; icons carry their accessible
                  name via aria-label. Delete stays blocked (aria-disabled +
                  tooltip) while the category is in use. */}
              <div className="row-actions items-center">
                <button
                  type="button"
                  className={iactEditClass}
                  onClick={() => onOpenRename(r)}
                  aria-label={`Rename ${r.name}`}
                >
                  <PencilIcon />
                </button>
                {/* Intentionally NOT disabled when in use: clicking opens a
                    dialog explaining which expenses block the delete, so the
                    control must stay actionable for keyboard + AT users. The
                    `title` is a hover preview of the same hint. */}
                <button
                  type="button"
                  className={iactDeleteClass}
                  onClick={() => onDelete(r)}
                  title={r.useCount > 0 ? 'In use. Re-categorise expenses first.' : undefined}
                  aria-label={`Delete ${r.name}`}
                >
                  <TrashIcon />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {addOpen && (
        <CategoryNameModal
          title="Add category"
          submitLabel="Add"
          submitting={submitting}
          name={addName}
          isMedical={addIsMedical}
          error={addError}
          onChange={setAddName}
          onChangeIsMedical={setAddIsMedical}
          onCancel={onCloseAdd}
          onSubmit={onSaveAdd}
        />
      )}

      {renameTarget && (
        <CategoryNameModal
          title={`Rename "${renameTarget.name}"`}
          submitLabel="Save"
          submitting={submitting}
          name={renameName}
          isMedical={renameIsMedical}
          error={renameError}
          onChange={setRenameName}
          onChangeIsMedical={setRenameIsMedical}
          onCancel={onCloseRename}
          onSubmit={onSaveRename}
        />
      )}

      {blockState && (
        <BlockOnDeleteDialog
          title={`Cannot delete "${blockState.category.name}"`}
          lead={
            <>
              It&apos;s used by <strong>{blockState.category.useCount}</strong>{' '}
              {blockState.category.useCount === 1 ? 'expense' : 'expenses'}:
            </>
          }
          remediation="Re-categorise these first, then try again."
          labels={blockState.category.refLabels}
          onClose={() => setBlockState(null)}
        />
      )}

      {pendingNavModal}
      {confirmDialog}
    </section>
  );
};

interface CategoryNameModalProps {
  title: string;
  submitLabel: string;
  submitting: boolean;
  name: string;
  isMedical: boolean;
  error: string | null;
  onChange: (next: string) => void;
  onChangeIsMedical: (next: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

const CategoryNameModal: React.FC<CategoryNameModalProps> = ({
  title,
  submitLabel,
  submitting,
  name,
  isMedical,
  error,
  onChange,
  onChangeIsMedical,
  onCancel,
  onSubmit,
}) => (
  <Modal open title={title} onClose={onCancel} size="md" onEnter={onSubmit}>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <Field htmlFor="cat-modal-name" label="Name">
        <TextInput
          id="cat-modal-name"
          value={name}
          maxLength={MAX_NAME_LEN}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      </Field>
      <div className="mt-3 flex items-center justify-between gap-3">
        <ToggleSwitch
          checked={isMedical}
          onChange={onChangeIsMedical}
          label="Medical category"
          className="text-sm"
        />
        <Muted as="span" className="text-xs">
          Applies the higher medical-inflation default.
        </Muted>
      </div>
      {error && (
        <Alert tone="error" className="mt-2">
          {error}
        </Alert>
      )}
      {/* Left-aligned, primary action first — AGENTS modal rule. */}
      <div className="mt-3 flex justify-start gap-2">
        <button type="submit" className={btnPrimaryClass} disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className={btnSecondaryClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  </Modal>
);
