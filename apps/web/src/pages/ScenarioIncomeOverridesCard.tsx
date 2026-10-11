/**
 * Scenario detail page: Income overrides card.
 *
 * Mirrors ScenarioExpenseOverridesCard one-for-one — same status
 * badges (Default | Modified | Scenario-only | Disabled), same
 * inline-disabled row treatment (struck + dim with the green
 * Re-enable affordance), same per-row actions, same "Move to
 * household list" promote flow. Diverges only where the income
 * data model demands it:
 *
 *   - rows are grouped by `memberId` (not by category, which income
 *     does not have);
 *   - Edit on a canonical/patched row opens the shared `IncomeFormPage`
 *     in scenario-patch mode (full-form, per-key patch); Edit on a
 *     scenario-only added row re-opens it in add-edit mode.
 *
 * The card writes scenario `update` mutations only — canonical
 * IncomeStream aggregates are never touched from this card.
 */
import React, { useMemo, useState } from 'react';
import {
  PlusIcon,
  PencilIcon,
  XIcon,
  TrashIcon,
  RefreshIcon,
  CheckIcon,
  UploadIcon,
} from '../components/icons';
import { useNavigate } from 'react-router';
import { useConfirm } from '../components/ConfirmDialog';
import { saveScenario } from '../lib/scenario-mutations';
import { resolveIncomeForScenarioSparse } from '../lib/income-override-resolution';
import { useAggregates } from '../lib/use-aggregates';
import {
  formatIncomeAmount,
  formatIncomeKind,
  formatIncomeSchedule,
  memberDisplayName,
} from '../lib/income-format';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useSync } from '../sync/SyncContext';
import { cryptoUuid } from '../lib/crypto-uuid';
import { Alert } from '../components/Alert';
import { Badge, type BadgeTone } from '../components/Badge';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/Skeleton';
import { PageHeader } from '../components/PageHeader';
import { TextLink } from '../components/TextLink';
import {
  btnSecondarySmClass,
  btnDangerSmClass,
  btnSuccessSmClass,
  footNoteClass,
} from './scenarios-page-chrome';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeOverride,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

interface Props {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  onChanged: () => Promise<void> | void;
}

