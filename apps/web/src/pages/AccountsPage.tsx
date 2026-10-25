/** Accounts list: reads account, householdMember and accountBalance aggregates; mutations go through queueLocalMutation. */
import React, { useMemo, useState } from 'react';
import { PlusIcon } from '../components/icons';
import { Link, useSearchParams } from 'react-router';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { AccountFormModal } from './AccountFormModal';
import { BlockOnDeleteDialog } from '../components/BlockOnDeleteDialog';
import { useSync } from '../sync/SyncContext';
import { listAggregates } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useAggregates } from '../lib/use-aggregates';
import { accountIncomeReferenceLabels } from '../lib/account-income-links';
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountType,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import { ACCOUNT_TYPE_LABELS, TAX_TREATMENT_LABELS } from '../api/types';
import { LoadingState } from '../components/Skeleton';
import { Select } from '../components/Select';
import { Badge, badgeToneForBucket } from '../components/Badge';
import {
  taxProfileCompleteness,
  type TaxProfileCompleteness,
} from '../lib/account-tax-profile';
import { deletingRothIraRaisesPooledTaxFree } from '../lib/roth-pool-warnings';
import { Alert } from '../components/Alert';
import { NotesIndicator } from '../components/NotesIndicator';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { textLinkClass } from '../components/TextLink';
import { TableScroll } from '../components/TableScroll';
import { accountBucket } from '../lib/account-bucket';
import {
  BucketBar,
  PencilIcon,
  TrashIcon,
  iactDeleteClass,
  iactEditClass,
  inactiveRowCellClass,
  tableClass,
  tdClass,
  tdNumClass,
  thClass,
} from './accounts-page-chrome';

interface AccountRow {
  id: string;
  version: number;
  payload: AccountPayload;
  ownerDisplayName: string;
}

// Owner maps to JOINT, the primary member or the secondary member.
type OwnerFilter = '' | 'JOINT' | 'PRIMARY' | 'SECONDARY';

