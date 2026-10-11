/**
 * Tier editor for the custom drawdown order editor section.
 *
 * Exports `TierEditor` (the full drag-and-drop tier stack) and `TierList`
 * (single droppable list). Extracted from ScenarioWithdrawalStrategyCards
 * to keep each file under the 400-line cap.
 *
 * Each list owns its `useDragAndDrop` hook so its `onInsert` and `onRootDrop`
 * close over the correct `tierKey` (a single shared coordinator would route
 * drops to tier-0 whenever `beforeId` is undefined, i.e. any "after-last" or
 * empty-list drop, and hardcode `'excluded'` in `onRootDrop` regardless of
 * which empty list received the drop).
 */
import React, { useMemo } from 'react';
import { PlusIcon } from '../components/icons';
import { textLinkClass } from '../components/TextLink';
import {
  Button,
  GridList,
  GridListItem,
  useDragAndDrop,
} from 'react-aria-components';
import { Muted } from '../components/Muted';
import type { AccountPayload, Aggregate } from '../db/types';
import type { CbpInfoRow } from './scenario-withdrawal-strategy-shared';

/** MIME type used to transfer account IDs between GridList tiers in DnD. */
const ACCOUNT_DRAG_TYPE = 'application/x-tier-account-id';

/**
 * Pure function: move `movedId` to `targetKey` (e.g. `'tier-0'`, `'tier-1'`,
 * `'excluded'`), optionally before `beforeId`. Returns new `{tiers, excludedAccountIds}`.
 *
 * Extracted from the `TierEditor.moveAccount` closure so tests and callers
 * can exercise the logic directly without rendering the DnD component.
 */
export function moveAccountAcrossTiers(
  tiers: string[][],
  excludedAccountIds: string[],
  movedId: string,
  targetKey: string,
  beforeId?: string,
): { tiers: string[][]; excludedAccountIds: string[] } {
  const nextTiers = tiers.map((t) => t.filter((id) => id !== movedId));
  const nextExcluded = excludedAccountIds.filter((id) => id !== movedId);
  if (targetKey === 'excluded') {
    const pos = beforeId ? nextExcluded.indexOf(beforeId) : -1;
    nextExcluded.splice(pos >= 0 ? pos : nextExcluded.length, 0, movedId);
  } else {
    const tierIdx = parseInt(targetKey.replace('tier-', ''), 10);
    if (Number.isFinite(tierIdx) && nextTiers[tierIdx] !== undefined) {
      const pos = beforeId ? nextTiers[tierIdx].indexOf(beforeId) : -1;
      nextTiers[tierIdx].splice(pos >= 0 ? pos : nextTiers[tierIdx].length, 0, movedId);
    }
  }
  return { tiers: nextTiers, excludedAccountIds: nextExcluded };
}

// ——— TierList ————————————————————————————————————————————

/**
 * One droppable/draggable list (a single tier or the excluded section).
 *
 * Each list owns its `useDragAndDrop` hook, closed over its own
 * `tierKey`. This ensures `onInsert` and `onRootDrop` route to the correct
 * list even when `dropPosition === 'after'` (no `beforeId` available).
 */
interface TierListProps {
  listKey: string;
  label: string;
  accountIds: string[];
  accountById: Map<string, Aggregate<AccountPayload>>;
  onMoveAccount: (movedId: string, targetKey: string, beforeId?: string) => void;
  onReorderWithinList: (listKey: string, reorderedIds: string[]) => void;
  /** When true (a drawdown tier, not the Excluded list), each row is prefixed
   *  with its 1-based drain position so the within-tier sequential order
   *  is visible. Excluded accounts are never drained, so no number is shown. */
  showOrder?: boolean;
}