export const IncomeOverridesCard: React.FC<Props> = ({
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
  const incomeQuery = useAggregates('incomeStream');
  const memberQuery = useAggregates('householdMember');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canonical = incomeQuery.aggregates as Aggregate<IncomeStreamPayload>[];
  const members = memberQuery.aggregates as Aggregate<HouseholdMemberPayload>[];
  const loading = !incomeQuery.ready || !memberQuery.ready;
  const loadError =
    incomeQuery.error || memberQuery.error
      ? 'Failed to load income sources.'
      : null;

  /** Open the shared income editor on a canonical/patched row in
   *  scenario-patch mode; Save writes a per-key `Partial<IncomeStreamPayload>`
   *  patch into this scenario (the canonical aggregate is untouched). */
  const editInScenario = (canonicalId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      returnTo: `/scenarios/${scenario.id}/income`,
    });
    navigate(`/income/${canonicalId}/edit?${params.toString()}`);
  };

  /** Re-open a scenario-only added row in the full form (add-edit mode);
   *  Save replaces the matching `added[]` entry by `_localId` in place. */
  const editAddedInScenario = (localId: string): void => {
    const params = new URLSearchParams({
      scenarioId: scenario.id,
      editLocalId: localId,
      returnTo: `/scenarios/${scenario.id}/income`,
    });
    navigate(`/income/scenario-entry?${params.toString()}`);
  };

  // Local-only overrides — written back to `scenario.payload.overrides.income`.
  // Edit actions (disable/patch/add/remove) mutate the *local* slice so the
  // override layer for *this* scenario stays minimal; the merged view is
  // the per-id sparse resolver output so ancestor disables / patches /
  // added entries this scenario hasn't re-enabled surface here too.
  const overrides: IncomeOverride = scenario.payload.overrides.income ?? {};

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

  const resolvedIncome = useMemo(
    () => resolveIncomeForScenarioSparse(scenario.id, scenarios, canonical),
    [scenario.id, scenarios, canonical],
  );

  /**
   * Build the rendered list by walking the canonical list in its
   * natural order so disabled rows stay where the user left them
   * (greyed out + Re-enable). Then append every scenario-only `added`
   * entry the sparse resolver returns (this scenario's own + any
   * inherited from ancestors).
   */
  type Row =
    | { kind: 'canonical'; id: string; payload: IncomeStreamPayload }
    | { kind: 'patched'; id: string; payload: IncomeStreamPayload }
    | { kind: 'disabled'; id: string; payload: IncomeStreamPayload }
    | { kind: 'added'; localId: string; payload: IncomeStreamPayload };

  const rows: Row[] = useMemo(() => {
    const list: Row[] = [];
    const resolvedById = new Map(resolvedIncome.map((r) => [r.id, r]));
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
    for (const r of resolvedIncome) {
      if (r.source !== 'added') continue;
      list.push({
        kind: 'added',
        localId: r.id.slice('local:'.length),
        payload: r.payload,
      });
    }
    return list;
  }, [canonical, resolvedIncome]);

  /**
   * Group rows by `memberId`. Walk the members list in stable order
   * (primary first, then secondary) so headers don't reshuffle. Rows
   * whose `memberId` no longer resolves fall into a synthetic
   * "Unassigned" trailing group so they stay visible + actionable.
   */
  const groups = useMemo(() => {
    const byMember = new Map<string, Row[]>();
    for (const r of rows) {
      const mid = r.payload.memberId;
      const arr = byMember.get(mid) ?? [];
      arr.push(r);
      byMember.set(mid, arr);
    }
    const sortedMembers = [...members].sort((a, b) => {
      if (a.payload.isPrimary && !b.payload.isPrimary) return -1;
      if (!a.payload.isPrimary && b.payload.isPrimary) return 1;
      return memberDisplayName(a).localeCompare(memberDisplayName(b));
    });
    const result: Array<{ id: string; name: string; rows: Row[] }> = [];
    for (const m of sortedMembers) {
      const items = byMember.get(m.id);
      if (items && items.length > 0) {
        result.push({ id: m.id, name: memberDisplayName(m), rows: items });
        byMember.delete(m.id);
      }
    }
    const orphans: Row[] = [];
    for (const arr of byMember.values()) orphans.push(...arr);
    if (orphans.length > 0) {
      result.push({ id: '__unassigned__', name: 'Unassigned', rows: orphans });
    }
    return result;
  }, [rows, members]);

  const isOverriddenLocally = scenario.payload.overrides.income !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const persistOverrides = async (next: IncomeOverride): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      // Strip empty fields so the override stays minimal.
      const cleaned: IncomeOverride = {};
      if (next.disabledIds && next.disabledIds.length > 0) cleaned.disabledIds = next.disabledIds;
      if (next.reEnabledIds && next.reEnabledIds.length > 0)
        cleaned.reEnabledIds = next.reEnabledIds;
      if (next.added && next.added.length > 0) cleaned.added = next.added;
      if (next.patches && Object.keys(next.patches).length > 0) cleaned.patches = next.patches;
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: {
          ...scenario.payload.overrides,
          income: Object.keys(cleaned).length > 0 ? cleaned : undefined,
        },
      };
      // Drop the key entirely when empty so the resolver inherits.
      if (payload.overrides.income === undefined) {
        const rest = { ...payload.overrides };
        delete rest.income;
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
    const next: IncomeOverride = {
      ...overrides,
      disabledIds: Array.from(
        new Set([...(overrides.disabledIds ?? []), prefixedId]),
      ),
      // Disable wins same-scenario conflict.
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
      const next: IncomeOverride = {
        ...overrides,
        disabledIds: (overrides.disabledIds ?? []).filter(
          (id) => id !== prefixedId && id !== canonicalId,
        ),
      };
      await persistOverrides(next);
      return;
    }
    const next: IncomeOverride = {
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
    const next: IncomeOverride = { ...overrides, patches: rest };
    await persistOverrides(next);
  };

  const onRemoveAdded = async (localId: string): Promise<void> => {
    const next: IncomeOverride = {
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
        `A canonical income source named "${name}" already exists. Rename the scenario entry first.`,
      );
      return;
    }
    // Validate: memberId still resolves.
    const memberExists = members.some((m) => m.id === target.memberId);
    if (!memberExists) {
      setError("This income source's owner no longer exists. Re-assign first.");
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
      const { _localId, ...canonicalPayload } = target;
      void _localId;
      const newCanonicalId = cryptoUuid('lid');
      await queueLocalMutation<IncomeStreamPayload>({
        type: 'incomeStream',
        aggregateId: newCanonicalId,
        householdId,
        operation: 'create',
        expectedVersion: 0,
        payload: canonicalPayload as IncomeStreamPayload,
      });
      // Drop the entry from scenario.added in the same batch.
      const next: IncomeOverride = {
        ...overrides,
        added: (overrides.added ?? []).filter((a) => a._localId !== localId),
      };
      await persistOverrides(next);
      notifyPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move income source.');
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
      returnTo: `/scenarios/${scenario.id}/income`,
    });
    navigate(`/income/scenario-entry?${params.toString()}`);
  };

  if (loading) {
    return (
      <LoadingState label="Loading income overrides…" variant="table" />
    );
  }

  // Footer counts (mock `.foot-note`) — derived from the rendered rows so
  // they always match what the user sees.
  const disabledCount = rows.filter((r) => r.kind === 'disabled').length;
  const modifiedCount = rows.filter((r) => r.kind === 'patched').length;
  const scenarioOnlyCount = rows.filter((r) => r.kind === 'added').length;

  return (
    <>
      <PageHeader
        title={
          <span id="scenario-income-heading">
            Income: {scenario.payload.name}
          </span>
        }
        subtitle="Disable an inherited income source, modify it, or add one that exists only in this scenario."
        action={{
          label: 'Add scenario-only income',
          onClick: addScenarioOnly,
          disabled: submitting,
          ariaLabel: 'Add scenario-only income',
        }}
        actionIcon={<PlusIcon />}
      />

      {canResetToInherited && (
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            className={`${btnSecondarySmClass} gap-1.5`}
            onClick={onResetToInherited}
            disabled={submitting}
            aria-label="Reset income overrides"
          >
            <RefreshIcon />
            Reset
          </button>
        </div>
      )}

      {(error ?? loadError) && (
        <Alert tone="error">{error ?? loadError}</Alert>
      )}

      {rows.length === 0 && (
        <EmptyState
          action={<TextLink to="/income">Go to your income sources</TextLink>}
        >
          No income to adjust yet. Add an income source on the Income page to
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
              // Mute *content*, not the whole row — keeps the green
              // Re-enable button vivid as the affirmative path back.
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
                      <Badge>{formatIncomeKind(r.payload)}</Badge>
                    </div>
                    <div
                      className={`text-sm ${
                        struckTextClass ?? 'text-muted'
                      }`}
                    >
                      {formatIncomeSchedule(r.payload, members)}
                    </div>
                  </div>
                  <div
                    className={`min-w-32 text-right font-mono tabular-nums ${struckTextClass ?? ''}`}
                  >
                    {formatIncomeAmount(r.payload)}
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
                            className={`${btnSecondarySmClass} gap-1.5`}
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
