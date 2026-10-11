/**
 * /income/new and /income/:id/edit — IncomeStream form. Kind-aware:
 * pension (annuity / lumpSum), partTime, oneOff. v1 form exposes a
 * narrower subset of the partTime start/end vocabulary (start age +
 * duration in years) — the data model still supports the full
 * ScheduleStart / ScheduleEnd discriminated unions for future expansion.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * single kind-aware (pension annuity / pension lumpSum / partTime / oneOff)
 * canonical/added/patch income editor — one form/validation/scenario-write
 * state machine where each kind branches the visible field set, the
 * payout-type rules (linked-CBP lump sums force amount to 0), and the
 * start/end vocabulary against the same draft and unsaved-edits guard. The
 * draft/payload conversion, eligibility, scenario-patch delta/save, and
 * retirement-facts helpers are already extracted to `./income-form-logic`.
 * The apparent duplication with ExpenseFormPage is not a reason to merge the
 * two forms: they are domain-divergent (income carries COLA,
 * inflation-tracking, payout-type, and CBP-linkage knobs that have no expense
 * analogue, and the override / patch semantics differ); the only genuinely
 * identical helpers (`jsonEq`, `safeReturnTo`, the scenario-patch write) are
 * already shared via extracted modules. Trigger: a change adding 5 or more
 * lines here must either refactor the file back under the limit or
 * re-justify this exception in this note.
 */
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
  // New streams default to tracking scenario inflation (tracksInflation = true).
  pensionTracksInflation: true,
  pensionColaPct: '0',
  jointAndSurvivorPct: 50,
  linkedCbpAccountId: '',
  lumpSumAmount: '',
  lumpSumTargetAccountId: '',
  annualAmount: '',
  // New streams default to tracking scenario inflation (tracksInflation = true).
  partTimeTracksInflation: true,
  partTimeColaPct: '0',
  oneOffAmount: '',
  oneOffSource: 'inheritance',
  oneOffTargetAccountId: '',
  start: defaultStartFor('pension', currentYear),
  end: undefined,
  taxable: true,
});

/** This flow's `safeReturnTo` fallback (parity with ExpenseFormPage). */
const RETURN_TO_FALLBACK = '/income';

/** Flex-row form cell: label above control, no bottom margin (sits in
 *  horizontal flex rows where `<Field>`'s `mb-3` adds a phantom gap). */
