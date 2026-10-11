/**
 * Annual balance entries for a single account.
 *
 * Reads `account` + `accountBalance` aggregates from IndexedDB; saves
 * via `queueLocalMutation`. Per-row gain/loss + return % are computed
 * client-side via `apps/web/src/lib/balance-calc.ts` (Modified-Dietz,
 * ported verbatim from the legacy server math).
 *
 * Aggregate id for an `accountBalance` is deterministic — `bal-<accountId>-<year>` —
 * so the pre-aggregate version-condition naturally enforces "one row per
 * (account, year)" without a duplicate scan.
 *
 * MIXED accounts split startingBalance / contributions / endingBalance
 * across pre-tax + post-tax columns; non-MIXED use the totals directly.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PlusIcon } from '../components/icons';
import { textLinkClass } from '../components/TextLink';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useDirtyModalClose, useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { parseCurrencyInput } from '../components/MoneyInput';
import { formatCurrencyExact } from '../lib/format-currency';
import { useSync } from '../sync/SyncContext';
import { getAggregateIncludingDeleted } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useAggregates } from '../lib/use-aggregates';
import { deriveAll } from '../lib/balance-calc';
import { showsDesignatedRothFields, showsRothIraFields } from '../lib/account-tax-profile';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { PageHeader } from '../components/PageHeader';
import { BalanceEntryModal } from './AccountBalanceEntryModal';
import { TwrSummary } from './TwrSummary';
import { BalanceTable } from './BalanceTable';

export { parseCurrencyInput };

function getDefaultLastUpdated(year: number): string {
  const currentYear = new Date().getUTCFullYear();
  if (year === currentYear) return new Date().toISOString();
  return `${year}-12-31T23:59:59Z`;
}

export interface BalanceRow extends AccountBalancePayload {
  id: string;
  version: number;
  gainLoss: number;
  returnPct: number;
}

export function findPriorYearEntry(rows: BalanceRow[], year: number): BalanceRow | null {
  const priors = rows.filter((b) => b.year < year);
  if (priors.length === 0) return null;
  return priors.reduce((latest, b) => (b.year > latest.year ? b : latest), priors[0]);
}

function balanceAggregateId(accountId: string, year: number): string {
  return `bal-${accountId}-${year}`;
}

// -- Form state --

interface BalanceFormState {
  year: number;
  lastUpdated: string;
  startingBalance: number;
  startingBalancePreTax: number;
  startingBalancePostTax: number;
  personalContributions: number;
  companyContributions: number;
  contributionsPreTax: number;
  contributionsPostTax: number;
  companyContributionsPreTax: number;
  companyContributionsPostTax: number;
  rollover: number;
  distributions: number;
  endingBalance: number;
  endingBalancePreTax: number;
  endingBalancePostTax: number;
  comment: string;
  rothConversionTaxable: number;
  rothInPlanRolloverTaxable: number;
  rothConversionNontaxable: number;
  rothInPlanRolloverNontaxable: number;
}

const EMPTY_FORM: BalanceFormState = {
  year: new Date().getUTCFullYear(),
  lastUpdated: '',
  startingBalance: 0,
  startingBalancePreTax: 0,
  startingBalancePostTax: 0,
  personalContributions: 0,
  companyContributions: 0,
  contributionsPreTax: 0,
  contributionsPostTax: 0,
  companyContributionsPreTax: 0,
  companyContributionsPostTax: 0,
  rollover: 0,
  distributions: 0,
  endingBalance: 0,
  endingBalancePreTax: 0,
  endingBalancePostTax: 0,
  comment: '',
  rothConversionTaxable: 0,
  rothConversionNontaxable: 0,
  rothInPlanRolloverTaxable: 0,
  rothInPlanRolloverNontaxable: 0,
};

export const AccountBalancesPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  // Reactive reads: the account row + its balance entries re-read on any write
  // to their store — single saves/deletes via the fine signal, bulk fills via
  // the coarse workspace event. The open add/edit modal's draft is seeded only
  // in the click handlers, never from a load effect, so an auto-re-read updates
  // the table without clobbering an in-progress balance entry.
  const accountQuery = useAggregates('account');
  const balanceQuery = useAggregates('accountBalance');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<BalanceFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [originalLastUpdated, setOriginalLastUpdated] = useState<string>('');
  const formBaselineRef = useRef<BalanceFormState>(EMPTY_FORM);

  const ready = accountQuery.ready && balanceQuery.ready;
  const queryError =
    accountQuery.error || balanceQuery.error ? 'Failed to load' : null;

  const account = useMemo<Aggregate<AccountPayload> | null>(() => {
    if (!id) return null;
    return (
      (accountQuery.aggregates as Aggregate<AccountPayload>[]).find(
        (a) => a.id === id,
      ) ?? null
    );
  }, [accountQuery.aggregates, id]);

  // Once the stores have settled: `null` while loading, then the decorated
  // (Modified-Dietz) balance rows for this account, sorted newest-first.
  // A settled read with a missing account surfaces "Account not found".
  const rows = useMemo<BalanceRow[] | null>(() => {
    if (!ready) return null;
    if (!id) return [];
    if (!account) return [];
    return (balanceQuery.aggregates as Aggregate<AccountBalancePayload>[])
      .filter((b) => b.payload.accountId === id)
      .map((b) => {
        const derived = deriveAll(b.payload);
        return {
          ...b.payload,
          id: b.id,
          version: b.version,
          totalContributions: derived.totalContributions,
          gainLoss: derived.gainLoss,
          returnPct: derived.returnPct,
        };
      })
      .sort((a, b) => b.year - a.year);
  }, [ready, id, account, balanceQuery.aggregates]);

  const notFound = ready && id !== undefined && account === null;
  const error = queryError ?? (notFound ? 'Account not found' : null) ?? deleteError;

  const isMixed = account?.payload.taxTreatment === 'MIXED';
  // Roth IRA only: the per-year conversion amounts are §408A tax history, so
  // both the inputs and the persisted keys hang off this one predicate.
  const showsRoth = showsRothIraFields(account?.payload.type ?? '');
  // Employer plans record the same dated fact under a different Code section: an
  // in-plan Roth rollover (§402A) rather than a conversion (§408A). Same shape,
  // same per-year clock, so it hangs off its own predicate the same way.
  const showsRollover = showsDesignatedRothFields(
    account?.payload.type ?? '',
    account?.payload.taxTreatment ?? '',
  );

  const isFormDirty = useMemo(() => {
    if (!showForm) return false;
    const baseline = formBaselineRef.current;
    return (Object.keys(form) as Array<keyof BalanceFormState>).some(
      (k) => form[k] !== baseline[k],
    );
  }, [showForm, form]);

  const closeForm = useCallback(() => setShowForm(false), []);
  const { guardedClose, immediateClose, confirmModal: closeConfirmModal } = useDirtyModalClose(
    isFormDirty,
    closeForm,
  );
  const { pendingNavModal } = useUnsavedChangesGuard(isFormDirty);

  const openAddForm = useCallback(() => {
    if (!rows) return;
    const currentYear = new Date().getUTCFullYear();
    const sorted = [...rows].sort((a, b) => b.year - a.year);
    const latestYear = sorted[0]?.year ?? currentYear - 1;
    const priorEntry = sorted.find((b) => b.year === latestYear);
    const priorEnding = priorEntry?.endingBalance ?? 0;
    const priorEndingPre = priorEntry?.endingBalancePreTax ?? 0;
    const priorEndingPost = priorEntry?.endingBalancePostTax ?? 0;

    const initial: BalanceFormState = {
      year: latestYear + 1,
      lastUpdated: getDefaultLastUpdated(latestYear + 1),
      startingBalance: priorEnding,
      startingBalancePreTax: priorEndingPre,
      startingBalancePostTax: priorEndingPost,
      personalContributions: 0,
      companyContributions: 0,
      contributionsPreTax: 0,
      contributionsPostTax: 0,
      companyContributionsPreTax: 0,
      companyContributionsPostTax: 0,
      rollover: 0,
      distributions: 0,
      endingBalance: priorEnding,
      endingBalancePreTax: priorEndingPre,
      endingBalancePostTax: priorEndingPost,
      comment: '',
      rothConversionTaxable: 0,
      rothConversionNontaxable: 0,
      rothInPlanRolloverTaxable: 0,
      rothInPlanRolloverNontaxable: 0,
    };
    setForm(initial);
    formBaselineRef.current = initial;
    setOriginalLastUpdated(getDefaultLastUpdated(latestYear + 1));
    setFormError(null);
    setShowForm(true);
  }, [rows]);

  const promptStartingBalanceFix = useCallback(
    async (year: number, currentStarting: number): Promise<BalanceRow | null> => {
      if (!rows) return null;
      const prior = findPriorYearEntry(rows, year);
      if (!prior) return null;
      if (prior.endingBalance === currentStarting) return null;
      const ok = await confirm(
        'Fix starting balance?',
        `Previous year (${prior.year}) ended at ${formatCurrencyExact(prior.endingBalance)}, but this year's starting balance is ${formatCurrencyExact(currentStarting)}. Update starting balance to ${formatCurrencyExact(prior.endingBalance)}?`,
        { confirmLabel: 'Yes, fix it', cancelLabel: 'No, keep as-is', destructive: false },
      );
      return ok ? prior : null;
    },
    [rows, confirm],
  );

  const openEditForm = useCallback(
    async (b: BalanceRow) => {
      const company = b.companyContributions ?? 0;
      const initial: BalanceFormState = {
        year: b.year,
        lastUpdated: b.lastUpdated,
        startingBalance: b.startingBalance,
        startingBalancePreTax: b.startingBalancePreTax ?? 0,
        startingBalancePostTax: b.startingBalancePostTax ?? 0,
        personalContributions: b.totalContributions - company,
        companyContributions: company,
        contributionsPreTax: b.contributionsPreTax ?? 0,
        contributionsPostTax: b.contributionsPostTax ?? 0,
        companyContributionsPreTax: b.companyContributionsPreTax ?? 0,
        companyContributionsPostTax: b.companyContributionsPostTax ?? 0,
        rollover: b.rollover,
        distributions: b.distributions ?? 0,
        endingBalance: b.endingBalance,
        endingBalancePreTax: b.endingBalancePreTax ?? 0,
        endingBalancePostTax: b.endingBalancePostTax ?? 0,
        comment: b.comment ?? '',
        rothConversionTaxable: b.rothConversionTaxableAmount ?? 0,
        rothConversionNontaxable: b.rothConversionNontaxableAmount ?? 0,
        rothInPlanRolloverTaxable: b.rothInPlanRolloverTaxableAmount ?? 0,
        rothInPlanRolloverNontaxable: b.rothInPlanRolloverNontaxableAmount ?? 0,
      };
      setForm(initial);
      formBaselineRef.current = initial;
      setOriginalLastUpdated(b.lastUpdated);
      setFormError(null);
      setShowForm(true);

      const fix = await promptStartingBalanceFix(b.year, b.startingBalance);
      if (fix) {
        const fixed: BalanceFormState = {
          ...initial,
          startingBalance: fix.endingBalance,
          startingBalancePreTax: fix.endingBalancePreTax ?? 0,
          startingBalancePostTax: fix.endingBalancePostTax ?? 0,
        };
        setForm(fixed);
        formBaselineRef.current = fixed;
      }
    },
    [promptStartingBalanceFix],
  );

  const buildPayload = useCallback(
    (state: BalanceFormState): AccountBalancePayload => {
      let startingBalance: number;
      let endingBalance: number;
      let totalContributions: number;
      let companyContributions: number;
      if (isMixed) {
        startingBalance = state.startingBalancePreTax + state.startingBalancePostTax;
        endingBalance = state.endingBalancePreTax + state.endingBalancePostTax;
        companyContributions =
          state.companyContributionsPreTax + state.companyContributionsPostTax;
        totalContributions =
          state.contributionsPreTax + state.contributionsPostTax + companyContributions;
      } else {
        startingBalance = state.startingBalance;
        endingBalance = state.endingBalance;
        companyContributions = state.companyContributions;
        totalContributions = state.personalContributions + state.companyContributions;
      }
      return {
        accountId: id ?? '',
        year: state.year,
        lastUpdated: state.lastUpdated,
        startingBalance,
        startingBalancePreTax: isMixed ? state.startingBalancePreTax : null,
        startingBalancePostTax: isMixed ? state.startingBalancePostTax : null,
        contributionsPreTax: isMixed ? state.contributionsPreTax : null,
        contributionsPostTax: isMixed ? state.contributionsPostTax : null,
        companyContributions,
        companyContributionsPreTax: isMixed ? state.companyContributionsPreTax : null,
        companyContributionsPostTax: isMixed ? state.companyContributionsPostTax : null,
        rollover: state.rollover,
        distributions: state.distributions,
        endingBalance,
        endingBalancePreTax: isMixed ? state.endingBalancePreTax : null,
        endingBalancePostTax: isMixed ? state.endingBalancePostTax : null,
        totalContributions,
        comment: state.comment.trim() === '' ? null : state.comment.trim(),
        // Sparse-optional: absent means nothing was recorded, which is a weaker
        // claim than a stored 0. A blank field must therefore omit the key
        // rather than persist a 0 that asserts "no conversion this year".
        //
        // Gated on the account type as well as the value, and deliberately so:
        // the same predicate hides the inputs, so an account retyped away from
        // a Roth IRA would otherwise keep re-persisting amounts the user can no
        // longer see or clear — invisible data no reader could ever justify
        // applying §408A ordering to. Dropping the keys here is what makes the
        // hidden state actually go away on the next save.
        ...(showsRoth && state.rothConversionTaxable > 0
          ? { rothConversionTaxableAmount: state.rothConversionTaxable }
          : {}),
        ...(showsRoth && state.rothConversionNontaxable > 0
          ? { rothConversionNontaxableAmount: state.rothConversionNontaxable }
          : {}),
        ...(showsRollover && state.rothInPlanRolloverTaxable > 0
          ? { rothInPlanRolloverTaxableAmount: state.rothInPlanRolloverTaxable }
          : {}),
        ...(showsRollover && state.rothInPlanRolloverNontaxable > 0
          ? { rothInPlanRolloverNontaxableAmount: state.rothInPlanRolloverNontaxable }
          : {}),
      };
    },
    [id, isMixed, showsRoth, showsRollover],
  );

  const persist = useCallback(
    async (state: BalanceFormState): Promise<void> => {
      if (!id || !householdId) return;
      const aggId = balanceAggregateId(id, state.year);
      // Tombstones count here. `getAggregate` hides a soft-deleted row, so
      // re-adding a year the user had deleted used to resolve to "absent" and
      // queue a `create` at expectedVersion 0 — landing the optimistic local
      // row back at version 1, below the tombstone's own version, so the next
      // edit queued against a version the server never had. Re-adding a year is
      // a revival of that aggregate, which is an update continuing its lineage.
      const existing = (await getAggregateIncludingDeleted(
        'accountBalance',
        aggId,
      )) as Aggregate<AccountBalancePayload> | null;
      const payload = buildPayload(state);
      await queueLocalMutation<AccountBalancePayload>({
        type: 'accountBalance',
        aggregateId: aggId,
        householdId,
        operation: existing ? 'update' : 'create',
        expectedVersion: existing ? existing.version : 0,
        payload,
      });
      notifyPending();
    },
    [id, householdId, buildPayload, notifyPending],
  );

  const handleSave = useCallback(async () => {
    if (!id || !account) return;
    if (!account.payload.active) {
      setFormError('This account is inactive. Reactivate it before editing balances.');
      return;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const asOf = form.lastUpdated ? form.lastUpdated.slice(0, 10) : '';
    if (asOf && asOf > todayIso) {
      setFormError('"Balance as of" can\'t be in the future.');
      return;
    }
    setSaving(true);
    setFormError(null);

    let workingForm = form;
    const fix = await promptStartingBalanceFix(form.year, form.startingBalance);
    if (fix) {
      workingForm = {
        ...form,
        startingBalance: fix.endingBalance,
        startingBalancePreTax: fix.endingBalancePreTax ?? 0,
        startingBalancePostTax: fix.endingBalancePostTax ?? 0,
      };
      setForm(workingForm);
    }

    try {
      await persist(workingForm);
      setShowForm(false);
      // The reactive `useAggregates('accountBalance')` read re-runs on the
      // write's fine signal, so the table refreshes without a manual token.

      const currentYear = new Date().getUTCFullYear();
      if (workingForm.year < currentYear) {
        const expectedDate = `${workingForm.year}-12-31`;
        const actualDate = workingForm.lastUpdated ? workingForm.lastUpdated.slice(0, 10) : '';
        if (actualDate !== expectedDate) {
          const fixDate = await confirm(
            `Set "Balance as of" to December 31, ${workingForm.year}?`,
            'Non-current year entries typically use the last day of the year.',
            { confirmLabel: 'Yes', cancelLabel: 'No', destructive: false },
          );
          if (fixDate) {
            await persist({
              ...workingForm,
              lastUpdated: `${expectedDate}T23:59:59Z`,
            });
          }
        }

        const nextYear = workingForm.year + 1;
        const nextExists = rows?.some((b) => b.year === nextYear);
        if (!nextExists) {
          const addNext = await confirm(
            `Add entry for ${nextYear}?`,
            "Starting balance will be set to this year's ending balance.",
            { confirmLabel: 'Yes', cancelLabel: 'No', destructive: false },
          );
          if (addNext) {
            const next: BalanceFormState = {
              year: nextYear,
              lastUpdated: `${nextYear}-12-31T23:59:59Z`,
              startingBalance: workingForm.endingBalance,
              startingBalancePreTax: workingForm.endingBalancePreTax,
              startingBalancePostTax: workingForm.endingBalancePostTax,
              personalContributions: 0,
              companyContributions: 0,
              contributionsPreTax: 0,
              contributionsPostTax: 0,
              companyContributionsPreTax: 0,
              companyContributionsPostTax: 0,
              rollover: 0,
              distributions: 0,
              endingBalance: workingForm.endingBalance,
              endingBalancePreTax: workingForm.endingBalancePreTax,
              endingBalancePostTax: workingForm.endingBalancePostTax,
              comment: '',
              // Per-year tax facts: a conversion or in-plan rollover belongs to
              // the year it happened in and never carries into the seeded next
              // year.
              rothConversionTaxable: 0,
              rothConversionNontaxable: 0,
              rothInPlanRolloverTaxable: 0,
              rothInPlanRolloverNontaxable: 0,
            };
            setForm(next);
            formBaselineRef.current = next;
            setOriginalLastUpdated(next.lastUpdated);
            setFormError(null);
            setShowForm(true);
            return;
          }
        }
      } else if (workingForm.year === currentYear) {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const actualDate = workingForm.lastUpdated ? workingForm.lastUpdated.slice(0, 10) : '';
        const originalDate = originalLastUpdated ? originalLastUpdated.slice(0, 10) : '';
        if (actualDate === originalDate && actualDate !== todayStr) {
          const updateDate = await confirm(
            `Update "Balance as of" to today (${todayStr})?`,
            "The date hasn't changed from its original value.",
            { confirmLabel: 'Yes', cancelLabel: 'No', destructive: false },
          );
          if (updateDate) {
            await persist({
              ...workingForm,
              lastUpdated: `${todayStr}T23:59:59Z`,
            });
          }
        }
      }
    } catch {
      setFormError('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [
    id,
    account,
    form,
    rows,
    confirm,
    originalLastUpdated,
    persist,
    promptStartingBalanceFix,
  ]);

  const handleDelete = useCallback(
    async (row: BalanceRow) => {
      if (!id || !householdId) return;
      const ok = await confirm(
        `Delete balance entry for ${row.year}?`,
        'This action cannot be undone.',
      );
      if (!ok) return;
      setDeleteError(null);
      try {
        await queueLocalMutation<AccountBalancePayload>({
          type: 'accountBalance',
          aggregateId: row.id,
          householdId,
          operation: 'delete',
          expectedVersion: row.version,
          payload: {
            accountId: row.accountId,
            year: row.year,
            lastUpdated: row.lastUpdated,
            startingBalance: row.startingBalance,
            startingBalancePreTax: row.startingBalancePreTax,
            startingBalancePostTax: row.startingBalancePostTax,
            contributionsPreTax: row.contributionsPreTax,
            contributionsPostTax: row.contributionsPostTax,
            companyContributions: row.companyContributions,
            companyContributionsPreTax: row.companyContributionsPreTax,
            companyContributionsPostTax: row.companyContributionsPostTax,
            rollover: row.rollover,
            distributions: row.distributions,
            endingBalance: row.endingBalance,
            endingBalancePreTax: row.endingBalancePreTax,
            endingBalancePostTax: row.endingBalancePostTax,
            totalContributions: row.totalContributions,
            comment: row.comment,
          },
        });
        notifyPending();
        // The delete tombstone is an `accountBalance` write, so the reactive
        // read re-runs and drops the row — no manual reload token needed.
      } catch {
        setDeleteError('Failed to delete');
      }
    },
    [id, householdId, confirm, notifyPending],
  );

  if (!id) {
    navigate('/accounts');
    return null;
  }

  const ownerDisplay = account ? account.payload.name : 'Account';

  return (
    <section aria-labelledby="balances-heading">
      <PageHeader
        title={
          <span className="block">
            <span className="mb-1 block text-sm text-muted">
              <Link
                to="/account-balances"
                className={textLinkClass}
              >
                Account Balances
              </Link>
              {account && <> / {account.payload.name}</>}
            </span>
            <span id="balances-heading">
              {account
                ? `${account.payload.institution} / ${account.payload.name}`
                : ownerDisplay}{' '}
              Balances
            </span>
          </span>
        }
        action={
          account?.payload.active === true
            ? { label: 'Add Year', onClick: openAddForm }
            : undefined
        }
        actionIcon={<PlusIcon />}
      />

      {account && !account.payload.active && (
        <Alert tone="warning" role="status">
          This account is marked inactive. Reactivate it to edit balances. Toggle it back on in{' '}
          <Link
            to={`/accounts?edit=${id}`}
            className="font-medium underline"
          >
            Edit Account
          </Link>
          .
        </Alert>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {rows === null ? (
        <LoadingState label="Loading balance entries…" variant="table" />
      ) : rows.length === 0 || !account ? (
        <EmptyState
          action={
            account?.payload.active === true ? (
              <button
                type="button"
                className={textLinkClass}
                onClick={openAddForm}
              >
                Add the first year
              </button>
            ) : undefined
          }
        >
          No balance entries yet. Record this account&apos;s end-of-year balance
          for one or more years; the projection uses your most recent figure as
          the starting point and your history to estimate growth.
        </EmptyState>
      ) : (
        <>
          <TwrSummary rows={rows} isMixed={isMixed} />
          <BalanceTable
            rows={rows}
            account={account}
            onEdit={openEditForm}
            onDelete={handleDelete}
          />
        </>
      )}

      <BalanceEntryModal
        open={showForm}
        isEdit={!!rows?.some((b) => b.year === form.year)}
        isMixed={isMixed}
        saving={saving}
        formError={formError}
        form={form}
        setForm={setForm}
        yearLocked={!!rows?.some((b) => b.year === form.year)}
        showRothConversion={showsRoth}
        showRothInPlanRollover={showsRollover}
        onClose={() => {
          if (!saving) guardedClose();
        }}
        onCancel={() => {
          if (!saving) immediateClose();
        }}
        onSave={handleSave}
        getDefaultLastUpdated={getDefaultLastUpdated}
      />

      {closeConfirmModal}
      {pendingNavModal}
      {dialog}
    </section>
  );
};
