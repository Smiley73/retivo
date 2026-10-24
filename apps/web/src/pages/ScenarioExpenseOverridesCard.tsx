/** Scenario detail page Expense overrides card: the merged expense list with Canonical, Patched, Added and Disabled rows; writes scenario `update` mutations only, never the canonical aggregates. */
import React, { useMemo, useState } from 'react';
import {
  PlusIcon,
  RefreshIcon,
  PencilIcon,
  XIcon,
  TrashIcon,
  CheckIcon,
  UploadIcon,
} from '../components/icons';
import { useNavigate } from 'react-router';
import { useConfirm } from '../components/ConfirmDialog';
import { cryptoUuid } from '../lib/crypto-uuid';
import { saveScenario } from '../lib/scenario-mutations';
import { resolveExpensesForScenarioSparse } from '../lib/expense-override-resolution';
import { useAggregates } from '../lib/use-aggregates';
import {
  describeExpenseEnd,
  describeExpenseStart,
  formatExpenseAmount,
} from '../lib/expense-format';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useSync } from '../sync/SyncContext';
import { Alert } from '../components/Alert';
import { Badge, type BadgeTone } from '../components/Badge';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/Skeleton';
import { PageHeader } from '../components/PageHeader';
import { TextLink } from '../components/TextLink';
import { footNoteClass } from './scenarios-page-chrome';
import {
  btnSecondarySmClass,
  btnDangerSmClass,
  btnSuccessSmClass,
} from './scenarios-page-chrome';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  ExpensesOverride,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

interface Props {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  onChanged: () => Promise<void> | void;
}

