/**
 * Scenario detail page: Expense overrides card.
 *
 * Renders the merged expense list for the scenario with status
 * badges (Canonical | Patched | Added | Disabled). Per-row actions:
 *
 * - Canonical: Edit + Disable
 * - Patched:   Edit + Reset (drop the whole patch)
 * - Added:     Edit (re-open in the shared editor's scenario add-edit
 *              mode, replacing the `added[]` entry in place) + Move to
 *              household list + Delete (drop from added).
 * - Disabled:  Re-enable (green) — row stays in its original position,
 *              greyed out, so the user sees what's been turned off
 *              without scrolling to a separate section.
 *
 * The card writes scenario `update` mutations only — canonical Expense
 * aggregates are never touched from this card.
 */
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
  // Reactive reads: each canonical list re-reads on any write to its store
  // (single writes via the fine signal, bulk fills via the coarse workspace
  // event). Read-only — the override edits write to the scenario, never to
  // these — so auto-re-read never clobbers an in-progress edit.
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

  /** Open the shared expense editor pre-filled with this scenario's
   *  resolved values; Save writes a per-key `Partial<ExpensePayload>`
   *  patch into this scenario (the canonical aggregate is untouched). */
  const editInScenario = (canonicalId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      returnTo: `/scenarios/${scenario.id}/expenses`,
    });
    navigate(`/expenses/${canonicalId}/edit?${params.toString()}`);
  };

  /** Re-open a scenario-only added row in the full form (add-edit mode);
   *  Save replaces the matching `added[]` entry by `_localId` in place. */
  const editAddedInScenario = (localId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      editLocalId: localId,
      returnTo: `/scenarios/${scenario.id}/expenses`,
    });
    navigate(`/expenses/scenario-entry?${params.toString()}`);
  };

  // Local-only overrides — written back to `scenario.payload.overrides.expenses`.
  // Edit actions (disable/patch/add/remove) mutate the *local* slice so the
  // override layer for *this* scenario stays minimal; the merged view (used
  // for what the user sees) is the per-id sparse resolver output so
  // ancestor disables / patches / added entries this scenario hasn't
  // re-enabled surface here too.
  const overrides: ExpensesOverride = scenario.payload.overrides.expenses ?? {};

  // An added row is "owned" only when its `_localId` lives in THIS scenario's
  // `added[]`. Rows inherited from an ancestor's `added[]` resolve here too,
  // but Edit / Move / Delete all mutate the current scenario's `added[]` only,
  // so they would no-op (or navigate to a not-found editor) on inherited rows.
  // Inherited added rows therefore expose no per-row actions.
  const isOwnedAdded = (localId: string): boolean =>
    (overrides.added ?? []).some((a) => a._localId === localId);

  // A `patched` row is "owned" only when THIS scenario's `patches` records the
  // patch (under the prefixed `aggregate:<id>` key or the bare `<id>` key — the
  // two forms `onResetPatch` deletes). A row that resolves to `patched` purely
  // from an ancestor's patch has no key here, so Reset (which deletes only the
  // current scenario's key) would be a no-op — gate it out.
  const hasOwnPatch = (canonicalId: string): boolean => {
    const patches = overrides.patches;
    if (!patches) return false;
    return `aggregate:${canonicalId}` in patches || canonicalId in patches;
  };

  const resolvedExpenses = useMemo(
    () => resolveExpensesForScenarioSparse(scenario.id, scenarios, canonical),
    [scenario.id, scenarios, canonical],
  );

  /**
   * Build the rendered list by walking the canonical list in its
   * natural order so disabled rows stay where the user left them
   * (greyed out + Re-enable). Then append every scenario-only `added`
   * entry the sparse resolver returns (this scenario's own + any
   * inherited from ancestors). The flat list is grouped by category
   * below (see `groups`).
   */
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
      // `r.id` is `local:<_localId>`; strip prefix for the row key.
      list.push({
        kind: 'added',
        localId: r.id.slice('local:'.length),
        payload: r.payload,
      });
    }
    return list;
  }, [canonical, resolvedExpenses]);

  /**
   * Group rows by `categoryId`. Walks the categories list in
   * alphabetical name order so the section order is stable across
   * renders and matches the Expenses page sort. Categories with
   * zero rows are dropped. Rows whose `categoryId` no longer
   * resolves to a category fall into a synthetic "Uncategorised"
   * trailing group so they remain visible + actionable.
   */
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
    // Anything left points at a missing category — surface it under a
    // sentinel header so the user can re-categorise / remove it.
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
      // Strip empty fields so the override stays minimal.
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
      // Drop the key entirely when empty so the resolver inherits.
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
      // Disable wins same-scenario conflict: clear any
      // local re-enable for this id so storage stays minimal.
      reEnabledIds: (overrides.reEnabledIds ?? []).filter(
        (id) => id !== prefixedId,
      ),
      // If a local patch existed for this id, drop it — disable wins.
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
      // Disable lives on THIS scenario — drop it locally.
      const next: ExpensesOverride = {
        ...overrides,
        disabledIds: (overrides.disabledIds ?? []).filter(
          (id) => id !== prefixedId && id !== canonicalId,
        ),
      };
      await persistOverrides(next);
      return;
    }
    // Inherited disable from an ancestor — write `reEnabledIds`
    // explicitly (never mutate ancestor state).
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

    // Validate: name uniqueness against existing canonical (case-folded).
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
    // Validate: categoryId still resolves.
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
      // Strip _localId before promoting; assign a fresh canonical UUID.
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
      // Drop the entry from scenario.added in the same batch (separate
      // mutation; the local queue applies them back-to-back). Rebuild
      // overrides without the moved entry.
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

  // Footer counts (mock `.foot-note`) — derived from the rendered rows so
  // they always match what the user sees (disabled rows kept in-place,
  // patched rows surfaced as Modified, scenario-only added rows appended).
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

      {/* Single saving indicator while a mutation is in flight: the action
          buttons only dim via `disabled`, which reads as inert rather than
          working. A polite status line gives one clear visual + AT cue. */}
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
              // User-facing labels:
              //   canonical → "Default"      (the household-wide entry)
              //   patched   → "Modified"     (any field overridden in this
              //                               scenario, or inherited per-key
              //                               from an ancestor)
              //   added     → "Scenario-only" (lives only in this scenario)
              //   disabled  → "Disabled"     (turned off in this scenario)
              const badgeLabel =
                r.kind === 'canonical'
                  ? 'Default'
                  : r.kind === 'patched'
                    ? 'Modified'
                    : r.kind === 'added'
                      ? 'Scenario-only'
                      : 'Disabled';
              // Soft-tinted status pill per row kind, mapped to the
              // typed <Badge> tone (Tailwind-defaults).
              const badgeTone: BadgeTone =
                r.kind === 'canonical'
                  ? 'neutral'
                  : r.kind === 'patched'
                    ? 'modified'
                    : r.kind === 'added'
                      ? 'scenario'
                      : 'disabled';
              // Mute *content*, not the whole row. A whole-row opacity
              // would also subdue the green Re-enable button — instead,
              // strike-through + dim the text columns (name +
              // description + amount) and keep the action bar at full
              // saturation so Re-enable reads as the affirmative path
              // back to normal. Badges are status pills and stay vivid.
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

