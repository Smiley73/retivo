/**
 * Household management page.
 *
 * Reads `householdMembers` from IndexedDB; mutations flow through
 * `queueLocalMutation` and the SyncProvider's polling loop. The
 * primary member is added on first visit (no SetupPage anymore);
 * after that the page mirrors the legacy UX: add/edit/remove
 * secondary, double-confirm if accounts attach to the member.
 */
import React, { useMemo, useRef, useState } from 'react';
import { PlusIcon, CheckIcon, PencilIcon, TrashIcon } from '../components/icons';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { useSync } from '../sync/SyncContext';
import { useAggregates } from '../lib/use-aggregates';
import { cryptoUuid } from '../lib/crypto-uuid';
import { formatDate } from '../lib/format-date';
import { validateBirthdate } from '../lib/birthdate-validation';
import { queueLocalMutation } from '../sync/mutation-queue';
import { Alert } from '../components/Alert';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { Muted } from '../components/Muted';
import { MemberDetailsForm, btnPrimarySmClass, btnDangerSmClass } from './profile-page-chrome';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';

interface HouseholdMemberView {
  id: string;
  version: number;
  isPrimary: boolean;
  firstName: string;
  lastName: string;
  email: string;
  birthdate: string;
  accountCount: number;
}

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  email: '',
  birthdate: '',
};