const InlineField: React.FC<{
  htmlFor: string;
  label: React.ReactNode;
  /**
   * Sizing class for the field's wrapper. In a flex row this is a
   * `flex-*` weight (default `flex-1`); in a `grid` row pass a
   * `sm:col-span-*` instead (the default `flex-1` is inert on a grid
   * item, so unspanned siblings just occupy one track).
   */
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
  // Scenario context (mirrors ExpenseFormPage). Read regardless of
  // `isEdit` so all five modes are reachable:
  //   - canonical create  : /income/new
  //   - canonical edit     : /income/:id/edit
  //   - scenario-add       : /income/scenario-entry?scenarioId=…
  //   - scenario-add-edit  : /income/scenario-entry?scenarioId=…&editLocalId=…
  //   - scenario-patch     : /income/:id/edit?scenarioId=…
  // Scenario-add(-edit) writes to overrides.income.added[]; scenario-patch
  // writes only the changed keys into overrides.income.patches[id]; neither
  // touches the canonical IncomeStream aggregate.
  const scenarioId = searchParams.get('scenarioId');
  const editLocalId = searchParams.get('editLocalId');
  // Scenario-only-add (non-edit route) keeps its own param so the existing
  // load branch / dep array stays narrow.
  const scenarioIdParam = !isEdit ? scenarioId : null;

  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  // Canonical income streams (the whole household) + scenarios, kept for
  // name-uniqueness validation in all three modes (mirrors the expense
  // form's `allExpenses` / `scenarios`).
  const [allIncome, setAllIncome] = useState<Aggregate<IncomeStreamPayload>[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [scenarioForAdd, setScenarioForAdd] = useState<Aggregate<ScenarioPayload> | null>(null);
  // Scenario-patch mode: the scenario being patched + the resolved income
  // payload the form opened with (the per-key delta baseline). Mirrors the
  // expense form's `scenarioForPatch` / `openedResolved`.
  const [scenarioForPatch, setScenarioForPatch] =
    useState<Aggregate<ScenarioPayload> | null>(null);
  const [openedResolved, setOpenedResolved] = useState<IncomeStreamPayload | null>(null);
  // Scenario-only add-edit: the `_localId` of the `added[]` entry being
  // re-edited. Null → append a fresh entry; set → replace in place.
  const [editingAddedLocalId, setEditingAddedLocalId] = useState<string | null>(null);
  // Resolved scenario inflation rate shown read-only when toggle is on.
  const [scenarioInflationPct, setScenarioInflationPct] = useState<number>(DEFAULT_INFLATION_PCT);
  // Save-time schedule validation facts: owner-relative retirement dates
  // + the scenario life-expectancy override (resolved from the effective
  // scenario at load), so `validateSchedule` resolves anchors the way the
  // projection engine does.
  const [retirementByMember, setRetirementByMember] = useState<
    Map<string, { year: number; month0: number }>
  >(() => new Map());
  const [lifeExpectancy, setLifeExpectancy] = useState<
    LifeExpectancyOverride | undefined
  >(undefined);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [baseline, setBaseline] = useState<FormDraft | null>(null);
  const [version, setVersion] = useState<number>(0);
  const [aggregateId, setAggregateId] = useState<string>(() => cryptoUuid('iv'));
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
        // Reset mode-specific state at the START of every load so a
        // same-component route/query transition (e.g. add-edit → plain add)
        // doesn't carry stale mode state. These are otherwise only SET inside
        // conditional branches, never reset — leaving e.g. a stale
        // `editingAddedLocalId` that would make Save replace a row instead of
        // appending. Guarded by `cancelled` like the rest of the effect.
        if (!cancelled) {
          // On a same-component query-only transition (e.g.
          // add-edit → plain add) `loading` was left `false` by the prior
          // load's `finally`, so the form body would render the OLD draft
          // (mode flags already reset above) during the async reseed window
          // — a fast Save there could write stale data through the canonical
          // branch, or a stale load `error` could linger. Re-enter the
          // loading state (which gates the form body / Save) and clear any
          // stale error so the reseed window shows the skeleton, not a
          // stale-but-actionable form.
          setLoading(true);
          setError(null);
          setScenarioForAdd(null);
          setScenarioForPatch(null);
          setOpenedResolved(null);
          setEditingAddedLocalId(null);
          setNameError(null);
          // Also clear the form data. The mode-flag reset above plus
          // `loading=true` is not enough — on a same-route query-only
          // transition to a MISSING editLocalId the load hits its not-found
          // early return (sets `error`, clears `loading` in `finally`) but
          // leaves the OLD `draft` non-null, so the `!draft && error` error
          // branch is masked and the stale form renders (and a Save would
          // route through the canonical branch with stale data). Clearing
          // draft/baseline here makes the not-found path render the error and
          // is identical to a fresh mount on the success path (the loading
          // skeleton shows until the reseed completes).
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
        // Resolve scenario inflation for the disabled PercentInput shown
        // when tracksInflation is on. When opened in scenario-only-add mode,
        // the scenario isn't loaded yet (set below), so fall back to the base
        // scenario's inflation or DEFAULT_INFLATION_PCT.
        const baseScenario = scenarioRows.find(
          (s) => !s.payload.parentScenarioId,
        ) ?? scenarioRows[0];
        if (baseScenario) {
          setScenarioInflationPct(
            baseScenario.payload.overrides.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
          );
        }
        // Schedule-validation facts default to the base scenario; the
        // scenario-only-add branch below overrides them with its chain.
        const baseFacts = resolveRetirementFacts(baseScenario, scenarioRows, memberRows);
        if (!cancelled) {
          setRetirementByMember(baseFacts.retirementByMember);
          setLifeExpectancy(baseFacts.lifeExpectancy);
        }
        // Sort active accounts by the same composite label every
        // dropdown renders ("{institution} · {name} · {owner}") so the
        // visible order matches the alphabetical order users expect to
        // scan. Resolves on `memberRows` (already fetched above) so the
        // owner segment is stable.
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
          // Scenario-patch mode: pre-fill from the scenario-RESOLVED stream
          // (canonical + inherited/own per-key patches) so the form opens
          // showing what this scenario actually projects; Save then stores
          // only the keys the user changes vs this opened-resolved value.
          // Default = canonical edit (today's behaviour).
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
              // Resolve the patched scenario's effective facts (inflation +
              // retirement) so the form's COLA display + schedule validation
              // match what this scenario projects.
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
            // Override inflation with the scenario's effective rate when
            // opened in scenario-only-add mode. Walk the full parent chain
            // via resolveScenario so a child scenario with no local inflation
            // override correctly inherits from its parent.
            setScenarioInflationPct(
              resolveScenario(sc.id, scenarioRows as ScenarioAggregate[]).inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
            );
            const scFacts = resolveRetirementFacts(sc, scenarioRows, memberRows);
            if (!cancelled) {
              setRetirementByMember(scFacts.retirementByMember);
              setLifeExpectancy(scFacts.lifeExpectancy);
            }
            // Scenario-only add-EDIT: re-open an existing `added[]` entry
            // (matched by `_localId`) seeded with its stored payload; Save
            // replaces it in place. Missing entry → hard error (never
            // silently fall back to an append, which would orphan the row).
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
          // Create-mode URL prefill — used by the CbpRemediationBanner
          // "Add Income source" deep link so the user lands on a form
          // already wired for a CBP stream (kind: pension, payout:
          // annuity, linkedCbpAccountId: <CBP account>, owner: <account
          // owner>). Unknown params are ignored.
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

  /**
   * Case-folded + trimmed name-uniqueness check. Mirrors ExpenseFormPage's
   * `validateName`, scoped to
   * the form's mode:
   *   - canonical edit/create: reject a collision against another non-deleted
   *     canonical IncomeStream, excluding the stream being edited (by `id`).
   *   - scenario-patch: reject a collision against the scenario-resolved
   *     income list (what this scenario projects), excluding the current row.
   *   - scenario-only add / add-edit: reject only a duplicate inside this
   *     scenario's own `overrides.income.added[]` (excluding the row being
   *     edited); the canonical-name uniqueness check is intentionally skipped
   *     (a scenario "Side gig" may coexist with a
   *     household-list "Side gig").
   * Returns the inline error string, or null when the name is acceptable.
   */
  const validateName = (candidate: string): string | null => {
    const norm = candidate.trim().toLowerCase();
    if (!norm) return 'Name is required.';
    // Parity with ExpenseFormPage's validateName. Non-exploitable
    // (the Name input carries maxLength={60}) — pure guard parity.
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
    // Cross-field schedule guard (partTime only — the one kind with an
    // end): reject an end that resolves on or before the start, the
    // "end before start" bug. Resolves owner-relative anchors via the
    // facts captured at load.
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
        // Scenario-patch mode: write only the keys that changed vs the
        // opened-resolved value, merged into THIS scenario's existing
        // patch. The canonical aggregate is never touched.
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
        // Scenario-only add / add-edit — write into the scenario's
        // overrides.income.added[]. Add-edit (`editingAddedLocalId` set)
        // replaces the matching entry in place, keeping its `_localId` so
        // the row is updated, not duplicated; plain add appends a fresh one.
        // Mirrors ExpenseFormPage's scenario-only path.
        const existingOverrides: IncomeOverride =
          scenarioForAdd.payload.overrides.income ?? {};
        const existingAdded = existingOverrides.added ?? [];
        const nextAdded = editingAddedLocalId
          ? existingAdded.map((a) =>
              a._localId === editingAddedLocalId
                ? { ...built, _localId: editingAddedLocalId }
                : a,
            )
          : [...existingAdded, { ...built, _localId: cryptoUuid('iv') }];
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
      // Scenario-only-add flow (ScenarioIncomeOverridesCard /
      // ScenarioExpenseOverridesCard) passes a `returnTo` pointing
      // back to the originating scenario. Default = /income list.
      // Use `navigateUnguarded` — `setBaseline` is async so `isDirty`
      // is still `true` at the moment the navigation fires; bare
      // `navigate()` would be intercepted by the patched pushState.
      const returnTo = searchParams.get('returnTo');
      navigateUnguarded(safeReturnTo(returnTo, RETURN_TO_FALLBACK));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Where Cancel + the back-link point. Scenario-only add returns to
  // the originating scenario's income-overrides sub-screen via
  // `returnTo`; canonical create/edit returns to /income.
  const returnToParam = searchParams.get('returnTo');
  const backHref = safeReturnTo(returnToParam, RETURN_TO_FALLBACK);

  // Header titles per mode: canonical edit + scenario-patch both read
  // "Edit income source" (the subtitle names the scenario for patch);
  // scenario-add-edit reads "Edit scenario-only income source"; the two
  // create paths keep their add titles.
  const headerTitle = isEdit
    ? 'Edit income source'
    : scenarioForAdd
      ? editingAddedLocalId
        ? 'Edit scenario-only income source'
        : 'Add scenario-only income source'
      : 'Add income source';

  // A load-time error (income / scenario / scenario-only entry not found)
  // leaves `draft` null, so surface it instead of an endless skeleton —
  // the form body below only renders once a real draft is seeded.
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

  // Schedule-card heading: a one-time payout (lump sum / windfall) "is
  // received at" a date; recurring streams (annuity / part-time) "start".
  const startLabel =
    (draft.kind === 'pension' && draft.payoutType === 'lumpSum') ||
    draft.kind === 'oneOff'
      ? 'Received at'
      : 'Start';

  // The stream owner's role drives the bridge's owner-implicit
  // `age.memberId` policy: an owner-implicit start displays/bounds
  // the owner and stays omitted on a years-only edit. Owner is the
  // member selected in the Owner field; absent (no member yet) → primary.
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
        {/* Identity band — full width above the two-column body. */}
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
              // Validate on blur (not only at Save) so a name collision or
              // empty name surfaces while the user is still here, not after
              // a round-trip from the Save button (parity with ExpenseForm).
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
              // Resetting start/end on kind switch — defaults per kind
              // differ (annuity wants age 65, partTime wants age 67,
              // oneOff wants a year). Carrying over a non-applicable
              // shape into the picker is confusing.
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

        {/* Payout type is pension-only and steers both the left-column money
            fields and the schedule label ("Start" vs "Received at"), so it
            sits in the full-width band above the two columns. */}
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

        {/* Two columns: the stream's money shape on the left, when it
            happens on the right. Every kind shares this shape; kinds with no
            End (pension, one-off) simply carry a single Start card on the
            right. The graph-free income form has no full-width row below. */}
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
  /** Resolved scenario inflation rate (%) shown read-only in the
   *  disabled PercentInput when tracksInflation toggle is on. */
  scenarioInflationPct?: number;
}

/** Render an account select-option label as `{institution} - {name} -
 *  {owner}`. The owner segment resolves to the member's first name when
 *  available; JOINT accounts read "Joint"; falls back to "Primary" /
 *  "Secondary" when the member is missing or has no first name (mirrors
 *  the member-label convention in docs/ui-conventions.md). Institution may
 *  be blank for legacy data — the helper collapses the dashes so the
 *  label doesn't read " — Foo — Bar". */
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

/**
 * Build the option list for a deposit-target `<Select>`, filtered to the
 * accounts the income kind may target (`eligible`). The empty prompt row stays
 * first. A currently-saved-but-now-ineligible `selectedId` (legacy edit)
 * is appended so the Select still renders its label and the user can see + re-
 * pick the value rather than have it silently disappear; Save then blocks on it
 * via `buildPayload`.
 */
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

/** Left-column money fields for a pension stream. The Payout-type
 *  segmented control lives in the page's full-width band; the schedule
 *  card is rendered by the page in the right column. */
const PensionFields: React.FC<FieldsProps> = ({
  draft,
  setDraft,
  members,
  accounts = [],
  scenarioInflationPct = DEFAULT_INFLATION_PCT,
}) =>
  draft.payoutType === 'annuity' ? (
    <>
      {/* 2×2 money grid: Monthly benefit + inflation toggle on the left,
          Joint-and-survivor + COLA on the right. `items-end` bottom-aligns
          each row so the controls line up despite differing label heights.
          The toggle locks the COLA input to the scenario inflation
          rate (read-only) so the user sees the live effective rate instead
          of a stale explicit number; off → editable explicit colaPct. */}
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
        {/* Clarify that the displayed rate is the base-scenario
            rate; the engine applies the active scenario’s rate at runtime. */}
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
      {/* Picking the linked CBP account first lets the user see the
          "amount comes from the CBP balance" affordance before the
          target / amount fields render — once linked, the manual amount
          field disappears. */}
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
      {/* Linked-CBP lump-sums derive the amount from the CBP account's
          projected balance at the event month (handled in
          BalanceProjectionPage's loadPageData). Hide the manual dollar
          input in that case and substitute an explanatory note — keeps
          the user from typing a number that the engine would ignore. */}
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
          // The empty option is a real selectable listbox row (the
          // prompt), matching the pre-migration native `<option
          // value="">` so a chosen target can be cleared back to ''
          // (re-entering the existing validation path). It doubles as the
          // prompt, so no separate `placeholder`.
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

/**
 * "Linked CBP account" dropdown shared by pension annuity + lump-sum
 * streams. Hidden when the household has no Cash Balance Pension
 * accounts. Picking an entry marks this income stream as the payout
 * for that CBP — the source balance is zeroed at retirement and the
 * stream carries the value forward (annuity → monthly benefit; lump
 * sum → rollover into `targetAccountId`).
 */
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

/** Left-column money fields for a part-time / earned-income stream. The
 *  Start + End schedule cards are rendered by the page in the right
 *  column. */
const PartTimeFields: React.FC<FieldsProps> = ({
  draft,
  setDraft,
  scenarioInflationPct = DEFAULT_INFLATION_PCT,
}) => (
  // 2×2 money grid mirroring the pension annuity: Annual amount +
  // inflation toggle on the left, COLA on the right. Part-time has no
  // Joint-and-survivor field, so the top-right cell is intentionally empty.
  // `items-end` bottom-aligns each row. The toggle locks the COLA
  // slider to the scenario inflation rate (read-only); off → editable.
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
    {/* Same clarification as the pension COLA field. */}
    {draft.partTimeTracksInflation && (
      <Muted as="p" className="col-span-2">
        Engine applies the active scenario&rsquo;s rate as shown.
      </Muted>
    )}
  </div>
);

/** Left-column money fields for a one-off / windfall stream. The
 *  "Received at" schedule card is rendered by the page in the right
 *  column. */
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
        // Selectable empty prompt row, mirroring the pre-migration native
        // `<option value="">` so a chosen target can be cleared back to ''
        // (existing validation path). It also serves as the prompt, so no
        // separate `placeholder`.
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
