/** Social Security inputs: one row per adult member with PIA and the derived benefit at 62, FRA and 70 (lib/ssa-formulas.ts). The aggregate id is deterministic (ss-<householdMemberId>), so the version condition enforces one record per member. */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useDirtyModalClose, useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { useSync } from '../sync/SyncContext';
import { getAggregate } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useAggregates } from '../lib/use-aggregates';
import {
  REFERENCE_AGE_MONTHS,
  fraMonthsForBirthdate,
  monthlyBenefitAtAge,
  InvalidBirthYearError,
} from '../lib/ssa-formulas';
import { Alert } from '../components/Alert';
import { Card } from '../components/Card';
import { LoadingState } from '../components/Skeleton';
import { PageHeader } from '../components/PageHeader';
import {
  SocialSecurityBenefitModal,
  type SocialSecurityEditState,
} from './SocialSecurityBenefitModal';
import { SocialSecurityTable } from './SocialSecurityTable';
import type {
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

interface MemberView {
  id: string;
  isPrimary: boolean;
  firstName: string;
  lastName: string;
  birthdate: string;
}

interface BenefitView {
  id: string;
  version: number;
  householdMemberId: string;
  memberDisplayName: string;
  pia: number | null;
  piaAsOfDate: string | null;
  notes: string | null;
  fraMonths: number;
  monthlyBenefitAt62: number | null;
  monthlyBenefitAtFra: number | null;
  monthlyBenefitAt70: number | null;
}

const EMPTY_EDIT: SocialSecurityEditState = { pia: null, piaAsOfDate: '', notes: '' };

const adultsOnly = (members: MemberView[]): MemberView[] => {
  const cutoff = Date.now() - 18 * 365.25 * 24 * 60 * 60 * 1000;
  return members.filter((m) => {
    if (!m.birthdate) return false;
    const t = new Date(m.birthdate).getTime();
    return Number.isFinite(t) && t <= cutoff;
  });
};

function benefitAggregateId(memberId: string): string {
  return `ss-${memberId}`;
}


export const SocialSecurityPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  // The benefit modal's draft is seeded only in openModal, never from a derivation, so an auto-re-read can't clobber an in-progress edit.
  const memberQuery = useAggregates('householdMember');
  const benefitQuery = useAggregates('socialSecurityBenefit');
  const ready = memberQuery.ready && benefitQuery.ready;
  const loadError =
    memberQuery.error || benefitQuery.error
      ? 'Failed to load Social Security data'
      : null;
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMemberId, setModalMemberId] = useState<string | null>(null);
  const [modalBenefit, setModalBenefit] = useState<BenefitView | null>(null);
  const [editState, setEditState] = useState<SocialSecurityEditState>(EMPTY_EDIT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editBaselineRef = useRef<SocialSecurityEditState>(EMPTY_EDIT);

  const isFormDirty = useMemo(() => {
    if (!modalOpen) return false;
    const b = editBaselineRef.current;
    return (
      editState.pia !== b.pia ||
      editState.piaAsOfDate !== b.piaAsOfDate ||
      editState.notes !== b.notes
    );
  }, [modalOpen, editState]);

  const members = useMemo<MemberView[]>(() => {
    const memberRows = memberQuery.aggregates as ReadonlyArray<
      Aggregate<HouseholdMemberPayload>
    >;
    const memberViews: MemberView[] = memberRows.map((m) => ({
      id: m.id,
      isPrimary: !!m.payload.isPrimary,
      firstName: m.payload.firstName ?? '',
      lastName: m.payload.lastName ?? '',
      birthdate: m.payload.birthdate ?? '',
    }));
    memberViews.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    return memberViews;
  }, [memberQuery.aggregates]);

  const benefits = useMemo<BenefitView[]>(() => {
    const benefitRows = benefitQuery.aggregates as ReadonlyArray<
      Aggregate<SocialSecurityBenefitPayload>
    >;
    const memberById = new Map<string, MemberView>();
    for (const m of members) memberById.set(m.id, m);
    return benefitRows.flatMap((b) => {
      const member = memberById.get(b.payload.householdMemberId);
      if (!member) return [];
      let fraMonths: number;
      try {
        if (!member.birthdate) return [];
        // Route through fraMonthsForBirthdate so SSA day-1 rule is applied.
        fraMonths = fraMonthsForBirthdate(member.birthdate);
      } catch (e) {
        if (e instanceof InvalidBirthYearError) return [];
        throw e;
      }
      const pia = b.payload.pia;
      const compute = (claimMonths: number) =>
        pia === null ? null : monthlyBenefitAtAge(pia, fraMonths, claimMonths);
      return [
        {
          id: b.id,
          version: b.version,
          householdMemberId: b.payload.householdMemberId,
          memberDisplayName: member.firstName?.trim() || 'Member',
          pia,
          piaAsOfDate: b.payload.piaAsOfDate,
          notes: b.payload.notes,
          fraMonths,
          monthlyBenefitAt62: compute(REFERENCE_AGE_MONTHS.AT_62),
          monthlyBenefitAtFra: compute(fraMonths),
          monthlyBenefitAt70: compute(REFERENCE_AGE_MONTHS.AT_70),
        },
      ];
    });
  }, [benefitQuery.aggregates, members]);

  const error = loadError ?? deleteError;

  const openModal = (memberId: string, existing: BenefitView | undefined) => {
    setModalMemberId(memberId);
    setModalBenefit(existing ?? null);
    const initial: SocialSecurityEditState = existing
      ? {
          pia: existing.pia,
          piaAsOfDate: existing.piaAsOfDate ?? '',
          notes: existing.notes ?? '',
        }
      : EMPTY_EDIT;
    setEditState(initial);
    editBaselineRef.current = initial;
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = useCallback(() => {
    if (saving) return;
    setModalOpen(false);
    setModalMemberId(null);
    setModalBenefit(null);
    setEditState(EMPTY_EDIT);
    setFormError(null);
  }, [saving]);

  const { guardedClose, immediateClose, confirmModal: closeConfirmModal } = useDirtyModalClose(
    isFormDirty,
    closeModal,
  );
  const { pendingNavModal } = useUnsavedChangesGuard(isFormDirty);

  const handleSave = async () => {
    if (!modalMemberId || !householdId) return;
    // The statement date is the engine's COLA anchor: a future date makes year − anchorYear negative and deflates near-term benefits, so reject it inline (no silent clamp); this guards previously stored or hand-synced future dates.
    const todayIso = new Date().toISOString().slice(0, 10);
    const asOf = editState.piaAsOfDate.trim();
    if (asOf && asOf.slice(0, 10) > todayIso) {
      setFormError('"Date on the SSA statement" can\'t be in the future.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const aggId = benefitAggregateId(modalMemberId);
      const existing = (await getAggregate(
        'socialSecurityBenefit',
        aggId,
      )) as Aggregate<SocialSecurityBenefitPayload> | null;
      const payload: SocialSecurityBenefitPayload = {
        householdMemberId: modalMemberId,
        pia: editState.pia,
        piaAsOfDate: editState.piaAsOfDate.trim() === '' ? null : editState.piaAsOfDate,
        notes: editState.notes.trim() === '' ? null : editState.notes,
      };
      await queueLocalMutation<SocialSecurityBenefitPayload>({
        type: 'socialSecurityBenefit',
        aggregateId: aggId,
        householdId,
        operation: existing ? 'update' : 'create',
        expectedVersion: existing ? existing.version : 0,
        payload,
      });
      notifyPending();
      closeModal();
    } catch {
      setFormError('Failed to save record');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (benefit: BenefitView) => {
    if (!householdId) return;
    const ok = await confirm(
      `Delete Social Security info for ${benefit.memberDisplayName}?`,
      'This deletes the stored value. You can re-enter it later.',
      { confirmLabel: 'Delete', cancelLabel: 'Cancel' },
    );
    if (!ok) return;
    setDeleteError(null);
    try {
      await queueLocalMutation<SocialSecurityBenefitPayload>({
        type: 'socialSecurityBenefit',
        aggregateId: benefit.id,
        householdId,
        operation: 'delete',
        expectedVersion: benefit.version,
        payload: {
          householdMemberId: benefit.householdMemberId,
          pia: benefit.pia,
          piaAsOfDate: benefit.piaAsOfDate,
          notes: benefit.notes,
        },
      });
      notifyPending();
    } catch {
      setDeleteError('Failed to delete record');
    }
  };

  if (!ready) return <LoadingState label="Loading your Social Security records…" variant="table" />;

  const adultMembers = adultsOnly(members);

  return (
    <section aria-labelledby="ss-heading">
      <PageHeader
        title={<span id="ss-heading">Social Security</span>}
        subtitle={
          <>
            For each adult household member, enter the monthly Social Security benefit they would
            receive at <strong>full retirement age</strong> (which varies by birth year: age 66 to 67
            for most people born after 1943), in today's dollars. You can find
            this on your most recent SSA statement at{' '}
            <a
              href="https://www.ssa.gov/myaccount"
              target="_blank"
              rel="noopener noreferrer"
              className={textLinkClass}
            >
              ssa.gov/myaccount
            </a>
            . The estimated amounts at ages 62, FRA, and 70 are derived from that value and the
            member's birth year.
          </>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {adultMembers.length === 0 ? (
        <Card>
          <p className="m-0 text-muted">
            No adult household members. Add one from{' '}
            <a
              href="/household"
              className={textLinkClass}
            >
              Household
            </a>
            .
          </p>
        </Card>
      ) : (
        <SocialSecurityTable
          adultMembers={adultMembers}
          benefits={benefits}
          onOpenModal={openModal}
          onRemoveBenefit={handleRemove}
        />
      )}

      <SocialSecurityBenefitModal
        open={modalOpen}
        isEdit={modalBenefit !== null}
        memberName={(() => {
          const member = members.find((m) => m.id === modalMemberId);
          return (
            member?.firstName?.trim() ||
            (member?.isPrimary ? 'Primary' : 'Secondary')
          );
        })()}
        editState={editState}
        setEditState={setEditState}
        formError={formError}
        saving={saving}
        onClose={guardedClose}
        onCancel={immediateClose}
        onSave={handleSave}
      />

      <Card role="note" className="mt-6">
        <p className="m-0 text-xs text-muted">
          <strong className="text-ink">
            What this tool does not model:
          </strong>{' '}
          Divorced-spouse benefits are not modeled. Public-pension offsets (the Windfall
          Elimination Provision and Government Pension Offset) were repealed by the Social
          Security Fairness Act in January 2025, so they no longer apply. Disability benefits are
          not modeled. Child-in-care spouse benefits are not modeled. File-and-suspend / restricted
          application is not modeled. The earnings
          test is applied to part-time earned income before full retirement age; months withheld
          from your own retirement benefit or a spousal benefit are restored at full retirement
          age, but months withheld from a survivor benefit are not restored — that adjustment is
          not currently modeled. The widow/widower benefit cap for an
          early-claiming deceased spouse is applied. For years past the amounts the Social
          Security Administration has published, the earnings-test limits are estimated by
          growing the latest published amounts at the scenario&apos;s inflation rate (rounded to
          the nearest $10, the same rounding the SSA uses) — the SSA actually sets them each fall
          from national wage growth, so future-year limits are approximate. Survivor benefits use
          the separate survivor claim age set on each scenario; when that age is not set,
          projections leave the survivor benefit out until you set it.
        </p>
      </Card>

      {closeConfirmModal}
      {pendingNavModal}
      {dialog}
    </section>
  );
};
