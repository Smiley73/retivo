/** /income/new and /income/:id/edit: the kind-aware IncomeStream editor (pension, partTime, oneOff). */
import React, { useEffect, useMemo, useState } from 'react';
import { CheckIcon, XIcon } from '../components/icons';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { safeReturnTo } from '../auth/safe-redirect';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { RangeSlider } from '../components/RangeSlider';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { TextInput } from '../components/TextInput';
import { useSync } from '../sync/SyncContext';
import { listAggregates, getAggregate } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from '../lib/crypto-uuid';
import { saveScenario } from '../lib/scenario-mutations';
import { memberDisplayName } from '../lib/income-format';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { NotesField } from '../components/NotesField';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { Select } from '../components/Select';
import { Muted } from '../components/Muted';
import {
  inputClass,
  breadcrumbNavClass,
  FieldGroup,
} from './scenarios-page-chrome';
import {
  ScheduleStartPicker,
  ScheduleEndPicker,
} from './IncomeSchedulePickers';
import {
  type FormDraft,
  defaultStartFor,
  defaultEndForPartTime,
  validateSchedule,
} from '../lib/income-form-draft';
import type { ScheduleResolveContext } from '../lib/schedule-resolution';
import {
  DEFAULT_INFLATION_PCT,
} from '../db/types';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import {
  resolveIncomeForScenarioSparse,
  normalizeOverrideId,
} from '../lib/income-override-resolution';
import type {
  Aggregate,
  AccountPayload,
  HouseholdMemberPayload,
  HouseholdRole,
  IncomeOverride,
  IncomeStreamKind,
  IncomeStreamPayload,
  JointAndSurvivorPct,
  LifeExpectancyOverride,
  OneOffIncomeSource,
  ScenarioPayload,
} from '../db/types';
import {
  draftFromPayload,
  buildPayload,
  computeIncomeScenarioPatchSave,
  resolveRetirementFacts,
  isEligibleRolloverTarget,
  isEligibleWindfallTarget,
  isBuildError,
} from './income-form-logic';

const emptyDraft = (memberId: string, currentYear: number): FormDraft => ({
  name: '',
  notes: '',
  memberId,
  kind: 'pension',
  payoutType: 'annuity',
  monthlyBenefit: '',
  pensionTracksInflation: true,
  pensionColaPct: '0',
  jointAndSurvivorPct: 50,
  linkedCbpAccountId: '',
  lumpSumAmount: '',
  lumpSumTargetAccountId: '',
  annualAmount: '',
  partTimeTracksInflation: true,
  partTimeColaPct: '0',
  oneOffAmount: '',
  oneOffSource: 'inheritance',
  oneOffTargetAccountId: '',
  start: defaultStartFor('pension', currentYear),
  end: undefined,
  taxable: true,
});

const RETURN_TO_FALLBACK = '/income';

const InlineField: React.FC<{
  htmlFor: string;
  label: React.ReactNode;
  grow?: string;
  children: React.ReactNode;
}> = ({ htmlFor, label, grow = 'flex-1', children }) => (
  <div className={`mb-0 min-w-0 ${grow}`}>
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-ink">
      {label}
    </label>
    {children}
  </div>
);