const TierList: React.FC<TierListProps> = ({
  listKey, label, accountIds, accountById, onMoveAccount, onReorderWithinList,
  showOrder = false,
}) => {
  // Per-list hook: tierKey is captured in closure — each list routes to itself.
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) =>
      [...keys].map((k) => ({ [ACCOUNT_DRAG_TYPE]: String(k) })),
    getAllowedDropOperations: () => ['move'],
    getDropOperation: () => 'move',
    onReorder(e) {
      const moved = [...e.keys].map(String);
      const filtered = accountIds.filter((id) => !moved.includes(id));
      const postRemoveIdx = filtered.indexOf(String(e.target.key));
      const insertAt =
        e.target.dropPosition === 'before' ? postRemoveIdx : postRemoveIdx + 1;
      filtered.splice(Math.max(0, insertAt), 0, ...moved);
      onReorderWithinList(listKey, filtered);
    },
    onInsert: async (e) => {
      for (const item of e.items) {
        if (item.kind !== 'text' || !item.types.has(ACCOUNT_DRAG_TYPE)) continue;
        const movedId = await item.getText(ACCOUNT_DRAG_TYPE);
        // dropPosition='before' → insert before the target key.
        // dropPosition='after' → insert after the target: find the next
        // element and pass that as beforeId (passing
        // undefined would always append, losing the user's intended position).
        let beforeId: string | undefined;
        if (e.target.dropPosition === 'before') {
          beforeId = String(e.target.key);
        } else {
          const targetIdx = accountIds.indexOf(String(e.target.key));
          beforeId = targetIdx >= 0 ? accountIds[targetIdx + 1] : undefined;
        }
        // listKey is captured in closure — always routes to this list.
        onMoveAccount(movedId, listKey, beforeId);
      }
    },
    onRootDrop: async (e) => {
      for (const item of e.items) {
        if (item.kind !== 'text' || !item.types.has(ACCOUNT_DRAG_TYPE)) continue;
        const movedId = await item.getText(ACCOUNT_DRAG_TYPE);
        // listKey captured in closure — correct target even for empty lists.
        onMoveAccount(movedId, listKey);
      }
    },
    acceptedDragTypes: [ACCOUNT_DRAG_TYPE],
  });

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium text-ink">{label}</p>
      <GridList
        aria-label={label}
        items={accountIds.map((id) => ({ id, key: id }))}
        dragAndDropHooks={dragAndDropHooks}
        className="min-h-10 rounded-md border border-line bg-surface-raised p-1 flex flex-col gap-0.5"
        renderEmptyState={() => (
          <p className="px-2 py-1.5 text-sm text-muted italic">
            No accounts. Drag here to add
          </p>
        )}
      >
        {(item) => (
          <GridListItem
            key={item.id}
            textValue={accountById.get(item.id)?.payload.name ?? item.id}
            className="flex cursor-grab items-center rounded px-2 py-1.5 text-sm
              text-ink
              bg-surface
              hover:bg-accent-subtle
              selected:bg-accent-subtle
              focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <>
              <Button
                slot="drag"
                aria-label={`Drag ${accountById.get(item.id)?.payload.name ?? item.id}`}
                className="mr-2 cursor-grab text-muted select-none focus:outline-none"
              >
                ⠿
              </Button>
              {showOrder && (
                <span
                  aria-hidden="true"
                  className="mr-2 tabular-nums text-xs text-muted"
                >
                  {accountIds.indexOf(item.id) + 1}.
                </span>
              )}
              <span>{accountById.get(item.id)?.payload.name ?? item.id}</span>
              <span className="ml-1 text-xs text-muted">
                {accountById.get(item.id)?.payload.type ?? ''}
              </span>
            </>
          </GridListItem>
        )}
      </GridList>
    </div>
  );
};

// ——— TierEditor ——————————————————————————————————————————

export interface TierEditorProps {
  tiers: string[][];
  excludedAccountIds: string[];
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Read-only CBP accounts shown outside the drag-and-drop lists. */
  cbpInfoRows: ReadonlyArray<CbpInfoRow>;
  onChange: (tiers: string[][], excluded: string[]) => void;
  /**
   * Invoked when the user clicks "Elect a payout" on an unconfigured CBP row.
   * The parent modal routes this through the unsaved-changes discard guard
   * before navigating to the income-add flow — a raw `<Link>` here
   * would unmount the dirty modal and silently drop the draft.
   */
  onElectPayout: (account: Aggregate<AccountPayload>) => void;
  /**
   * Invoked when the user clicks "Review pensions" on a conflicting CBP row
   * (more than one linked pension stream). Routes — through the same discard
   * guard — to the Income page so the user can remove the duplicate streams,
   * mirroring `CbpRemediationBanner`'s duplicate remediation. Adding another
   * stream (the elect-a-payout path) would deepen the duplication, so the
   * conflict row never offers it.
   */
  onReviewPensions: (account: Aggregate<AccountPayload>) => void;
}

// ——— CbpInfoSection ——————————————————————————————————————

/**
 * Read-only, non-draggable section listing every Cash Balance Pension
 * account with its treatment (annuity / lump-sum-target / unconfigured /
 * conflict). Rendered OUTSIDE the React Aria `GridList` so these never become
 * orderable tier items.
 */
interface CbpInfoRowLineProps {
  row: CbpInfoRow;
  account: Aggregate<AccountPayload> | undefined;
  onElectPayout: (account: Aggregate<AccountPayload>) => void;
  onReviewPensions: (account: Aggregate<AccountPayload>) => void;
}

const CbpInfoRowLine: React.FC<CbpInfoRowLineProps> = ({
  row,
  account,
  onElectPayout,
  onReviewPensions,
}) => {
  return (
    <li className="text-sm text-ink">
      {row.kind === 'annuity' && (
        <>
          <strong>{row.name}</strong>, paid as monthly income, so it
          isn&apos;t drawn from the portfolio.
        </>
      )}
      {row.kind === 'lumpSum' && (
        <>
          <strong>{row.name}</strong>, rolled into{' '}
          {row.targetName ?? 'another account'} at retirement; that
          account appears in the order instead.
        </>
      )}
      {row.kind === 'unconfigured' && (
        <>
          <strong>{row.name}</strong>, choose how this pension pays out
          first.{' '}
          {account && (
            <button
              type="button"
              onClick={() => onElectPayout(account)}
              aria-label={`Elect a payout for ${row.name}`}
              className={textLinkClass}
            >
              Elect a payout →
            </button>
          )}
        </>
      )}
      {row.kind === 'conflict' && (
        <>
          <strong>{row.name}</strong>, more than one pension income
          stream links to it, so it can&apos;t pay out. Remove the
          extra ones.{' '}
          {account && (
            <button
              type="button"
              onClick={() => onReviewPensions(account)}
              aria-label={`Review pensions for ${row.name}`}
              className={textLinkClass}
            >
              Review pensions →
            </button>
          )}
        </>
      )}
    </li>
  );
};