export const ExpenseOverridesCard: React.FC<Props> = ({
  scenario,
  scenarios,
  householdId,
  onChanged,
}) => {
  const { confirm, dialog } = useConfirm();
  const { notifyPending } = useSync();
  const navigate = useNavigate();
  const expenseQuery = useAggregates('expense');
  const categoryQuery = useAggregates('expenseCategory');
  const memberQuery = useAggregates('householdMember');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canonical = expenseQuery.aggregates as Aggregate<ExpensePayload>[];
  const categories = categoryQuery.aggregates as Aggregate<ExpenseCategoryPayload>[];
  const members = memberQuery.aggregates as Aggregate<HouseholdMemberPayload>[];
  const loading =
    !expenseQuery.ready || !categoryQuery.ready || !memberQuery.ready;
  const loadError =
    expenseQuery.error || categoryQuery.error || memberQuery.error
      ? 'Failed to load expenses.'
      : null;

  const editInScenario = (canonicalId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      returnTo: `/scenarios/${scenario.id}/expenses`,
    });
    navigate(`/expenses/${canonicalId}/edit?${params.toString()}`);
  };

  const editAddedInScenario = (localId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      editLocalId: localId,
      returnTo: `/scenarios/${scenario.id}/expenses`,
    });
    navigate(`/expenses/scenario-entry?${params.toString()}`);
  };

  // Edits mutate the local slice so this scenario's override layer stays minimal; the merged view comes from the sparse resolver so ancestor disables, patches and adds surface too.
  const overrides: ExpensesOverride = scenario.payload.overrides.expenses ?? {};

  // Rows inherited from an ancestor's added[] resolve here but Edit / Move / Delete mutate only this scenario's added[], so they would no-op: inherited rows expose no actions.
  const isOwnedAdded = (localId: string): boolean =>
    (overrides.added ?? []).some((a) => a._localId === localId);

  // Reset deletes only this scenario's key (prefixed aggregate:<id> or bare <id>), so a row patched only by an ancestor gates it out.
  const hasOwnPatch = (canonicalId: string): boolean => {
    const patches = overrides.patches;
    if (!patches) return false;
    return `aggregate:${canonicalId}` in patches || canonicalId in patches;
  };

  const resolvedExpenses = useMemo(
    () => resolveExpensesForScenarioSparse(scenario.id, scenarios, canonical),
    [scenario.id, scenarios, canonical],
  );

  type Row =
    | { kind: 'canonical'; id: string; payload: ExpensePayload }
    | { kind: 'patched'; id: string; payload: ExpensePayload }
    | { kind: 'disabled'; id: string; payload: ExpensePayload }
    | { kind: 'added'; localId: string; payload: ExpensePayload };

  const rows: Row[] = useMemo(() => {
    const list: Row[] = [];
    const resolvedById = new Map(resolvedExpenses.map((r) => [r.id, r]));
    for (const c of canonical) {
      const prefixedId = `aggregate:${c.id}`;
      const r = resolvedById.get(prefixedId);
      if (!r) {
        list.push({ kind: 'disabled', id: c.id, payload: c.payload });
        continue;
      }
      list.push({
        kind: r.source === 'patched' ? 'patched' : 'canonical',
        id: c.id,
        payload: r.payload,
      });
    }
    for (const r of resolvedExpenses) {
      if (r.source !== 'added') continue;
      list.push({
        kind: 'added',
        localId: r.id.slice('local:'.length),
        payload: r.payload,
      });
    }
    return list;
  }, [canonical, resolvedExpenses]);

  const groups = useMemo(() => {
    const byCat = new Map<string, Row[]>();
    for (const r of rows) {
      const cid = r.payload.categoryId;
      const arr = byCat.get(cid) ?? [];
      arr.push(r);
      byCat.set(cid, arr);
    }
    const sortedCats = [...categories].sort((a, b) =>
      a.payload.name.localeCompare(b.payload.name),
    );
    const result: Array<{ id: string; name: string; rows: Row[] }> = [];
    for (const c of sortedCats) {
      const items = byCat.get(c.id);
      if (items && items.length > 0) {
        result.push({ id: c.id, name: c.payload.name, rows: items });
        byCat.delete(c.id);
      }
    }
    // Rows whose category no longer resolves go under a sentinel header so they stay visible and actionable.
    const orphans: Row[] = [];
    for (const arr of byCat.values()) orphans.push(...arr);
    if (orphans.length > 0) {
      result.push({ id: '__uncategorised__', name: 'Uncategorised', rows: orphans });
    }
    return result;
  }, [rows, categories]);

  const isOverriddenLocally = scenario.payload.overrides.expenses !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const persistOverrides = async (next: ExpensesOverride): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const cleaned: ExpensesOverride = {};
      if (next.disabledIds && next.disabledIds.length > 0) cleaned.disabledIds = next.disabledIds;
      if (next.reEnabledIds && next.reEnabledIds.length > 0)
        cleaned.reEnabledIds = next.reEnabledIds;
      if (next.added && next.added.length > 0) cleaned.added = next.added;
      if (next.patches && Object.keys(next.patches).length > 0) cleaned.patches = next.patches;
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: {
          ...scenario.payload.overrides,
          expenses: Object.keys(cleaned).length > 0 ? cleaned : undefined,
        },
      };
      if (payload.overrides.expenses === undefined) {
        const rest = { ...payload.overrides };
        delete rest.expenses;
        payload.overrides = rest;
      }
      await saveScenario({ scenario, payload, householdId });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  const onDisable = async (canonicalId: string): Promise<void> => {
    const prefixedId = `aggregate:${canonicalId}`;
    const next: ExpensesOverride = {
      ...overrides,
      disabledIds: Array.from(
        new Set([...(overrides.disabledIds ?? []), prefixedId]),
      ),
      // Disable wins a same-scenario conflict: clear any local re-enable for this id.
      reEnabledIds: (overrides.reEnabledIds ?? []).filter(
        (id) => id !== prefixedId,
      ),
      patches: overrides.patches
        ? Object.fromEntries(
            Object.entries(overrides.patches).filter(
              ([k]) => k !== prefixedId && k !== canonicalId,
            ),
          )
        : undefined,
    };
    await persistOverrides(next);
  };

  const onReEnable = async (canonicalId: string): Promise<void> => {
    const prefixedId = `aggregate:${canonicalId}`;
    const inLocalDisabled = (overrides.disabledIds ?? []).some(
      (id) => id === prefixedId || id === canonicalId,
    );
    if (inLocalDisabled) {
      const next: ExpensesOverride = {
        ...overrides,
        disabledIds: (overrides.disabledIds ?? []).filter(
          (id) => id !== prefixedId && id !== canonicalId,
        ),
      };
      await persistOverrides(next);
      return;
    }
    // Inherited disable: write reEnabledIds, never mutate ancestor state.
    const next: ExpensesOverride = {
      ...overrides,
      reEnabledIds: Array.from(
        new Set([...(overrides.reEnabledIds ?? []), prefixedId]),
      ),
    };
    await persistOverrides(next);
  };

  const onResetPatch = async (canonicalId: string): Promise<void> => {
    if (!overrides.patches) return;
    const prefixedId = `aggregate:${canonicalId}`;
    const rest = { ...overrides.patches };
    delete rest[prefixedId];
    delete rest[canonicalId];
    const next: ExpensesOverride = { ...overrides, patches: rest };
    await persistOverrides(next);
  };

  const onRemoveAdded = async (localId: string): Promise<void> => {
    const next: ExpensesOverride = {
      ...overrides,
      added: (overrides.added ?? []).filter((a) => a._localId !== localId),
    };
    await persistOverrides(next);
  };

  const onMoveToCanonical = async (localId: string): Promise<void> => {
    const target = (overrides.added ?? []).find((a) => a._localId === localId);
    if (!target) return;
    const name = target.name.trim();

    const norm = name.toLowerCase();
    const collides = canonical.some(
      (c) => (c.payload.name ?? '').trim().toLowerCase() === norm,
    );
    if (collides) {
      setError(
        `A canonical expense named "${name}" already exists. Rename the scenario expense first.`,
      );
      return;
    }
    const catExists = categories.some((c) => c.id === target.categoryId);
    if (!catExists) {
      setError("This expense's category no longer exists. Pick a new category first.");
      return;
    }

    const ok = await confirm(
      `Move "${name}" to the household list?`,
      <>
        <p>It will appear in <strong>every scenario</strong> that doesn&apos;t disable it.</p>
        <p>
          Other scenarios won&apos;t auto-disable; their projections may shift.
          This cannot be undone.
        </p>
      </>,
      { confirmLabel: 'Move to household list' },
    );
    if (!ok) return;

    setSubmitting(true);
    setError(null);
    try {
      const canonicalPayload: ExpensePayload = {
        name,
        amount: target.amount,
        frequency: target.frequency,
        classification: target.classification,
        categoryId: target.categoryId,
        start: target.start,
      };
      if (target.description) canonicalPayload.description = target.description;
      if (target.end) canonicalPayload.end = target.end;
      if (target.discretionaryGlide)
        canonicalPayload.discretionaryGlide = target.discretionaryGlide;
      const newCanonicalId = cryptoUuid();
      await queueLocalMutation<ExpensePayload>({
        type: 'expense',
        aggregateId: newCanonicalId,
        householdId,
        operation: 'create',
        expectedVersion: 0,
        payload: canonicalPayload,
      });
      const next: ExpensesOverride = {
        ...overrides,
        added: (overrides.added ?? []).filter((a) => a._localId !== localId),
      };
      await persistOverrides(next);
      notifyPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move expense.');
    } finally {
      setSubmitting(false);
    }
  };

  const onResetToInherited = async (): Promise<void> => {
    await persistOverrides({});
  };

  const addScenarioOnly = (): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      returnTo: `/scenarios/${scenario.id}/expenses`,
    });
    navigate(`/expenses/scenario-entry?${params.toString()}`);
  };

  if (loading) {
    return (
      <LoadingState label="Loading expense overrides…" variant="table" />
    );
  }

  const disabledCount = rows.filter((r) => r.kind === 'disabled').length;
  const modifiedCount = rows.filter((r) => r.kind === 'patched').length;
  const scenarioOnlyCount = rows.filter((r) => r.kind === 'added').length;

  return (
    <>
      <PageHeader
        title={
          <span id="scenario-expenses-heading">
            Expenses: {scenario.payload.name}
          </span>
        }
        subtitle="Disable an inherited expense, modify it, or add one that exists only in this scenario."
        action={{
          label: 'Add scenario-only expense',
          onClick: addScenarioOnly,
          disabled: submitting,
          ariaLabel: 'Add scenario-only expense',
        }}
        actionIcon={<PlusIcon />}
      />

      {canResetToInherited && (
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            className={`${btnDangerSmClass} gap-1.5`}
            onClick={onResetToInherited}
            disabled={submitting}
            aria-label="Reset expense overrides"
          >
            <RefreshIcon />
            Reset
          </button>
        </div>
      )}

      {(error ?? loadError) && (
        <Alert tone="error">{error ?? loadError}</Alert>
      )}

      {/* The action buttons only dim, which reads as inert, so a polite status line gives one visual and assistive-tech cue. */}
      {submitting && (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 text-sm text-muted"
        >
          <span
            aria-hidden="true"
            className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none"
          />
          Saving…
        </p>
      )}

      {rows.length === 0 && (
        <EmptyState
          action={<TextLink to="/expenses">Go to your expenses</TextLink>}
        >
          No expenses to adjust yet. Add an expense on the Expenses page to
          change it just for this scenario, or add a scenario-only one with the
          button above.
        </EmptyState>
      )}

      {rows.length > 0 && (
      <Card className="flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <header className="border-b border-line-strong px-0 pb-1 pt-2 text-xs font-semibold text-muted">
            {g.name}
          </header>
          <ul className="m-0 list-none p-0">
            {g.rows.map((r) => {
              const isDisabled = r.kind === 'disabled';
              const rowKey = r.kind === 'added' ? r.localId : r.id;
              const badgeLabel =
                r.kind === 'canonical'
                  ? 'Default'
                  : r.kind === 'patched'
                    ? 'Modified'
                    : r.kind === 'added'
                      ? 'Scenario-only'
                      : 'Disabled';
              const badgeTone: BadgeTone =
                r.kind === 'canonical'
                  ? 'neutral'
                  : r.kind === 'patched'
                    ? 'modified'
                    : r.kind === 'added'
                      ? 'scenario'
                      : 'disabled';
              // Mute the text columns, not the whole row: a row-level opacity would also subdue the Re-enable button, the affirmative path back.
              const struckTextClass = isDisabled
                ? 'text-muted line-through'
                : undefined;
              return (
                <li
                  key={rowKey}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-line-strong py-2 pl-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className={struckTextClass}>{r.payload.name}</strong>
                      <Badge tone={badgeTone}>{badgeLabel}</Badge>
                      <Badge
                        tone={
                          r.payload.classification === 'essential'
                            ? 'essential'
                            : 'discretionary'
                        }
                      >
                        {r.payload.classification === 'essential' ? 'Essential' : 'Discretionary'}
                      </Badge>
                    </div>
                    <div
                      className={`text-sm ${
                        struckTextClass ?? 'text-muted'
                      }`}
                    >
                      {describeExpenseStart(r.payload.start, members)} →{' '}
                      {describeExpenseEnd(r.payload.end, r.payload.frequency, members)}
                    </div>
                  </div>
                  <div
                    className={`min-w-32 text-right font-mono tabular-nums ${
                      struckTextClass ?? ''
                    }`}
                  >
                    {formatExpenseAmount(r.payload.amount, r.payload.frequency)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {r.kind === 'canonical' && (
                      <>
                        <button
                          type="button"
                          className={`${btnSecondarySmClass} gap-1.5`}
                          onClick={() => editInScenario(r.id)}
                          disabled={submitting}
                        >
                          <PencilIcon />
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`${btnDangerSmClass} gap-1.5`}
                          onClick={() => onDisable(r.id)}
                          disabled={submitting}
                        >
                          <XIcon />
                          Disable
                        </button>
                      </>
                    )}
                    {r.kind === 'patched' && (
                      <>
                        <button
                          type="button"
                          className={`${btnSecondarySmClass} gap-1.5`}
                          onClick={() => editInScenario(r.id)}
                          disabled={submitting}
                        >
                          <PencilIcon />
                          Edit
                        </button>
                        {hasOwnPatch(r.id) && (
                          <button
                            type="button"
                            className={`${btnDangerSmClass} gap-1.5`}
                            onClick={() => onResetPatch(r.id)}
                            disabled={submitting}
                          >
                            <RefreshIcon />
                            Reset
                          </button>
                        )}
                      </>
                    )}
                    {r.kind === 'added' && isOwnedAdded(r.localId) && (
                      <>
                        <button
                          type="button"
                          className={`${btnSecondarySmClass} gap-1.5`}
                          onClick={() => editAddedInScenario(r.localId)}
                          disabled={submitting}
                        >
                          <PencilIcon />
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`${btnSecondarySmClass} gap-1.5`}
                          onClick={() => onMoveToCanonical(r.localId)}
                          disabled={submitting}
                        >
                          <UploadIcon />
                          Move to household list
                        </button>
                        <button
                          type="button"
                          className={`${btnDangerSmClass} gap-1.5`}
                          onClick={() => onRemoveAdded(r.localId)}
                          disabled={submitting}
                        >
                          <TrashIcon />
                          Delete
                        </button>
                      </>
                    )}
                    {r.kind === 'disabled' && (
                      <button
                        type="button"
                        className={`${btnSuccessSmClass} gap-1.5`}
                        onClick={() => onReEnable(r.id)}
                        disabled={submitting}
                      >
                        <CheckIcon />
                        Re-enable
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      </Card>
      )}

      <div className={footNoteClass}>
        {disabledCount} disabled · {modifiedCount} modified · {scenarioOnlyCount}{' '}
        scenario-only.
      </div>

      {dialog}
    </>
  );
};