export const IncomeFormPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const [searchParams] = useSearchParams();
  // Modes: canonical create/edit, scenario-add(-edit) into overrides.income.added[], and scenario-patch
  // (changed keys only into overrides.income.patches[id]); only the canonical modes touch the IncomeStream aggregate.
  const scenarioId = searchParams.get('scenarioId');
  const editLocalId = searchParams.get('editLocalId');
  const scenarioIdParam = !isEdit ? scenarioId : null;

  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [allIncome, setAllIncome] = useState<Aggregate<IncomeStreamPayload>[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [scenarioForAdd, setScenarioForAdd] = useState<Aggregate<ScenarioPayload> | null>(null);
  const [scenarioForPatch, setScenarioForPatch] =
    useState<Aggregate<ScenarioPayload> | null>(null);
  const [openedResolved, setOpenedResolved] = useState<IncomeStreamPayload | null>(null);
  const [editingAddedLocalId, setEditingAddedLocalId] = useState<string | null>(null);
  const [scenarioInflationPct, setScenarioInflationPct] = useState<number>(DEFAULT_INFLATION_PCT);
  const [retirementByMember, setRetirementByMember] = useState<
    Map<string, { year: number; month0: number }>
  >(() => new Map());
  const [lifeExpectancy, setLifeExpectancy] = useState<
    LifeExpectancyOverride | undefined
  >(undefined);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [baseline, setBaseline] = useState<FormDraft | null>(null);
  const [version, setVersion] = useState<number>(0);
  const [aggregateId, setAggregateId] = useState<string>(() => cryptoUuid());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isDirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [draft, baseline]);

  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        // Reset mode state at the start of every load: a stale editingAddedLocalId would make Save replace instead of append.
        if (!cancelled) {
          // Re-enter loading and clear any stale error: otherwise the old form renders during the async reseed and a fast Save writes stale data.
          setLoading(true);
          setError(null);
          setScenarioForAdd(null);
          setScenarioForPatch(null);
          setOpenedResolved(null);
          setEditingAddedLocalId(null);
          setNameError(null);
          // Clear the form data too: a missing editLocalId hits the not-found early return but would leave the old draft non-null, masking the error branch.
          setDraft(null);
          setBaseline(null);
        }
        const [memberRows, accountRows, scenarioRows, incomeRows] = await Promise.all([
          listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
          listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
          listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
          listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
        ]);
        if (cancelled) return;
        setMembers(memberRows);
        setAllIncome(incomeRows);
        setScenarios(scenarioRows as ScenarioAggregate[]);
        const baseScenario = scenarioRows.find(
          (s) => !s.payload.parentScenarioId,
        ) ?? scenarioRows[0];
        if (baseScenario) {
          setScenarioInflationPct(
            baseScenario.payload.overrides.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
          );
        }
        const baseFacts = resolveRetirementFacts(baseScenario, scenarioRows, memberRows);
        if (!cancelled) {
          setRetirementByMember(baseFacts.retirementByMember);
          setLifeExpectancy(baseFacts.lifeExpectancy);
        }
        setAccounts(
          accountRows
            .filter((a) => a.payload.active)
            .sort((a, b) =>
              accountOptionLabel(a, memberRows).localeCompare(
                accountOptionLabel(b, memberRows),
                undefined,
                { sensitivity: 'base' },
              ),
            ),
        );
        const primary = memberRows.find((m) => m.payload.isPrimary) ?? memberRows[0];
        const fallback = emptyDraft(primary?.id ?? '', new Date().getFullYear());
        if (isEdit && id) {
          const existing = (await getAggregate('incomeStream', id)) as Aggregate<IncomeStreamPayload> | null;
          if (!existing) {
            if (!cancelled) setError(`Income source ${id} not found.`);
            return;
          }
          // Scenario-patch mode opens on the scenario-resolved stream; Save stores only keys changed against it.
          let seedPayload = existing.payload;
          if (scenarioId) {
            const sc = (await getAggregate(
              'scenario',
              scenarioId,
            )) as Aggregate<ScenarioPayload> | null;
            if (!sc) {
              if (!cancelled) setError('Scenario not found.');
              return;
            }
            const resolved = resolveIncomeForScenarioSparse(
              scenarioId,
              scenarioRows as ScenarioAggregate[],
              [existing],
            );
            const match = resolved.find(
              (r) => r.id === normalizeOverrideId(existing.id),
            );
            if (match) seedPayload = match.payload;
            if (!cancelled) {
              setScenarioForPatch(sc);
              setOpenedResolved(seedPayload);
              setScenarioInflationPct(
                resolveScenario(sc.id, scenarioRows as ScenarioAggregate[]).inflation
                  ?.ratePct ?? DEFAULT_INFLATION_PCT,
              );
              const pFacts = resolveRetirementFacts(sc, scenarioRows, memberRows);
              setRetirementByMember(pFacts.retirementByMember);
              setLifeExpectancy(pFacts.lifeExpectancy);
            }
          }
          if (!cancelled) {
            setAggregateId(existing.id);
            setVersion(existing.version);
            const next = draftFromPayload(seedPayload, fallback);
            setDraft(next);
            setBaseline(next);
          }
        } else if (!cancelled) {
          if (scenarioIdParam) {
            const sc = (await getAggregate(
              'scenario',
              scenarioIdParam,
            )) as Aggregate<ScenarioPayload> | null;
            if (!sc) {
              if (!cancelled) setError('Scenario not found.');
              return;
            }
            setScenarioForAdd(sc);
            // Walk the parent chain via resolveScenario so a child without a local inflation override inherits from its parent.
            setScenarioInflationPct(
              resolveScenario(sc.id, scenarioRows as ScenarioAggregate[]).inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
            );
            const scFacts = resolveRetirementFacts(sc, scenarioRows, memberRows);
            if (!cancelled) {
              setRetirementByMember(scFacts.retirementByMember);
              setLifeExpectancy(scFacts.lifeExpectancy);
            }
            // A missing entry is a hard error: falling back to an append would orphan the row.
            if (editLocalId) {
              const entry = (sc.payload.overrides.income?.added ?? []).find(
                (a) => a._localId === editLocalId,
              );
              if (!entry) {
                if (!cancelled) setError('Scenario-only income source not found.');
                return;
              }
              const { _localId: _drop, ...payload } = entry;
              void _drop;
              if (!cancelled) {
                setEditingAddedLocalId(editLocalId);
                const next = draftFromPayload(payload as IncomeStreamPayload, fallback);
                setDraft(next);
                setBaseline(next);
              }
              return;
            }
          }
          // Create-mode URL prefill for the CbpRemediationBanner deep link; unknown params are ignored.
          const prefilled: FormDraft = { ...fallback };
          const qpKind = searchParams.get('kind');
          if (qpKind === 'pension' || qpKind === 'partTime' || qpKind === 'oneOff') {
            prefilled.kind = qpKind;
          }
          const qpPayout = searchParams.get('payoutType');
          if (qpPayout === 'annuity' || qpPayout === 'lumpSum') {
            prefilled.payoutType = qpPayout;
          }
          const qpLinkedCbp =
            searchParams.get('linkedCbpAccountId') ?? searchParams.get('sourceAccountId');
          if (qpLinkedCbp && accountRows.some((a) => a.id === qpLinkedCbp)) {
            prefilled.linkedCbpAccountId = qpLinkedCbp;
          }
          const qpMember = searchParams.get('memberId');
          if (qpMember && memberRows.some((m) => m.id === qpMember)) {
            prefilled.memberId = qpMember;
          }
          setDraft(prefilled);
          setBaseline(prefilled);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, isEdit, scenarioId, scenarioIdParam, editLocalId]);

  const validateName = (candidate: string): string | null => {
    const norm = candidate.trim().toLowerCase();
    if (!norm) return 'Name is required.';
    if (norm.length > 60) return 'Max 60 characters.';
    if (scenarioForAdd) {
      const added = scenarioForAdd.payload.overrides.income?.added ?? [];
      const dupInAdded = added.some(
        (a) =>
          a._localId !== editingAddedLocalId &&
          a.name.trim().toLowerCase() === norm,
      );
      if (dupInAdded) {
        return `This scenario already has an income source named "${candidate.trim()}".`;
      }
      return null;
    }
    if (scenarioForPatch) {
      const resolved = resolveIncomeForScenarioSparse(
        scenarioForPatch.id,
        scenarios,
        allIncome,
      );
      const dup = resolved.some(
        (r) =>
          r.id !== `aggregate:${aggregateId}` &&
          (r.payload.name ?? '').trim().toLowerCase() === norm,
      );
      if (dup) {
        return `This scenario already has an income source named "${candidate.trim()}".`;
      }
      return null;
    }
    const collides = allIncome.some(
      (s) =>
        s.id !== aggregateId &&
        (s.payload.name ?? '').trim().toLowerCase() === norm,
    );
    if (collides) return `An income source named "${candidate.trim()}" already exists.`;
    return null;
  };

  const onSave = async (): Promise<void> => {
    if (!draft || !householdId) return;
    setSubmitting(true);
    setError(null);
    const nameProblem = validateName(draft.name);
    setNameError(nameProblem);
    if (nameProblem) {
      setSubmitting(false);
      return;
    }
    const built = buildPayload(draft, accounts);
    if (isBuildError(built)) {
      setError(built.__error);
      setSubmitting(false);
      return;
    }
    // Reject an end on or before the start (partTime only, the one kind with an end).
    if (draft.kind === 'partTime' && draft.end) {
      const ownerMember = members.find((m) => m.id === draft.memberId);
      const primaryMember = members.find((m) => m.payload.isPrimary);
      const secondaryMember = members.find((m) => !m.payload.isPrimary);
      const ret = retirementByMember.get(draft.memberId);
      const ctx: ScheduleResolveContext = {
        retirementYear: ret?.year ?? NaN,
        retirementMonth0: ret?.month0 ?? 0,
        primary: primaryMember?.payload.birthdate
          ? { birthdate: primaryMember.payload.birthdate }
          : undefined,
        secondary: secondaryMember?.payload.birthdate
          ? { birthdate: secondaryMember.payload.birthdate }
          : undefined,
        owner: ownerMember?.payload.isPrimary ? 'primary' : 'secondary',
        lifeExpectancy,
      };
      const scheduleErr = validateSchedule(draft.start, draft.end, ctx);
      if (scheduleErr) {
        setError(scheduleErr);
        setSubmitting(false);
        return;
      }
    }
    try {
      if (scenarioForPatch) {
        const nextScenarioPayload = computeIncomeScenarioPatchSave(
          scenarioForPatch.payload,
          built,
          openedResolved ?? built,
          normalizeOverrideId(aggregateId),
          aggregateId,
        );
        await saveScenario({
          scenario: scenarioForPatch,
          payload: nextScenarioPayload,
          householdId,
        });
      } else if (scenarioForAdd) {
        // Add-edit replaces the entry in place, keeping its _localId; plain add appends.
        const existingOverrides: IncomeOverride =
          scenarioForAdd.payload.overrides.income ?? {};
        const existingAdded = existingOverrides.added ?? [];
        const nextAdded = editingAddedLocalId
          ? existingAdded.map((a) =>
              a._localId === editingAddedLocalId
                ? { ...built, _localId: editingAddedLocalId }
                : a,
            )
          : [...existingAdded, { ...built, _localId: cryptoUuid() }];
        const nextOverrides: IncomeOverride = {
          ...existingOverrides,
          added: nextAdded,
        };
        const nextScenarioPayload: ScenarioPayload = {
          ...scenarioForAdd.payload,
          overrides: {
            ...scenarioForAdd.payload.overrides,
            income: nextOverrides,
          },
        };
        await saveScenario({
          scenario: scenarioForAdd,
          payload: nextScenarioPayload,
          householdId,
        });
      } else {
        await queueLocalMutation<IncomeStreamPayload>({
          type: 'incomeStream',
          aggregateId,
          householdId,
          operation: isEdit ? 'update' : 'create',
          expectedVersion: isEdit ? version : 0,
          payload: built,
        });
      }
      notifyPending();
      setBaseline(draft);
      // navigateUnguarded: setBaseline is async, so isDirty is still true and a bare navigate() would hit the patched pushState guard.
      const returnTo = searchParams.get('returnTo');
      navigateUnguarded(safeReturnTo(returnTo, RETURN_TO_FALLBACK));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const returnToParam = searchParams.get('returnTo');
  const backHref = safeReturnTo(returnToParam, RETURN_TO_FALLBACK);

  const headerTitle = isEdit
    ? 'Edit income source'
    : scenarioForAdd
      ? editingAddedLocalId
        ? 'Edit scenario-only income source'
        : 'Add scenario-only income source'
      : 'Add income source';

  if (!draft && error) {
    return (
      <section aria-labelledby="income-form-heading">
        <PageHeader title={<span id="income-form-heading">{headerTitle}</span>} />
        <Alert tone="error">{error}</Alert>
      </section>
    );
  }
  if (loading || !draft) {
    return (
      <section aria-labelledby="income-form-heading">
        <PageHeader title={<span id="income-form-heading">{headerTitle}</span>} />
        <LoadingState label="Loading income source…" variant="form" />
      </section>
    );
  }

  const startLabel =
    (draft.kind === 'pension' && draft.payoutType === 'lumpSum') ||
    draft.kind === 'oneOff'
      ? 'Received at'
      : 'Start';

  // The owner's role drives the bridge's owner-implicit age.memberId policy; no owner yet means primary.
  const ownerMember = members.find((m) => m.id === draft.memberId);
  const ownerRole: HouseholdRole =
    ownerMember && !ownerMember.payload.isPrimary ? 'secondary' : 'primary';

  return (
    <section aria-labelledby="income-form-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={backHref}>← Back</Link>
      </nav>
      <PageHeader
        title={<span id="income-form-heading">{headerTitle}</span>}
        subtitle={
          scenarioForAdd ? (
            <>
              Scenario: <strong>{scenarioForAdd.payload.name}</strong>
            </>
          ) : scenarioForPatch ? (
            <>
              Overriding in scenario:{' '}
              <strong>{scenarioForPatch.payload.name}</strong>. Only the fields
              you change will override the scenario.
            </>
          ) : undefined
        }
        action={{
          label: submitting ? 'Saving…' : 'Save',
          onClick: onSave,
          disabled: submitting,
        }}
        actionIcon={<CheckIcon />}
        secondaryActions={[
          {
            label: 'Cancel',
            icon: <XIcon />,
            onClick: () => navigateUnguarded(backHref),
            tone: 'neutral',
          },
        ]}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <div className="mb-4 flex flex-col gap-6 rounded-md border border-line bg-surface-raised p-4">
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field htmlFor="income-name" label="Name" error={nameError}>
            <TextInput
              id="income-name"
              type="text"
              maxLength={60}
              value={draft.name}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
                setNameError(null);
              }}
              onBlur={(e) => setNameError(validateName(e.target.value))}
              className={inputClass}
            />
          </Field>

          <Field htmlFor="income-owner" label="Owner">
            <Select
              id="income-owner"
              ariaLabel="Owner"
              value={draft.memberId}
              onChange={(v) => setDraft({ ...draft, memberId: v })}
              options={members.map((m) => ({
                value: m.id,
                label: memberDisplayName(m),
              }))}
            />
          </Field>

          <NotesField
            id="income-notes"
            label="Notes (optional)"
            value={draft.notes}
            onChange={(v) => setDraft({ ...draft, notes: v })}
            rows={2}
            maxLength={200}
            className="sm:col-span-2"
          />
        </div>

        <FieldGroup id="income-kind-legend" legend="Kind">
          <SegmentedRadioGroup<IncomeStreamKind>
            ariaLabel="Kind"
            value={draft.kind}
            onChange={(k) => {
              // Reset start/end on a kind switch: defaults differ per kind and a non-applicable shape confuses the picker.
              const currentYear = new Date().getFullYear();
              setDraft({
                ...draft,
                kind: k,
                start: defaultStartFor(k, currentYear),
                end: k === 'partTime' ? defaultEndForPartTime() : undefined,
              });
            }}
            options={[
              { value: 'pension', label: 'Pension' },
              { value: 'partTime', label: 'Part-time / earned income' },
              { value: 'oneOff', label: 'One-off / windfall' },
            ]}
          />
        </FieldGroup>

        {draft.kind === 'pension' && (
          <FieldGroup id="payout-type-legend" legend="Payout type">
            <SegmentedRadioGroup<'annuity' | 'lumpSum'>
              ariaLabel="Payout type"
              value={draft.payoutType ?? 'annuity'}
              onChange={(v) => setDraft({ ...draft, payoutType: v })}
              options={[
                { value: 'annuity', label: 'Annuity (lifetime monthly benefit)' },
                {
                  value: 'lumpSum',
                  label: 'Lump sum (single payout, e.g. cash-balance election)',
                },
              ]}
            />
          </FieldGroup>
        )}

        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-6 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            {draft.kind === 'pension' && (
              <PensionFields
                draft={draft}
                setDraft={setDraft}
                members={members}
                accounts={accounts}
                scenarioInflationPct={scenarioInflationPct}
              />
            )}
            {draft.kind === 'partTime' && (
              <PartTimeFields
                draft={draft}
                setDraft={setDraft}
                members={members}
                scenarioInflationPct={scenarioInflationPct}
              />
            )}
            {draft.kind === 'oneOff' && (
              <OneOffFields
                draft={draft}
                setDraft={setDraft}
                members={members}
                accounts={accounts}
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <ScheduleStartPicker
              draft={draft}
              setDraft={setDraft}
              members={members}
              label={startLabel}
              showMemberPicker={draft.kind === 'partTime'}
              ownerRole={ownerRole}
            />
            {draft.kind === 'partTime' && (
              <ScheduleEndPicker draft={draft} setDraft={setDraft} members={members} />
            )}
          </div>
        </div>
      </div>
      {pendingNavModal}
    </section>
  );
};

interface FieldsProps {
  draft: FormDraft;
  setDraft: (d: FormDraft) => void;
  members: Aggregate<HouseholdMemberPayload>[];
  accounts?: Aggregate<AccountPayload>[];
  scenarioInflationPct?: number;
}

function accountOptionLabel(
  account: Aggregate<AccountPayload>,
  members: Aggregate<HouseholdMemberPayload>[],
): string {
  const p = account.payload;
  let owner: string;
  if (p.ownershipType === 'JOINT') {
    owner = 'Joint';
  } else {
    const member = members.find((m) => m.id === p.ownerId);
    const firstName = member?.payload.firstName?.trim();
    if (firstName) {
      owner = firstName;
    } else {
      owner = member?.payload.isPrimary ? 'Primary' : 'Secondary';
    }
  }
  const parts = [p.institution?.trim(), p.name, owner].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return parts.join(' · ');
}

// Appends a saved-but-ineligible selectedId so the Select still renders it; Save blocks on it via buildPayload.
function depositTargetOptions(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  eligible: (a: Aggregate<AccountPayload>) => boolean,
  members: Aggregate<HouseholdMemberPayload>[],
  selectedId: string,
): { value: string; label: string }[] {
  const eligibleAccounts = accounts.filter(eligible);
  const options = [
    { value: '', label: 'Pick an account' },
    ...eligibleAccounts.map((a) => ({
      value: a.id,
      label: accountOptionLabel(a, members),
    })),
  ];
  if (selectedId && !eligibleAccounts.some((a) => a.id === selectedId)) {
    const saved = accounts.find((a) => a.id === selectedId);
    if (saved) {
      options.push({
        value: saved.id,
        label: `${accountOptionLabel(saved, members)} (not eligible)`,
      });
    }
  }
  return options;
}

const PensionFields: React.FC<FieldsProps> = ({
  draft,
  setDraft,
  members,
  accounts = [],
  scenarioInflationPct = DEFAULT_INFLATION_PCT,
}) =>
  draft.payoutType === 'annuity' ? (
    <>
      <div className="grid grid-cols-2 items-end gap-x-4 gap-y-3">
        <InlineField htmlFor="monthly-benefit" label="Monthly benefit ($)" grow="">
          <TextInput
            id="monthly-benefit"
            type="text"
            inputMode="decimal"
            value={draft.monthlyBenefit}
            onChange={(e) => setDraft({ ...draft, monthlyBenefit: e.target.value })}
            className={inputClass}
          />
        </InlineField>
        <InlineField htmlFor="jns-pct" label="Joint-and-survivor benefit" grow="">
          <Select
            id="jns-pct"
            ariaLabel="Joint-and-survivor benefit"
            value={String(draft.jointAndSurvivorPct)}
            onChange={(v) =>
              setDraft({ ...draft, jointAndSurvivorPct: Number(v) as JointAndSurvivorPct })
            }
            options={[
              { value: '0', label: '0% (single life, dies with pensioner)' },
              { value: '50', label: '50% to surviving spouse' },
              { value: '75', label: '75% to surviving spouse' },
              { value: '100', label: '100% to surviving spouse' },
            ]}
          />
        </InlineField>
        <ToggleSwitch
          label="Use scenario inflation"
          checked={draft.pensionTracksInflation}
          onChange={(v) => setDraft({ ...draft, pensionTracksInflation: v })}
        />
        <InlineField htmlFor="cola-pct" label="Annual COLA" grow="">
          <RangeSlider
            id="cola-pct"
            ariaLabel="Annual COLA"
            min={0}
            max={5}
            step={0.1}
            value={
              draft.pensionTracksInflation
                ? scenarioInflationPct
                : parseFloat(draft.pensionColaPct) || 0
            }
            disabled={draft.pensionTracksInflation}
            onChange={(n) => setDraft({ ...draft, pensionColaPct: String(n) })}
            formatValue={(v) => `${v.toFixed(1)}%`}
          />
        </InlineField>
        {draft.pensionTracksInflation && (
          <Muted as="p" className="col-span-2">
            Engine applies the active scenario&rsquo;s rate as shown.
          </Muted>
        )}
      </div>
      <LinkedCbpAccountPicker
        draft={draft}
        setDraft={setDraft}
        accounts={accounts}
        members={members}
      />
    </>
  ) : (
    <>
      <LinkedCbpAccountPicker
        draft={draft}
        setDraft={setDraft}
        accounts={accounts}
        members={members}
      />
      {draft.linkedCbpAccountId && (
        <Muted as="p" className="mt-0">
          The lump sum transfers the linked Cash Balance Pension account&rsquo;s projected
          balance at the event month into the target account. No manual amount needed.
        </Muted>
      )}
      {/* Linked-CBP lump sums derive the amount from the CBP balance (BalanceProjectionPage's loadPageData), so the manual input is hidden. */}
      {!draft.linkedCbpAccountId && (
        <InlineField htmlFor="lump-amount" label="Lump sum amount ($)" grow="">
          <TextInput
            id="lump-amount"
            type="text"
            inputMode="decimal"
            value={draft.lumpSumAmount}
            onChange={(e) => setDraft({ ...draft, lumpSumAmount: e.target.value })}
            className={inputClass}
          />
        </InlineField>
      )}
      <InlineField htmlFor="lump-target" label="Target account" grow="">
        <Select
          id="lump-target"
          ariaLabel="Target account"
          value={draft.lumpSumTargetAccountId}
          onChange={(v) => setDraft({ ...draft, lumpSumTargetAccountId: v })}
          // The empty option is a selectable row so a chosen target can be cleared back to ''; it doubles as the prompt.
          options={depositTargetOptions(
            accounts,
            isEligibleRolloverTarget,
            members,
            draft.lumpSumTargetAccountId,
          )}
        />
        {accounts.filter(isEligibleRolloverTarget).length === 0 && (
          <Muted as="p" className="mt-1 text-sm">
            No pre-tax retirement account is available to receive a rollover.
            Add an IRA, 401(k), 403(b), 457(b), or TSP account first.
          </Muted>
        )}
      </InlineField>
    </>
  );

interface LinkedCbpAccountPickerProps {
  draft: FormDraft;
  setDraft: (next: FormDraft) => void;
  accounts: Aggregate<AccountPayload>[];
  members: Aggregate<HouseholdMemberPayload>[];
}

const LinkedCbpAccountPicker: React.FC<LinkedCbpAccountPickerProps> = ({
  draft,
  setDraft,
  accounts,
  members,
}) => {
  const cbpAccounts = accounts.filter(
    (a) => a.payload.type === 'RETIREMENT_CASH_BALANCE',
  );
  if (cbpAccounts.length === 0) return null;
  const isAnnuity = draft.payoutType === 'annuity';
  return (
    <Field
      htmlFor="linked-cbp-account"
      label="Linked Cash Balance Pension account (optional)"
    >
      <Select
        id="linked-cbp-account"
        ariaLabel="Linked Cash Balance Pension account (optional)"
        value={draft.linkedCbpAccountId}
        onChange={(v) => setDraft({ ...draft, linkedCbpAccountId: v })}
        options={[
          { value: '', label: 'None' },
          ...cbpAccounts.map((a) => ({
            value: a.id,
            label: accountOptionLabel(a, members),
          })),
        ]}
      />
      <Muted as="p" className="mt-1 text-sm">
        {isAnnuity ? (
          <>
            Picking a CBP account marks this annuity as its replacement at
            retirement — the account is zeroed and the monthly benefit pays
            forward. Payments can start later (deferred annuity); set{' '}
            <em>Start</em> below to whichever date the plan begins paying.
          </>
        ) : (
          <>
            Picking a CBP account marks this lump sum as its payout at
            retirement — the account is zeroed and the balance lands in the
            target account chosen above.
          </>
        )}
      </Muted>
    </Field>
  );
};

const PartTimeFields: React.FC<FieldsProps> = ({
  draft,
  setDraft,
  scenarioInflationPct = DEFAULT_INFLATION_PCT,
}) => (
  <div className="grid grid-cols-2 items-end gap-x-4 gap-y-3">
    <InlineField htmlFor="annual-amount" label="Annual amount ($)" grow="">
      <TextInput
        id="annual-amount"
        type="text"
        inputMode="decimal"
        value={draft.annualAmount}
        onChange={(e) => setDraft({ ...draft, annualAmount: e.target.value })}
        className={inputClass}
      />
    </InlineField>
    <div aria-hidden />
    <ToggleSwitch
      label="Use scenario inflation"
      checked={draft.partTimeTracksInflation}
      onChange={(v) => setDraft({ ...draft, partTimeTracksInflation: v })}
    />
    <InlineField htmlFor="pt-cola" label="Annual COLA" grow="">
      <RangeSlider
        id="pt-cola"
        ariaLabel="Annual COLA"
        min={0}
        max={5}
        step={0.1}
        value={
          draft.partTimeTracksInflation
            ? scenarioInflationPct
            : parseFloat(draft.partTimeColaPct) || 0
        }
        disabled={draft.partTimeTracksInflation}
        onChange={(n) => setDraft({ ...draft, partTimeColaPct: String(n) })}
        formatValue={(v) => `${v.toFixed(1)}%`}
      />
    </InlineField>
    {draft.partTimeTracksInflation && (
      <Muted as="p" className="col-span-2">
        Engine applies the active scenario&rsquo;s rate as shown.
      </Muted>
    )}
  </div>
);

const OneOffFields: React.FC<FieldsProps> = ({ draft, setDraft, members, accounts = [] }) => (
  <>
    <div className="grid grid-cols-2 items-end gap-x-4">
      <InlineField htmlFor="oneoff-source" label="Source" grow="">
        <Select
          id="oneoff-source"
          ariaLabel="Source"
          value={draft.oneOffSource}
          onChange={(v) => setDraft({ ...draft, oneOffSource: v as OneOffIncomeSource })}
          options={[
            { value: 'inheritance', label: 'Inheritance' },
            { value: 'assetSale', label: 'Asset sale' },
            { value: 'other', label: 'Other' },
          ]}
        />
      </InlineField>
      <InlineField htmlFor="oneoff-amount" label="Amount ($)" grow="">
        <TextInput
          id="oneoff-amount"
          type="text"
          inputMode="decimal"
          value={draft.oneOffAmount}
          onChange={(e) => setDraft({ ...draft, oneOffAmount: e.target.value })}
          className={inputClass}
        />
      </InlineField>
    </div>
    <InlineField htmlFor="oneoff-target" label="Target account" grow="">
      <Select
        id="oneoff-target"
        ariaLabel="Target account"
        value={draft.oneOffTargetAccountId}
        onChange={(v) => setDraft({ ...draft, oneOffTargetAccountId: v })}
        options={depositTargetOptions(
          accounts,
          isEligibleWindfallTarget,
          members,
          draft.oneOffTargetAccountId,
        )}
      />
      {accounts.filter(isEligibleWindfallTarget).length === 0 && (
        <Muted as="p" className="mt-1 text-sm">
          No taxable account is available to receive a windfall. Add a
          brokerage, savings, money market, or CD account first.
        </Muted>
      )}
    </InlineField>
  </>
);