const CbpInfoSection: React.FC<{
  rows: ReadonlyArray<CbpInfoRow>;
  accountById: Map<string, Aggregate<AccountPayload>>;
  onElectPayout: (account: Aggregate<AccountPayload>) => void;
  onReviewPensions: (account: Aggregate<AccountPayload>) => void;
}> = ({ rows, accountById, onElectPayout, onReviewPensions }) => {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        Cash Balance Pensions, not drawn down
      </span>
      <ul className="m-0 flex flex-col gap-1 rounded-md border border-line bg-surface p-2 list-none">
        {rows.map((row) => (
          <CbpInfoRowLine
            key={row.accountId}
            row={row}
            account={accountById.get(row.accountId)}
            onElectPayout={onElectPayout}
            onReviewPensions={onReviewPensions}
          />
        ))}
      </ul>
    </div>
  );
};

/**
 * Tier editor: N tier cards + an Excluded card, all cross-draggable.
 *
 * Per-list hooks via `TierList`; `moveAccount` and `reorderWithinList`
 * are stable callbacks threaded down as props so each list's handlers close
 * over the correct `tierKey` without a shared coordinator.
 */
export const TierEditor: React.FC<TierEditorProps> = ({
  tiers, excludedAccountIds, accounts, cbpInfoRows, onChange, onElectPayout, onReviewPensions,
}) => {
  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  /** Move account `movedId` to list `targetKey` before `beforeId` (or at end). */
  const moveAccount = (movedId: string, targetKey: string, beforeId?: string): void => {
    const { tiers: nextTiers, excludedAccountIds: nextExcluded } =
      moveAccountAcrossTiers(tiers, excludedAccountIds, movedId, targetKey, beforeId);
    onChange(nextTiers, nextExcluded);
  };

  /** Reorder within a single list (drag up/down within the same tier). */
  const reorderWithinList = (listKey: string, reorderedIds: string[]): void => {
    if (listKey === 'excluded') {
      onChange(tiers, reorderedIds);
    } else {
      const idx = parseInt(listKey.replace('tier-', ''), 10);
      if (!Number.isFinite(idx) || tiers[idx] === undefined) return;
      const next = [...tiers];
      next[idx] = reorderedIds;
      onChange(next, excludedAccountIds);
    }
  };

  const addTier = (): void => onChange([...tiers, []], excludedAccountIds);

  const removeTier = (idx: number): void => {
    const removed = tiers[idx];
    const nextTiers = tiers.filter((_, i) => i !== idx);
    if (nextTiers.length > 0) {
      nextTiers[0] = [...nextTiers[0], ...removed];
    } else {
      onChange(nextTiers, [...excludedAccountIds, ...removed]);
      return;
    }
    onChange(nextTiers, excludedAccountIds);
  };

  return (
    <div className="flex flex-col gap-3">
      {tiers.map((tierIds, idx) => (
        <div key={`tier-${idx}`} className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Tier {idx + 1}{idx === 0 ? ' (drained first)' : idx === tiers.length - 1 ? ' (drained last)' : ''}
            </span>
            {tiers.length > 1 && (
              <button
                type="button"
                onClick={() => removeTier(idx)}
                className="text-xs text-muted hover:text-negative"
                aria-label={`Remove tier ${idx + 1}`}
              >
                Remove tier
              </button>
            )}
          </div>
          <TierList
            listKey={`tier-${idx}`}
            label={`Tier ${idx + 1}`}
            accountIds={tierIds}
            accountById={accountById}
            onMoveAccount={moveAccount}
            onReorderWithinList={reorderWithinList}
            showOrder
          />
        </div>
      ))}
      <button
        type="button"
        onClick={addTier}
        className={`${textLinkClass} inline-flex items-center gap-1.5 text-sm self-start`}
      >
        <PlusIcon />
        Add tier
      </button>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          Excluded (never drawn from)
        </span>
        <TierList
          listKey="excluded"
          label="Excluded accounts"
          accountIds={excludedAccountIds}
          accountById={accountById}
          onMoveAccount={moveAccount}
          onReorderWithinList={reorderWithinList}
        />
      </div>
      <CbpInfoSection
        rows={cbpInfoRows}
        accountById={accountById}
        onElectPayout={onElectPayout}
        onReviewPensions={onReviewPensions}
      />
      <Muted className="text-sm">
        Tiers drain top to bottom, and within a tier accounts drain in the order
        you list them — the first account is fully spent before the next is
        touched. Drag accounts between tiers, reorder them inside a tier, or move
        them to Excluded (never drained, useful for HSAs reserved for medical
        expenses). Keyboard: Space to lift, arrows to move, Enter to drop.
      </Muted>
    </div>
  );
};
