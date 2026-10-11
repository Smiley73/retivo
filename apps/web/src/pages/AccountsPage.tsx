/**
 * Accounts list.
 *
 * Reads `account` + `householdMember` + `accountBalance` aggregates from
 * IndexedDB. Owner display name is derived from the local household-member
 * store; the per-account balance count drives the double-confirm copy on
 * delete. Mutations flow through `queueLocalMutation`.
 */
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

/** Selectable Owner filter values. Combines ownership type (joint)
 *  with member-role (primary / secondary), since "owner" maps to one
 *  of three states in this codebase: JOINT, the primary member, or
 *  the secondary member. */
type OwnerFilter = '' | 'JOINT' | 'PRIMARY' | 'SECONDARY';

export const AccountsPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  // The create/edit form is a modal driven by the URL: `?new` opens it in
  // create mode, `?edit=<id>` in edit mode. Keeping it in the query string
  // (not local state) means the cross-page "Add account" / "Edit account"
  // links from the Dashboard, balances ledger, scenario pages, etc. all
  // deep-link straight into the open modal, and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const { confirm, dialog } = useConfirm();
  // Reactive reads: each store re-reads on any write to its type (single
  // writes via the per-store fine signal, bulk fills via the coarse
  // workspace event), so the list refreshes after a delete, an in-modal
  // save, a sync bootstrap, or a demo fill without a manual reload dep.
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

  // True once every slice has settled its first read — drives the loading
  // skeleton vs. the empty-state distinction.
  const ready = accountQuery.ready && memberQuery.ready && balanceQuery.ready;
  const loadError =
    accountQuery.error || memberQuery.error || balanceQuery.error
      ? 'Failed to load accounts'
      : null;
  const error = loadError ?? deleteError;

  // First-name labels for the Owner dropdown. Resolved from the
  // household-member records so the dropdown reads "Alex" / "Sam"
  // instead of "Primary" / "Secondary" when first names are set
  // (project rule: prefer firstName in user-facing copy; fall back to
  // role label only when the name is missing).
  const primary = members.find((m) => m.payload.isPrimary === true);
  const secondary = members.find((m) => m.payload.isPrimary !== true);
  const primaryFirst = primary?.payload.firstName?.trim() ?? '';
  const secondaryFirst = secondary?.payload.firstName?.trim() ?? '';
  const primaryLabel = primaryFirst.length > 0 ? primaryFirst : 'Primary';
  const secondaryLabel = secondaryFirst.length > 0 ? secondaryFirst : 'Secondary';

  // Join accounts to owner display name, then apply the type / owner
  // filters and sort — derived from the reactive hook outputs.
  // `null` until the first read settles, so the page keeps its loading
  // skeleton on first paint. (Whether an account HAS balance rows is not
  // derived here: `onDelete` decides that from a click-time read, so the
  // page-load snapshot never picks which delete confirmation is shown.)
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
    // Block-on-reference runs first: never prompt to confirm a delete
    // that will be refused. Re-read income + scenarios fresh at
    // click-time (not the page-load snapshot) so a reference added by
    // sync or another tab after render is still caught — mirrors the
    // submit-time disable guard in AccountFormModal. Accounts and balance
    // rows are re-read in the same batch: the Roth-deletion predicate and the
    // balance-data confirmation must see what IS stored at click time — a
    // balance row written by another tab lands in IndexedDB without moving
    // this row's account version or firing a cross-tab signal, so the
    // captured `accounts` / `balances` arrays can be stale.
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
    // A Roth IRA's tax-free figure is derived from the accounts that
    // REMAIN, so deleting one that consumed its owner's pool leaves the household
    // with MORE tax-free money than before. Resolved by running the household's
    // §408A pool both ways over the FULL non-deleted account set (the pool counts
    // inactive accounts too, so the active-only list handed to the form modal
    // must never be used here). An account with no balance rows can never move
    // the figure, so this only ever reaches the two-step branch below.
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
      // The delete tombstone is a `putAggregate('account', …)` write, so the
      // reactive `useAggregates('account')` read re-runs and drops the row —
      // no manual reload bump needed.
    } catch {
      setDeleteError('Failed to delete account');
    }
  };

  // Derive the form-modal state from the query string. `?new` → create
  // mode; `?edit=<id>` → edit that account; neither → closed.
  const editId = searchParams.get('edit');
  const formMode: { accountId: string | null } | null = searchParams.has('new')
    ? { accountId: null }
    : editId
      ? { accountId: editId }
      : null;
  const openCreateForm = () => setSearchParams({ new: '' });
  const closeForm = () => {
    // Drop the modal's query params; preserve nothing else (the page has no
    // other query state). A save writes through `putAggregate`, so the
    // reactive list re-reads on its own — no manual reload bump needed.
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
        // React Aria Table — renders native table markup (role="grid"),
        // gains arrow-key row navigation and the typed Cell / Row /
        // Column primitives. Framed by the canonical
        // TableScroll card; `scroll={false}` because the rows use the
        // hover-revealed `.row-actions` cluster (WebKit stuck-`:hover` bug
        // — see TableScroll).
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
                  {/* The name cell hosts the absolutely-positioned bucket
                      bar, so it must be `relative`. */}
                  <Cell className={`${cell} relative`}>
                    <BucketBar bucket={bucket} />
                    <span className="inline-flex items-center gap-1.5">
                      {r.payload.name}
                      <NotesIndicator notes={r.payload.notes} />
                      {/* Only blocked inherited accounts need list-level attention;
                          accepted safe assumptions are disclosed in the report. */}
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
                      {/* Edit opens the form modal via `?edit=<id>`; the
                          icon carries its accessible name via aria-label
                          (the visible-text equivalent of the old "Edit"
                          button — a11y requirement). A real `<Link>` keeps
                          middle-click / open-in-new-tab working. */}
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

/**
 * The compact tax-detail badge beside an account's name.
 *
 * Rendered only when a legacy/imported inherited account is blocked. Accepted safe
 * assumptions show no badge; the exported report names those defaults precisely.
 */
const TaxDetailsBadge: React.FC<{
  readonly payload: AccountPayload;
  readonly name: string;
  readonly ownerBirthdate?: string;
}> = ({ payload, name, ownerBirthdate }) => {
  const state: TaxProfileCompleteness = taxProfileCompleteness(payload, ownerBirthdate);
  // The badge flags withheld work only, never an accepted safe assumption.
  if (state !== 'blocked') return null;
  // The badge text alone ("On hold") is ambiguous read out of its row, so each badge
  // is paired with a visually-hidden sibling naming the account. `Badge` renders a
  // plain styled `<span>` and forwards no ARIA props. An `aria-label` on a plain
  // wrapper `<span>` would be INERT (ARIA forbids naming a role-less generic), so the
  // account name goes in an `sr-only` sibling — the same pattern `RangeSlider` and
  // `RepoLink` use — and the visible badge text is hidden from the
  // accessibility tree so the row is not read twice.
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