export const AccountsPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  // The form modal is driven by the URL (?new, ?edit=<id>) so cross-page links deep-link into it and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm, dialog } = useConfirm();
  const accountQuery = useAggregates('account');
  const memberQuery = useAggregates('householdMember');
  const balanceQuery = useAggregates('accountBalance');
  const [filterType, setFilterType] = useState<AccountType | ''>('');
  const [filterOwner, setFilterOwner] = useState<OwnerFilter>('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blockState, setBlockState] = useState<{
    accountName: string;
    labels: string[];
  } | null>(null);

  const accounts = accountQuery.aggregates as ReadonlyArray<
    Aggregate<AccountPayload>
  >;
  const members = memberQuery.aggregates as ReadonlyArray<
    Aggregate<HouseholdMemberPayload>
  >;
  const balances = balanceQuery.aggregates as ReadonlyArray<
    Aggregate<AccountBalancePayload>
  >;

  const ready = accountQuery.ready && memberQuery.ready && balanceQuery.ready;
  const loadError =
    accountQuery.error || memberQuery.error || balanceQuery.error
      ? 'Failed to load accounts'
      : null;
  const error = loadError ?? deleteError;

  // Prefer firstName in user-facing copy; fall back to the role label only when the name is missing.
  const primary = members.find((m) => m.payload.isPrimary === true);
  const secondary = members.find((m) => m.payload.isPrimary !== true);
  const primaryFirst = primary?.payload.firstName?.trim() ?? '';
  const secondaryFirst = secondary?.payload.firstName?.trim() ?? '';
  const primaryLabel = primaryFirst.length > 0 ? primaryFirst : 'Primary';
  const secondaryLabel = secondaryFirst.length > 0 ? secondaryFirst : 'Secondary';

  // null until the first read settles, so the page keeps its loading skeleton. Balance-row presence is decided by a click-time read in onDelete, not this snapshot.
  const rows = useMemo<AccountRow[] | null>(() => {
    if (!ready) return null;
    const memberById = new Map<string, HouseholdMemberPayload>();
    for (const m of members) memberById.set(m.id, m.payload);
    const built: AccountRow[] = accounts.map((a) => ({
      id: a.id,
      version: a.version,
      payload: a.payload,
      ownerDisplayName: ownerDisplay(a.payload, memberById),
    }));
    const filtered = built.filter((r) => {
      if (filterType && r.payload.type !== filterType) return false;
      if (filterOwner) {
        if (filterOwner === 'JOINT') {
          if (r.payload.ownershipType !== 'JOINT') return false;
        } else if (filterOwner === 'PRIMARY') {
          if (r.payload.ownershipType === 'JOINT') return false;
          if (!primary || r.payload.ownerId !== primary.id) return false;
        } else if (filterOwner === 'SECONDARY') {
          if (r.payload.ownershipType === 'JOINT') return false;
          if (!secondary || r.payload.ownerId !== secondary.id) return false;
        }
      }
      return true;
    });
    filtered.sort((a, b) => a.payload.name.localeCompare(b.payload.name));
    return filtered;
  }, [ready, accounts, members, primary, secondary, filterType, filterOwner]);

  const onDelete = async (row: AccountRow) => {
    if (!householdId) return;
    // Block-on-reference runs first so a refused delete is never confirmed. Re-read income, scenarios, accounts and balances at click time:
    // a balance row written by another tab lands in IndexedDB without moving this account's version or firing a cross-tab signal.
    const [incomeStreams, scenarios, freshAccounts, freshBalances] = await Promise.all([
      listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
      listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
      listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
      listAggregates('accountBalance') as Promise<Aggregate<AccountBalancePayload>[]>,
    ]);
    const refs = accountIncomeReferenceLabels(row.id, incomeStreams, scenarios);
    if (refs.length > 0) {
      setBlockState({ accountName: row.payload.name, labels: refs });
      return;
    }
    // Deleting a Roth IRA that consumed its owner's pool leaves more tax-free money. Run the §408A pool both ways over the full non-deleted set (inactive accounts count, so never the form modal's active-only list).
    const raisesPooledTaxFree = deletingRothIraRaisesPooledTaxFree(
      row.id,
      freshAccounts,
      freshBalances,
    );
    const hasBalanceData = freshBalances.some((b) => b.payload.accountId === row.id);
    if (hasBalanceData) {
      const ok1 = await confirm(
        `Delete "${row.payload.name}"?`,
        <>
          This account has balance data that will also be deleted.
          {raisesPooledTaxFree && (
            <>
              {' '}
              The tax-free part of a Roth withdrawal is worked out from the accounts you
              still have, so deleting this one can increase the tax-free amount
              calculated for your other Roth IRAs.
            </>
          )}
        </>,
        { confirmLabel: 'Delete', cancelLabel: 'Cancel' },
      );
      if (!ok1) return;
      const ok2 = await confirm('Are you sure?', 'This action cannot be undone.', {
        confirmLabel: 'Yes, delete',
        cancelLabel: 'Cancel',
      });
      if (!ok2) return;
    } else {
      const ok = await confirm(`Delete "${row.payload.name}"?`, 'This action cannot be undone.');
      if (!ok) return;
    }
    setDeleteError(null);
    try {
      await queueLocalMutation<AccountPayload>({
        type: 'account',
        aggregateId: row.id,
        householdId,
        operation: 'delete',
        expectedVersion: row.version,
        payload: row.payload,
      });
      notifyPending();
    } catch {
      setDeleteError('Failed to delete account');
    }
  };

  const editId = searchParams.get('edit');
  const formMode: { accountId: string | null } | null = searchParams.has('new')
    ? { accountId: null }
    : editId
      ? { accountId: editId }
      : null;
  const openCreateForm = () => setSearchParams({ new: '' });
  const closeForm = () => {
    setSearchParams({});
  };

  return (
    <section aria-labelledby="accounts-heading">
      <PageHeader
        title={<span id="accounts-heading">Accounts</span>}
        subtitle="Manage your retirement and savings accounts."
        action={{ label: 'Add Account', onClick: openCreateForm }}
        actionIcon={<PlusIcon />}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mb-3 min-w-0 flex-1">
          <label
            htmlFor="filter-type"
            className="mb-1 block text-sm font-medium text-ink"
          >
            Type
          </label>
          <Select
            id="filter-type"
            ariaLabel="Type"
            value={filterType}
            onChange={(v) => setFilterType(v as AccountType | '')}
            options={[
              { value: '', label: 'All types' },
              ...(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map(
                (t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }),
              ),
            ]}
          />
        </div>
        <div className="mb-3 min-w-0 flex-1">
          <label
            htmlFor="filter-owner"
            className="mb-1 block text-sm font-medium text-ink"
          >
            Owner
          </label>
          <Select
            id="filter-owner"
            ariaLabel="Owner"
            value={filterOwner}
            onChange={(v) => setFilterOwner(v as OwnerFilter)}
            options={[
              { value: '', label: 'All' },
              { value: 'JOINT', label: 'Joint' },
              { value: 'PRIMARY', label: primaryLabel },
              { value: 'SECONDARY', label: secondaryLabel },
            ]}
          />
        </div>
      </div>

      {rows === null ? (
        <LoadingState label="Loading your accounts…" variant="table" />
      ) : rows.length === 0 ? (
        <EmptyState
          action={
            <button
              type="button"
              className={textLinkClass}
              onClick={openCreateForm}
            >
              Add your first account
            </button>
          }
        >
          No accounts yet. Accounts hold the savings you draw on in retirement:
          checking, brokerage, 401(k), IRA, and the like. Add your first one to
          start projecting how long your money lasts.
        </EmptyState>
      ) : (
        // scroll={false}: the rows use the hover-revealed .row-actions cluster (WebKit stuck-:hover bug, see TableScroll).
        <TableScroll label="Retirement and savings accounts" scroll={false}>
          <Table aria-label="Retirement and savings accounts" className={tableClass}>
          <TableHeader>
            <Column isRowHeader className={thClass}>Name</Column>
            <Column className={thClass}>Owner</Column>
            <Column className={thClass}>Type</Column>
            <Column className={thClass}>Tax</Column>
            <Column className={thClass}>Institution</Column>
            <Column className={thClass}>Mix</Column>
            <Column className={thClass}>
              <span className="sr-only">Actions</span>
            </Column>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const cell = r.payload.active
                ? tdClass
                : `${tdClass} ${inactiveRowCellClass}`;
              const bucket = accountBucket(r.payload.type);
              return (
                <Row key={r.id} id={r.id} className="group/row">
                  <Cell className={`${cell} relative`}>
                    <BucketBar bucket={bucket} />
                    <span className="inline-flex items-center gap-1.5">
                      {r.payload.name}
                      <NotesIndicator notes={r.payload.notes} />
                      <TaxDetailsBadge
                        payload={r.payload}
                        name={r.payload.name}
                        ownerBirthdate={
                          members.find((member) => member.id === r.payload.ownerId)
                            ?.payload.birthdate
                        }
                      />
                    </span>
                    {!r.payload.active && (
                      <Badge tone="muted" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </Cell>
                  <Cell className={cell}>{r.ownerDisplayName}</Cell>
                  <Cell className={cell}>
                    <Badge tone={badgeToneForBucket(bucket)}>
                      {ACCOUNT_TYPE_LABELS[r.payload.type]}
                    </Badge>
                  </Cell>
                  <Cell className={cell}>
                    {TAX_TREATMENT_LABELS[r.payload.taxTreatment]}
                  </Cell>
                  <Cell className={cell}>{r.payload.institution}</Cell>
                  <Cell className={`${tdNumClass} whitespace-nowrap`}>
                    {r.payload.type === 'RETIREMENT_CASH_BALANCE'
                      ? '—'
                      : `${Math.round(r.payload.assetMix.stocksPct)}/${Math.round(r.payload.assetMix.bondsPct)}/${Math.round(r.payload.assetMix.cashPct)}`}
                  </Cell>
                  <Cell className={cell}>
                    <div className="row-actions items-center">
                      {/* A real <Link> keeps middle-click and open-in-new-tab working; the icon carries its accessible name via aria-label. */}
                      <Link
                        to={`/accounts?edit=${r.id}`}
                        className={iactEditClass}
                        aria-label="Edit"
                      >
                        <PencilIcon />
                      </Link>
                      <button
                        type="button"
                        className={iactDeleteClass}
                        onClick={() => onDelete(r)}
                        aria-label={`Delete ${r.payload.name}`}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </Cell>
                </Row>
              );
            })}
          </TableBody>
          </Table>
        </TableScroll>
      )}
      {blockState && (
        <BlockOnDeleteDialog
          title={`Cannot delete "${blockState.accountName}"`}
          lead={
            <>
              It&apos;s referenced by{' '}
              <strong>{blockState.labels.length}</strong>{' '}
              income {blockState.labels.length === 1 ? 'source' : 'sources'}:
            </>
          }
          remediation="Re-point or remove the income source first, then try again."
          labels={blockState.labels}
          footerLink={{ to: '/income', label: 'Go to Income →' }}
          onClose={() => setBlockState(null)}
        />
      )}
      {formMode && (
        <AccountFormModal
          accountId={formMode.accountId}
          balances={balances}
          accounts={accounts.filter((account) => account.payload.active)}
          onClose={closeForm}
        />
      )}
      {dialog}
    </section>
  );
};

// Rendered only for a blocked legacy/imported inherited account; accepted safe assumptions show no badge.
const TaxDetailsBadge: React.FC<{
  readonly payload: AccountPayload;
  readonly name: string;
  readonly ownerBirthdate?: string;
}> = ({ payload, name, ownerBirthdate }) => {
  const state: TaxProfileCompleteness = taxProfileCompleteness(payload, ownerBirthdate);
  if (state !== 'blocked') return null;
  // The badge text alone ("On hold") is ambiguous out of its row, so an sr-only sibling names the account (aria-label on a role-less span is inert) and the visible text is hidden from the accessibility tree.
  const tone = 'negative' as const;
  const label = 'On hold';
  const description = `${name}: required-withdrawal estimate on hold`;
  return (
    <>
      <span className="sr-only">{description}</span>
      <span aria-hidden="true">
        <Badge tone={tone}>{label}</Badge>
      </span>
    </>
  );
};

function ownerDisplay(
  payload: AccountPayload,
  members: Map<string, HouseholdMemberPayload>,
): string {
  if (payload.ownershipType === 'JOINT') return 'Joint';
  const m = members.get(payload.ownerId);
  if (!m) return '—';
  return m.firstName?.trim() || 'Member';
}