export const HouseholdPage: React.FC = () => {
  const { householdId, me } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  // Reactive reads: members + accounts re-read on any write to their store
  // (single edits via the fine signal, bulk fills via the coarse workspace
  // event). The add/edit drafts are seeded in click handlers, never from a
  // load effect, so auto-re-read never clobbers an in-progress member edit.
  const memberQuery = useAggregates('householdMember');
  const accountQuery = useAggregates('account');
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  // Stable baseline captured when the edit opens, compared against `editForm`
  // for the dirty guard. Reading `members.find(editingId)` here would let a
  // background fine-signal re-read (a sync writing the editing member to the
  // user's draft values) silently flip the guard off; the captured snapshot
  // keeps the unsaved draft protected regardless of reactive re-reads. This is
  // why the page is exempt from the form-page rule against reactive reads
  // despite holding `useUnsavedChangesGuard`: the load effect never
  // seeded the edit draft/baseline, and the dirty-guard baseline is separately
  // ref-captured at `onStartEdit`, so an auto-re-read can never clobber it.
  const editBaselineRef = useRef<HouseholdMemberView | null>(null);

  const loading = !memberQuery.ready || !accountQuery.ready;

  // Join members to their owned-account counts. Derived from the reactive
  // hook outputs so the cards refresh after an add/edit/delete or a bulk
  // fill without a manual reload.
  const members = useMemo<HouseholdMemberView[]>(() => {
    const counts = new Map<string, number>();
    for (const a of accountQuery.aggregates as Aggregate<AccountPayload>[]) {
      const ownerId = a.payload.ownerId;
      if (ownerId) counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
    }
    return (memberQuery.aggregates as Aggregate<HouseholdMemberPayload>[]).map(
      (m) => ({
        id: m.id,
        version: m.version,
        isPrimary: !!m.payload.isPrimary,
        firstName: m.payload.firstName ?? '',
        lastName: m.payload.lastName ?? '',
        email: m.payload.email ?? '',
        birthdate: m.payload.birthdate ?? '',
        accountCount: counts.get(m.id) ?? 0,
      }),
    );
  }, [memberQuery.aggregates, accountQuery.aggregates]);

  const isDirty = useMemo(() => {
    const addDirty =
      form.firstName !== '' ||
      form.lastName !== '' ||
      form.email !== '' ||
      form.birthdate !== '';
    const baseline = editingId ? editBaselineRef.current : null;
    const editDirty = baseline
      ? editForm.firstName !== baseline.firstName ||
        editForm.lastName !== baseline.lastName ||
        editForm.email !== baseline.email ||
        editForm.birthdate !== baseline.birthdate
      : false;
    return addDirty || editDirty;
  }, [form, editForm, editingId]);

  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const onAddPrimary = async () => {
    if (!householdId || !me) return;
    const birthdateError = validateBirthdate(form.birthdate);
    if (birthdateError) {
      setError(birthdateError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await queueLocalMutation<HouseholdMemberPayload>({
        type: 'householdMember',
        aggregateId: cryptoUuid(),
        householdId,
        operation: 'create',
        expectedVersion: 0,
        payload: {
          isPrimary: true,
          firstName: form.firstName || me.email.split('@')[0],
          lastName: form.lastName,
          email: form.email || me.email,
          birthdate: form.birthdate,
        },
      });
      setForm(EMPTY_FORM);
      notifyPending();
    } catch {
      setError('Failed to add primary member.');
    } finally {
      setSubmitting(false);
    }
  };

  const onAddSecondary = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!householdId) return;
    const birthdateError = validateBirthdate(form.birthdate);
    if (birthdateError) {
      setError(birthdateError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await queueLocalMutation<HouseholdMemberPayload>({
        type: 'householdMember',
        aggregateId: cryptoUuid(),
        householdId,
        operation: 'create',
        expectedVersion: 0,
        payload: {
          isPrimary: false,
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          birthdate: form.birthdate,
        },
      });
      setForm(EMPTY_FORM);
      notifyPending();
    } catch {
      setError('Failed to add member.');
    } finally {
      setSubmitting(false);
    }
  };

  const onStartEdit = (member: HouseholdMemberView) => {
    editBaselineRef.current = member;
    setEditingId(member.id);
    setEditForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      birthdate: member.birthdate,
    });
  };

  const onCancelEdit = () => {
    editBaselineRef.current = null;
    setEditingId(null);
    setEditForm(EMPTY_FORM);
  };

  const onSaveEdit = async (memberId: string) => {
    if (!householdId) return;
    const target = members.find((m) => m.id === memberId);
    if (!target) return;
    const birthdateError = validateBirthdate(editForm.birthdate);
    if (birthdateError) {
      setError(birthdateError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await queueLocalMutation<HouseholdMemberPayload>({
        type: 'householdMember',
        aggregateId: memberId,
        householdId,
        operation: 'update',
        expectedVersion: target.version,
        payload: {
          isPrimary: target.isPrimary,
          firstName: editForm.firstName,
          lastName: editForm.lastName,
          email: editForm.email,
          birthdate: editForm.birthdate,
        },
      });
      onCancelEdit();
      notifyPending();
    } catch {
      setError('Failed to update member.');
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (memberId: string, name: string, accountCount: number) => {
    if (!householdId) return;
    const target = members.find((m) => m.id === memberId);
    if (!target) return;
    if (accountCount > 0) {
      const ok1 = await confirm(
        `Delete "${name}"?`,
        `This member owns ${accountCount} account(s) that will also need to be reassigned or removed.`,
        { confirmLabel: 'Delete', cancelLabel: 'Cancel' },
      );
      if (!ok1) return;
      const ok2 = await confirm('Are you sure?', 'This action cannot be undone.', {
        confirmLabel: 'Yes, delete',
        cancelLabel: 'Cancel',
      });
      if (!ok2) return;
    } else {
      const ok = await confirm(`Delete "${name}"?`, 'This action cannot be undone.');
      if (!ok) return;
    }
    setError(null);
    try {
      await queueLocalMutation<HouseholdMemberPayload>({
        type: 'householdMember',
        aggregateId: memberId,
        householdId,
        operation: 'delete',
        expectedVersion: target.version,
        payload: {
          isPrimary: target.isPrimary,
          firstName: target.firstName,
          lastName: target.lastName,
          email: target.email,
          birthdate: target.birthdate,
        },
      });
      notifyPending();
    } catch {
      setError('Failed to delete member.');
    }
  };

  if (loading)
    return (
      <section aria-labelledby="household-heading">
        <PageHeader
          title={<span id="household-heading">Household</span>}
          subtitle="Manage your household members. Assets and plans are shared within the household."
        />
        <Card>
          <p className="m-0 text-sm text-muted" role="status" aria-busy="true">
            Loading your household…
          </p>
        </Card>
      </section>
    );

  const primary = members.find((m) => m.isPrimary);
  const secondary = members.find((m) => !m.isPrimary);
  const loadError =
    memberQuery.error || accountQuery.error
      ? 'Failed to load household members.'
      : null;
  const displayError = error ?? loadError;

  return (
    <section aria-labelledby="household-heading">
      <PageHeader
        title={<span id="household-heading">Household</span>}
        subtitle="Manage your household members. Assets and plans are shared within the household."
      />

      {displayError && <Alert tone="error">{displayError}</Alert>}

      <Muted as="p" className="mb-4 text-sm">
        Only add a second member if they are your legal spouse. Unmarried
        partners must use separate plans.
      </Muted>

      {!primary ? (
        // First run: the "add yourself as primary" card stays full-width
        // above the (not-yet-rendered) member grid.
        <Card>
          <h2 className="m-0 mb-2 text-lg font-semibold text-ink">
            Welcome! Add yourself as the primary member
          </h2>
          <Muted as="p" className="mb-3 text-sm">
            We pre-filled your email from your account; fill in the rest to get started.
          </Muted>
          <MemberDetailsForm
            idPrefix="primary"
            values={{ ...form, email: form.email || me?.email || '' }}
            onChange={setForm}
            onSubmit={(e) => {
              e.preventDefault();
              onAddPrimary();
            }}
            submitting={submitting}
            submitLabel="Save primary member"
            submitIcon={<CheckIcon />}
            submittingLabel="Saving…"
          />
        </Card>
      ) : (
        // The primary + secondary (or add-member fallback) member cards share
        // the Graphite Spectrum two-column member grid (`.dash-2`).
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {memberCard(primary, {
            editingId,
            editForm,
            submitting,
            setEditForm,
            onStartEdit,
            onCancelEdit,
            onSaveEdit,
            onRemove,
          })}
          {secondary ? (
            memberCard(secondary, {
              editingId,
              editForm,
              submitting,
              setEditForm,
              onStartEdit,
              onCancelEdit,
              onSaveEdit,
              onRemove,
            })
          ) : (
            <Card>
              <h2 className="m-0 mb-3 text-lg font-semibold text-ink">
                Add your spouse
              </h2>
              <MemberDetailsForm
                idPrefix="secondary"
                values={form}
                onChange={setForm}
                onSubmit={onAddSecondary}
                submitting={submitting}
                submitLabel="Add spouse"
                submitIcon={<PlusIcon />}
                submittingLabel="Adding…"
              />
            </Card>
          )}
        </div>
      )}
      {pendingNavModal}
      {dialog}
    </section>
  );
};

interface CardActions {
  editingId: string | null;
  editForm: typeof EMPTY_FORM;
  submitting: boolean;
  setEditForm: (next: typeof EMPTY_FORM) => void;
  onStartEdit: (m: HouseholdMemberView) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string) => void;
  onRemove: (id: string, name: string, accountCount: number) => void;
}

function memberCard(member: HouseholdMemberView, actions: CardActions): React.ReactElement {
  const {
    editingId,
    editForm,
    submitting,
    setEditForm,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onRemove,
  } = actions;
  const isEditing = editingId === member.id;
  return (
    <Card>
      <h2 className="m-0 mb-3 text-lg font-semibold text-ink">
        {member.isPrimary ? 'Primary member (you)' : 'Spouse'}
      </h2>
      {isEditing ? (
        <MemberDetailsForm
          idPrefix={`edit-${member.id}`}
          values={editForm}
          onChange={setEditForm}
          onSubmit={(e) => {
            e.preventDefault();
            onSaveEdit(member.id);
          }}
          submitting={submitting}
          submitLabel="Update"
          submitIcon={<CheckIcon />}
          submittingLabel="Saving…"
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <p className="m-0 text-sm text-ink">
            <strong>{member.firstName}</strong>
          </p>
          <Muted as="p" className="mt-1 mb-3 text-sm">
            {member.email} ·{' '}
            {member.birthdate
              ? `Born ${formatDate(member.birthdate)}`
              : 'Birth date not set'}
          </Muted>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${btnPrimarySmClass} gap-1.5`}
              onClick={() => onStartEdit(member)}
            >
              <PencilIcon />
              Edit
            </button>
            {!member.isPrimary && (
              <button
                type="button"
                className={`${btnDangerSmClass} gap-1.5`}
                onClick={() =>
                  onRemove(
                    member.id,
                    member.firstName,
                    member.accountCount,
                  )
                }
              >
                <TrashIcon />
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

