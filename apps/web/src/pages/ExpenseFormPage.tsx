/** /expenses/new and /expenses/:id/edit: the canonical, scenario-added and scenario-patch Expense editor. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, RefreshIcon, XIcon } from '../components/icons';
import { RadioGroup } from 'react-aria-components';
import { RadioOption } from '../components/RadioOption';
import { AnchorCard, AnchorCardGroup } from '../components/AnchorCard';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { safeReturnTo } from '../auth/safe-redirect';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import {
  MemberAgeInput,
  NUMBER_INPUT_CLASS,
  NUMBER_INPUT_WIDTH,
  ANCHOR_SLIDER_WRAP,
} from '../components/MemberAgeInput';
import { RangeSlider } from '../components/RangeSlider';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import {
  scheduleStartToGlideAnchor,
  glideAnchorToScheduleStart,
} from '../lib/schedule-anchor-bridge';
import { yearSliderBounds } from '../lib/age-anchor-bounds';
import { MoneyInput, parseCurrencyInput } from '../components/MoneyInput';
import { DiscretionaryGlideFields } from '../components/DiscretionaryGlideFields';
import { ExpenseProjectionPreview } from '../components/ExpenseProjectionPreview';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { InfoPopover } from '../components/InfoPopover';
import { Alert } from '../components/Alert';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Field } from '../components/Field';
import { Select } from '../components/Select';
import { TextInput } from '../components/TextInput';
import { Muted } from '../components/Muted';
import {
  inputClass,
  breadcrumbNavClass,
} from './scenarios-page-chrome';
import { glideProblem } from '../lib/expense-glide-format';
import { describeEnd } from '../lib/schedule-format';
import { useSync } from '../sync/SyncContext';
import { listAggregates, getAggregate } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from '../lib/crypto-uuid';
import { parseClampedInt } from '../lib/parse-input';
import { saveScenario } from '../lib/scenario-mutations';
import { buildScenarioExpensePatchWrite } from '../lib/scenario-expense-patch';
import { resolveScenario } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  resolveExpensesForScenarioSparse,
  normalizeOverrideId,
} from '../lib/expense-override-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import { medicalCategoryIdsFrom } from '../lib/expense-category-resolvers';
import {
  resolveStartMonth,
  type ScheduleResolveContext,
} from '../lib/schedule-resolution';
import type {
  Aggregate,
  DiscretionaryGlideOverride,
  ExpenseClassification,
  ExpenseCategoryPayload,
  ExpenseFrequency,
  ExpensePayload,
  ExpensesOverride,
  HouseholdMemberPayload,
  HouseholdRole,
  ScenarioPayload,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import {
  computeScenarioPatchSave,
  resolveGlideScenarioFacts,
} from './expense-form-logic';

const RETURN_TO_FALLBACK = '/expenses';

type StartKind = ScheduleStart['kind'];
type EndKind = ScheduleEnd['kind'];

export interface FormState {
  name: string;
  description: string;
  amount: number;
  frequency: ExpenseFrequency;
  classification: ExpenseClassification;
  categoryId: string;

  startKind: StartKind;
  startMemberId: HouseholdRole;
  startYears: number;
  startMonths: number;
  startYear: number;

  endKind: EndKind;
  endMemberId: HouseholdRole;
  endYears: number;
  endMonths: number;
  endYear: number;
  endLifetimeWhose: HouseholdRole | 'last';
  endOffsetYears: number;
  endDurationValue: number;
  endDurationUnit: 'months' | 'years';

  /** Toggling the editor off persists `undefined` in both canonical and scenario-patch mode. */
  discretionaryGlide?: DiscretionaryGlideOverride;
  /** `stateFromPayload` maps an absent legacy value to false (conservative for imported rows); new medical expenses default to true. */
  hsaQualified: boolean;
}

const todayYear = new Date().getUTCFullYear();

const makeDefaultState = (
  hasSecondary: boolean,
  defaultCategoryId: string,
): FormState => ({
  name: '',
  description: '',
  amount: 0,
  frequency: 'monthly',
  classification: 'essential',
  categoryId: defaultCategoryId,
  startKind: 'retirementStart',
  startMemberId: 'primary',
  startYears: 65,
  startMonths: 0,
  startYear: todayYear,
  endKind: 'lifetime',
  endMemberId: 'primary',
  endYears: 95,
  endMonths: 0,
  endYear: todayYear + 30,
  endLifetimeWhose: hasSecondary ? 'last' : 'primary',
  endOffsetYears: 0,
  endDurationValue: 12,
  endDurationUnit: 'months',
  discretionaryGlide: undefined,
  hsaQualified: true,
});

const buildStart = (s: FormState): ScheduleStart => {
  switch (s.startKind) {
    case 'retirementStart':
      return { kind: 'retirementStart' };
    case 'age':
      return {
        kind: 'age',
        memberId: s.startMemberId,
        years: s.startYears,
        months: s.startMonths,
      };
    case 'year':
      return { kind: 'year', year: s.startYear };
  }
};

const buildEnd = (s: FormState): ScheduleEnd | undefined => {
  if (s.frequency === 'oneOff') return undefined;
  switch (s.endKind) {
    case 'age':
      return {
        kind: 'age',
        memberId: s.endMemberId,
        years: s.endYears,
        months: s.endMonths,
      };
    case 'year':
      return { kind: 'year', year: s.endYear };
    case 'lifetime':
      return { kind: 'lifetime', whose: s.endLifetimeWhose };
    case 'endOfRetirementYear':
      return { kind: 'endOfRetirementYear', offsetYears: s.endOffsetYears };
    case 'durationFromStart':
      return {
        kind: 'durationFromStart',
        months:
          s.endDurationUnit === 'years' ? s.endDurationValue * 12 : s.endDurationValue,
      };
  }
};

/** FormState → ExpensePayload, shared by Save and the live preview so both project the same payload. */
export const buildExpensePayload = (s: FormState): ExpensePayload => {
  const payload: ExpensePayload = {
    name: s.name.trim(),
    amount: s.amount,
    frequency: s.frequency,
    classification: s.classification,
    categoryId: s.categoryId,
    start: buildStart(s),
  };
  if (s.description.trim()) payload.description = s.description.trim();
  const end = buildEnd(s);
  if (end) payload.end = end;
  if (s.discretionaryGlide) {
    payload.discretionaryGlide = s.discretionaryGlide;
  }
  // Persist only when true (absent means false); the engine ignores the flag on non-medical rows.
  if (s.hsaQualified) {
    payload.hsaQualified = true;
  }
  return payload;
};

const stateFromPayload = (
  p: ExpensePayload,
  hasSecondary: boolean,
): FormState => {
  const base = makeDefaultState(hasSecondary, p.categoryId);
  base.name = p.name;
  base.description = p.description ?? '';
  base.amount = p.amount;
  base.frequency = p.frequency;
  base.classification = p.classification;
  base.categoryId = p.categoryId;
  base.startKind = p.start.kind;
  if (p.start.kind === 'age') {
    // Legacy demo data may omit memberId; fall back to primary.
    base.startMemberId = p.start.memberId ?? 'primary';
    base.startYears = p.start.years;
    base.startMonths = p.start.months;
  } else if (p.start.kind === 'year') {
    base.startYear = p.start.year;
  }
  if (p.end) {
    base.endKind = p.end.kind;
    if (p.end.kind === 'age') {
      base.endMemberId = p.end.memberId ?? 'primary';
      base.endYears = p.end.years;
      base.endMonths = p.end.months;
    } else if (p.end.kind === 'year') {
      base.endYear = p.end.year;
    } else if (p.end.kind === 'lifetime') {
      base.endLifetimeWhose = p.end.whose;
    } else if (p.end.kind === 'endOfRetirementYear') {
      base.endOffsetYears = p.end.offsetYears;
    } else if (p.end.kind === 'durationFromStart') {
      const m = p.end.months;
      if (m % 12 === 0) {
        base.endDurationUnit = 'years';
        base.endDurationValue = m / 12;
      } else {
        base.endDurationUnit = 'months';
        base.endDurationValue = m;
      }
    }
  }
  base.discretionaryGlide = p.discretionaryGlide;
  // Strict === true (CWE-20): a non-boolean imported value reads as not-qualified.
  base.hsaQualified = p.hsaQualified === true;
  return base;
};

export const ExpenseFormPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isEdit = Boolean(id);
  // No scenarioId: canonical create/edit. With one: scenario-only add (overrides.expenses.added[]) or
  // scenario-patch (patches[id], changed keys only, never the canonical aggregate).
  const scenarioId = searchParams.get('scenarioId');
  const editLocalId = searchParams.get('editLocalId');
  const returnTo = searchParams.get('returnTo');

  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [categories, setCategories] = useState<Aggregate<ExpenseCategoryPayload>[]>([]);
  const [loadedExpense, setLoadedExpense] = useState<Aggregate<ExpensePayload> | null>(null);
  const [scenarioForAdd, setScenarioForAdd] = useState<Aggregate<ScenarioPayload> | null>(null);
  const [editingAddedLocalId, setEditingAddedLocalId] = useState<string | null>(null);
  const [scenarioForPatch, setScenarioForPatch] =
    useState<Aggregate<ScenarioPayload> | null>(null);
  const [openedResolved, setOpenedResolved] = useState<ExpensePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [allExpenses, setAllExpenses] = useState<Aggregate<ExpensePayload>[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);

  const hasSecondary = members.some((m) => !m.payload.isPrimary);
  const primaryName =
    members.find((m) => m.payload.isPrimary)?.payload.firstName?.trim() ||
    'Primary';
  const secondaryName =
    members.find((m) => !m.payload.isPrimary)?.payload.firstName?.trim() ||
    'Secondary';

  const [state, setState] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  // Bumped on each reseed so DiscretionaryGlideFields remounts for an external reseed but not for keystrokes.
  const [seedNonce, setSeedNonce] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Reset mode state at the start of every load: a stale editingAddedLocalId would make Save replace instead of append,
        // and a stale loadedExpense would route Save into the update branch.
        if (active) {
          // Re-enter loading and clear any stale error: otherwise the old form renders during the async reseed and a fast Save writes stale data.
          setLoading(true);
          setError(null);
          setLoadedExpense(null);
          setScenarioForAdd(null);
          setEditingAddedLocalId(null);
          setScenarioForPatch(null);
          setOpenedResolved(null);
          setNameError(null);
          // Clear the form data too: a missing editLocalId hits the not-found early return but would leave the old state non-null, masking the error branch.
          setState(null);
          setBaseline(null);
        }
        const [memRows, catRows, expRows, scenarioRows] = await Promise.all([
          listAggregates('householdMember'),
          listAggregates('expenseCategory'),
          listAggregates('expense'),
          listAggregates('scenario'),
        ]);
        if (!active) return;
        const cats = (catRows as Aggregate<ExpenseCategoryPayload>[]).slice().sort((a, b) =>
          a.payload.name.localeCompare(b.payload.name, undefined, { sensitivity: 'base' }),
        );
        setMembers(memRows as Aggregate<HouseholdMemberPayload>[]);
        setCategories(cats);
        setAllExpenses(expRows as Aggregate<ExpensePayload>[]);
        setScenarios(scenarioRows as ScenarioAggregate[]);

        const hasSec = (memRows as Aggregate<HouseholdMemberPayload>[]).some(
          (m) => !m.payload.isPrimary,
        );
        const defaultCatId = cats[0]?.id ?? '';

        if (id) {
          const ag = (await getAggregate('expense', id)) as Aggregate<ExpensePayload> | null;
          if (!ag) {
            setError('Expense not found.');
            setLoading(false);
            return;
          }
          setLoadedExpense(ag);
          // Scenario-patch mode opens on the scenario-resolved payload; Save stores only keys changed against it.
          let seedPayload = ag.payload;
          if (scenarioId) {
            const sc = (await getAggregate(
              'scenario',
              scenarioId,
            )) as Aggregate<ScenarioPayload> | null;
            if (!sc) {
              setError('Scenario not found.');
              setLoading(false);
              return;
            }
            setScenarioForPatch(sc);
            const resolved = resolveExpensesForScenarioSparse(
              scenarioId,
              scenarioRows as ScenarioAggregate[],
              [ag],
            );
            const match = resolved.find((r) => r.id === normalizeOverrideId(ag.id));
            if (match) seedPayload = match.payload;
          }
          setOpenedResolved(seedPayload);
          const next = stateFromPayload(seedPayload, hasSec);
          setState(next);
          setBaseline(next);
          setSeedNonce((n) => n + 1);
        } else {
          let next = makeDefaultState(hasSec, defaultCatId);
          if (scenarioId) {
            const sc = (await getAggregate(
              'scenario',
              scenarioId,
            )) as Aggregate<ScenarioPayload> | null;
            if (!sc) {
              setError('Scenario not found.');
              setLoading(false);
              return;
            }
            setScenarioForAdd(sc);
            // A missing entry is a hard error: falling back to an append would orphan the row.
            if (editLocalId) {
              const entry = (sc.payload.overrides.expenses?.added ?? []).find(
                (a) => a._localId === editLocalId,
              );
              if (!entry) {
                setError('Scenario-only expense not found.');
                setLoading(false);
                return;
              }
              setEditingAddedLocalId(editLocalId);
              const { _localId: _drop, ...payload } = entry;
              void _drop;
              next = stateFromPayload(payload, hasSec);
            }
          }
          setState(next);
          setBaseline(next);
          setSeedNonce((n) => n + 1);
        }
      } catch {
        if (active) setError('Failed to load form data.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, scenarioId, editLocalId]);

  const isDirty = useMemo(() => {
    if (!state || !baseline) return false;
    return JSON.stringify(state) !== JSON.stringify(baseline);
  }, [state, baseline]);

  // Amounts are today's dollars: surface the Amount hint to users already past retirement.
  const alreadyRetired = useMemo(() => {
    const primaryScenario = scenarios.find((s) => s.payload.isPrimary);
    const primaryMember = members.find((m) => m.payload.isPrimary);
    if (!primaryScenario || !primaryMember?.payload.birthdate) return false;
    try {
      const resolved = resolveScenario(primaryScenario.id, scenarios);
      const map = resolveMemberRetirementDates(
        resolved.retirementAge,
        members.map((m) => ({
          id: m.id,
          isPrimary: m.payload.isPrimary,
          birthdate: m.payload.birthdate ?? '',
        })),
      );
      const iso = map.get(primaryMember.id);
      if (!iso) return false;
      const year = new Date(iso).getUTCFullYear();
      if (!Number.isFinite(year)) return false;
      return year <= new Date().getFullYear();
    } catch {
      return false;
    }
  }, [scenarios, members]);

  // The first state paints immediately; later edits debounce ~200 ms so the money input doesn't churn the projection.
  const [debouncedState, setDebouncedState] = useState<FormState | null>(null);
  const firstPreviewRef = useRef(true);
  useEffect(() => {
    if (!state) return;
    if (firstPreviewRef.current) {
      firstPreviewRef.current = false;
      setDebouncedState(state);
      return;
    }
    const t = setTimeout(() => setDebouncedState(state), 200);
    return () => clearTimeout(t);
  }, [state]);
  const previewDraft = useMemo(
    () => (debouncedState ? buildExpensePayload(debouncedState) : null),
    [debouncedState],
  );
  const previewTargetScenarioId =
    scenarioForPatch?.id ?? scenarioForAdd?.id ?? null;

  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  if (!state && error) {
    return (
      <section aria-labelledby="expense-form-heading">
        <PageHeader
          title={<span id="expense-form-heading">Edit expense</span>}
        />
        <Alert tone="error">{error}</Alert>
      </section>
    );
  }
  if (loading || !state) return <LoadingState label="Loading expense…" variant="form" />;

  const update = (patch: Partial<FormState>): void => setState({ ...state, ...patch });

  const validateName = (candidate: string): string | null => {
    const norm = candidate.trim().toLowerCase();
    if (!norm) return 'Name is required.';
    if (norm.length > 60) return 'Max 60 characters.';
    // Scenario-only adds skip the canonical collision check (different scopes); collision applies within the scenario's added[].
    if (scenarioForAdd) {
      const added = scenarioForAdd.payload.overrides.expenses?.added ?? [];
      const dupInAdded = added.some(
        (a) =>
          a._localId !== editingAddedLocalId &&
          a.name.trim().toLowerCase() === norm,
      );
      if (dupInAdded) {
        return `This scenario already has an expense named "${candidate.trim()}".`;
      }
      return null;
    }
    if (scenarioForPatch) {
      const resolved = resolveExpensesForScenarioSparse(
        scenarioForPatch.id,
        scenarios,
        allExpenses,
      );
      const dup = resolved.some(
        (r) =>
          r.id !== `aggregate:${id}` &&
          (r.payload.name ?? '').trim().toLowerCase() === norm,
      );
      if (dup) {
        return `This scenario already has an expense named "${candidate.trim()}".`;
      }
      return null;
    }
    const collides = allExpenses.some(
      (e) =>
        e.id !== id &&
        (e.payload.name ?? '').trim().toLowerCase() === norm,
    );
    if (collides) return `An expense named "${candidate.trim()}" already exists.`;
    return null;
  };

  const buildGlideCtx = (scId: string | null): ScheduleResolveContext => {
    const primary = members.find((m) => m.payload.isPrimary);
    const secondary = members.find((m) => !m.payload.isPrimary);
    const { retirementYear, retirementMonth0, lifeExpectancy } =
      resolveGlideScenarioFacts(scId, scenarios, members);
    return {
      retirementYear,
      retirementMonth0,
      primary: primary?.payload.birthdate
        ? { birthdate: primary.payload.birthdate }
        : undefined,
      secondary: secondary?.payload.birthdate
        ? { birthdate: secondary.payload.birthdate }
        : undefined,
      // Mirror buildExpenseProjectionContext's life-expectancy fields so every save path resolves a lifetime-bound expenseEnd like the preview.
      lifeExpectancy,
      extendBeyondLifetime: false,
    };
  };

  const onSave = async (): Promise<void> => {
    if (!householdId || !state) return;
    const name = state.name.trim();
    const nameProblem = validateName(name);
    setNameError(nameProblem);
    if (nameProblem) return;
    if (!state.categoryId) {
      setError('Pick a category.');
      return;
    }
    if (state.amount < 0) {
      setError('Amount must be ≥ 0.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildExpensePayload(state);

      // Validate an enabled glide even when its numbers are a value-equivalent no-op (glide-end before glide-start is still a mis-configuration).
      // Skip one-offs: the engine never glides them, so validating a hidden glide would hard-block Save on an unfixable error.
      if (state.frequency !== 'oneOff' && state.discretionaryGlide) {
        const glideCtx = buildGlideCtx(
          scenarioForPatch?.id ?? scenarioForAdd?.id ?? null,
        );
        // Anchor on this expense's own start; fall back to the retirement-year probe when it can't resolve.
        const resolvedStart = resolveStartMonth(payload.start, glideCtx);
        const probe = resolvedStart ?? {
          year: Number.isFinite(glideCtx.retirementYear)
            ? glideCtx.retirementYear
            : 0,
          // Keep the retirement month so the month-precise before-expense rule holds for a mid-year retiree.
          month0: glideCtx.retirementMonth0 ?? 0,
        };
        const problem = glideProblem(
          state.discretionaryGlide,
          glideCtx,
          probe,
          payload.end,
        );
        if (problem) {
          setError(problem);
          setSubmitting(false);
          return;
        }
      }

      if (loadedExpense && scenarioForPatch) {
        // Clearing an inherited optional emits the null clear-marker, not key deletion.
        const nextScenarioPayload = computeScenarioPatchSave(
          scenarioForPatch.payload,
          payload,
          openedResolved ?? loadedExpense.payload,
          state.description,
          state.discretionaryGlide,
          normalizeOverrideId(loadedExpense.id),
          loadedExpense.id,
        );
        await saveScenario({
          scenario: scenarioForPatch,
          payload: nextScenarioPayload,
          householdId,
        });
      } else if (loadedExpense) {
        await queueLocalMutation<ExpensePayload>({
          type: 'expense',
          aggregateId: loadedExpense.id,
          householdId,
          operation: 'update',
          expectedVersion: loadedExpense.version,
          payload,
        });
      } else if (scenarioForAdd) {
        // Add-edit replaces the entry in place, keeping its _localId; plain add appends.
        const existingOverrides: ExpensesOverride =
          scenarioForAdd.payload.overrides.expenses ?? {};
        const existingAdded = existingOverrides.added ?? [];
        const nextAdded = editingAddedLocalId
          ? existingAdded.map((a) =>
              a._localId === editingAddedLocalId
                ? { ...payload, _localId: editingAddedLocalId }
                : a,
            )
          : [...existingAdded, { ...payload, _localId: cryptoUuid() }];
        const nextOverrides: ExpensesOverride = {
          ...existingOverrides,
          added: nextAdded,
        };
        const nextScenarioPayload: ScenarioPayload = {
          ...scenarioForAdd.payload,
          overrides: {
            ...scenarioForAdd.payload.overrides,
            expenses: nextOverrides,
          },
        };
        await saveScenario({
          scenario: scenarioForAdd,
          payload: nextScenarioPayload,
          householdId,
        });
      } else {
        await queueLocalMutation<ExpensePayload>({
          type: 'expense',
          aggregateId: cryptoUuid(),
          householdId,
          operation: 'create',
          expectedVersion: 0,
          payload,
        });
      }
      notifyPending();
      setBaseline(state); // mark clean before navigating away
      // navigateUnguarded: setBaseline is async, so isDirty is still true here and the guard would show the Stay/Leave modal.
      navigateUnguarded(safeReturnTo(returnTo, RETURN_TO_FALLBACK));
    } catch {
      setError('Failed to save expense.');
    } finally {
      setSubmitting(false);
    }
  };

  const reseedFromInherited = async (
    scenario: Aggregate<ScenarioPayload>,
    expense: Aggregate<ExpensePayload>,
  ): Promise<void> => {
    const scenarioRows = (await listAggregates(
      'scenario',
    )) as ScenarioAggregate[];
    setScenarios(scenarioRows);
    const refreshed = scenarioRows.find((s) => s.id === scenario.id);
    if (refreshed) {
      setScenarioForPatch(refreshed as Aggregate<ScenarioPayload>);
    }
    const resolved = resolveExpensesForScenarioSparse(scenario.id, scenarioRows, [
      expense,
    ]);
    const match = resolved.find(
      (r) => r.id === normalizeOverrideId(expense.id),
    );
    const seedPayload = match ? match.payload : expense.payload;
    setOpenedResolved(seedPayload);
    const next = stateFromPayload(seedPayload, hasSecondary);
    setState(next);
    setBaseline(next);
    setSeedNonce((n) => n + 1);
  };

  const onResetScenarioPatch = async (): Promise<void> => {
    if (!householdId || !loadedExpense || !scenarioForPatch) return;
    setSubmitting(true);
    setError(null);
    try {
      // null merged patch ⇒ drop this expense's entire patch entry.
      const nextScenarioPayload = buildScenarioExpensePatchWrite(
        scenarioForPatch.payload,
        normalizeOverrideId(loadedExpense.id),
        loadedExpense.id,
        null,
      );
      await saveScenario({
        scenario: scenarioForPatch,
        payload: nextScenarioPayload,
        householdId,
      });
      notifyPending();
      await reseedFromInherited(scenarioForPatch, loadedExpense);
    } catch {
      setError('Failed to reset overrides.');
    } finally {
      setSubmitting(false);
    }
  };

  const scenarioPatchesThisExpense = Boolean(
    scenarioForPatch &&
      loadedExpense &&
      (() => {
        const p = scenarioForPatch.payload.overrides.expenses?.patches;
        return (
          p !== undefined &&
          (p[normalizeOverrideId(loadedExpense.id)] !== undefined ||
            p[loadedExpense.id] !== undefined)
        );
      })(),
  );

  return (
    <section aria-labelledby="expense-form-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={safeReturnTo(returnTo, RETURN_TO_FALLBACK)}>← Back</Link>
      </nav>
      <PageHeader
        title={
          <span id="expense-form-heading">
            {isEdit
              ? 'Edit expense'
              : scenarioForAdd
                ? editingAddedLocalId
                  ? 'Edit scenario-only expense'
                  : 'Add scenario-only expense'
                : 'Add expense'}
          </span>
        }
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
          onClick: () => void onSave(),
          disabled: submitting,
        }}
        actionIcon={<CheckIcon />}
        secondaryActions={[
          ...(scenarioPatchesThisExpense
            ? [
                {
                  label: 'Reset overrides in this scenario',
                  icon: <RefreshIcon />,
                  onClick: () => void onResetScenarioPatch(),
                  disabled: submitting,
                  tone: 'danger' as const,
                },
              ]
            : []),
          {
            label: 'Cancel',
            icon: <XIcon />,
            // Explicit Cancel bypasses the dirty guard.
            onClick: () => navigateUnguarded(safeReturnTo(returnTo, RETURN_TO_FALLBACK)),
            tone: 'neutral' as const,
          },
        ]}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <form
        id="expense-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        noValidate
        className="flex flex-col gap-6 rounded-md border border-line bg-surface-raised p-4"
      >
        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-6 sm:grid-cols-2">
          <div className="grid min-w-0 grid-cols-2 items-start gap-x-4 gap-y-2">
            <Field
              htmlFor="exp-name"
              label="Name"
              error={nameError}
              className="col-span-2"
            >
              <TextInput
                id="exp-name"
                required
                maxLength={60}
                className={inputClass}
                value={state.name}
                onChange={(e) => {
                  update({ name: e.target.value });
                  setNameError(null);
                }}
                onBlur={(e) => setNameError(validateName(e.target.value))}
              />
            </Field>

            <Field
              htmlFor="exp-description"
              label="Description (optional)"
              className="col-span-2"
            >
              <TextInput
                id="exp-description"
                maxLength={200}
                className={inputClass}
                value={state.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </Field>

            <Field htmlFor="exp-category" label="Category">
              <Select
                id="exp-category"
                ariaLabel="Category"
                value={state.categoryId}
                onChange={(v) => update({ categoryId: v })}
                options={
                  categories.length === 0
                    ? [
                        {
                          value: '',
                          label:
                            'No categories. Add one in Settings → Categories',
                        },
                      ]
                    : categories.map((c) => ({
                        value: c.id,
                        label: c.payload.name,
                      }))
                }
              />
            </Field>

            <Field htmlFor="exp-frequency" label="Frequency">
              <Select
                id="exp-frequency"
                ariaLabel="Frequency"
                value={state.frequency}
                onChange={(v) => update({ frequency: v as ExpenseFrequency })}
                options={[
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'monthly', label: 'Monthly' },
                  { value: 'quarterly', label: 'Quarterly' },
                  { value: 'yearly', label: 'Yearly' },
                  { value: 'oneOff', label: 'One-off' },
                ]}
              />
            </Field>

            <div className="min-w-0">
              <MoneyInput
                variant="form"
                id="exp-amount"
                label="Amount"
                value={state.amount}
                onChange={(n) =>
                  update({ amount: parseCurrencyInput(String(n)) ?? 0 })
                }
                allowNegative={false}
              />
              {alreadyRetired && (
                <Muted as="p" className="mb-0 mt-1 text-sm">
                  <strong>Already retired?</strong> Enter what the expense costs
                  today, in today's dollars.
                </Muted>
              )}
            </div>

            {/* A radio group, not a ToggleSwitch: neither value reads as "off". */}
            <div className="min-w-0">
              <span
                id="exp-classification-label"
                className="mb-1 block text-sm font-medium text-ink"
              >
                Classification
              </span>
              <RadioGroup
                aria-labelledby="exp-classification-label"
                value={state.classification}
                onChange={(v) =>
                  update({ classification: v as ExpenseClassification })
                }
                className="flex min-h-10 items-center gap-4"
              >
                <RadioOption value="essential">Essential</RadioOption>
                <RadioOption value="discretionary">Discretionary</RadioOption>
              </RadioGroup>
            </div>

            {medicalCategoryIdsFrom(categories).includes(state.categoryId) && (
              <div className="col-span-2 min-w-0">
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    label="Can be paid tax-free from an HSA"
                    checked={state.hsaQualified}
                    onChange={(v) => update({ hsaQualified: v })}
                  />
                  <InfoPopover label="What an HSA can pay for tax-free">
                    <p className="m-0 mb-2 font-semibold text-ink">
                      What an HSA can pay for tax-free
                    </p>
                    <p className="m-0 mb-1 font-medium text-ink">
                      HSA can pay tax-free
                    </p>
                    <ul className="m-0 mb-2 list-disc pl-4">
                      <li>
                        Out-of-pocket care — doctor visits, deductibles,
                        copays, prescriptions
                      </li>
                      <li>Dental and vision care</li>
                      <li>
                        Qualified long-term-care services for a chronically
                        ill person under a licensed plan of care
                        (nursing-home / assisted-living costs only to the
                        extent they are for medical or nursing care)
                      </li>
                      <li>
                        Qualified long-term-care insurance premiums (subject
                        to IRS age-based dollar limits — see footer)
                      </li>
                      <li>
                        Medicare premiums (Part A if you pay it, Part B,
                        Part D, Medicare Advantage) once you&apos;re 65+
                      </li>
                      <li>
                        COBRA premiums, or premiums paid while receiving
                        unemployment
                      </li>
                    </ul>
                    <p className="m-0 mb-1 font-medium text-ink">
                      HSA cannot pay tax-free
                    </p>
                    <p className="m-0 mb-1 text-xs text-muted">
                      Before 65, doing so = income tax plus a 20% penalty.
                      At 65+, still income tax but no penalty.
                    </p>
                    <ul className="m-0 mb-2 list-disc pl-4">
                      <li>Most health-insurance premiums</li>
                      <li>ACA / marketplace plan premiums before 65</li>
                      <li>Medigap (Medicare supplement) premiums</li>
                      <li>
                        Gym / health-club dues (a prescription alone
                        doesn&apos;t qualify them)
                      </li>
                    </ul>
                    <p className="m-0 mb-2 text-xs">
                      <strong className="text-ink">Tip:</strong> If a
                      premium&apos;s HSA status changes at 65 (e.g.
                      marketplace before 65, Medicare after), enter it as
                      two expenses — one ending at 65 marked No, one
                      starting at 65 marked Yes.
                    </p>
                    <p className="m-0 mt-2 border-t border-line pt-2 text-xs text-muted" role="note">
                      These are general rules and depend on your situation.
                      Long-term-care insurance premiums have age-based IRS
                      dollar limits this tool does not model. Verify against
                      official IRS guidance (Publications 969 and 502) or
                      check with an appropriately qualified professional.
                    </p>
                  </InfoPopover>
                </div>
                {!state.hsaQualified && (
                  <p className="m-0 mt-1 text-xs text-muted">
                    Paid like a normal expense — not drawn from an HSA.
                  </p>
                )}
              </div>
            )}

            <div className="col-span-2 min-w-0">
              <ExpenseProjectionPreview
                draft={previewDraft}
                members={members}
                scenarios={scenarios}
                targetScenarioId={previewTargetScenarioId}
              />
            </div>
          </div>

          <AnchorCardGroup>
            <div className="flex min-w-0 flex-col gap-5">
              <StartSection
                state={state}
                update={update}
                members={members}
                hasSecondary={hasSecondary}
                primaryName={primaryName}
              />

              {state.frequency !== 'oneOff' && (
                <EndSection
                  state={state}
                  update={update}
                  members={members}
                  hasSecondary={hasSecondary}
                  primaryName={primaryName}
                  secondaryName={secondaryName}
                />
              )}

              {/* Always-mounted polite live region: its content flips from empty to the message only when the glide section mounts. */}
              <div aria-live="polite" className="sr-only">
                {state.frequency !== 'oneOff'
                  ? 'Spending glide options are shown below.'
                  : ''}
              </div>

              {state.frequency !== 'oneOff' && (
                <DiscretionaryGlideFields
                  key={`glide-${seedNonce}`}
                  value={state.discretionaryGlide}
                  onChange={(g) => update({ discretionaryGlide: g })}
                  members={members}
                  mode={scenarioForPatch ? 'scenario-patch' : 'canonical'}
                />
              )}
            </div>
          </AnchorCardGroup>
        </div>
      </form>

      {pendingNavModal}
    </section>
  );
};

const StartSection: React.FC<{
  state: FormState;
  update: (patch: Partial<FormState>) => void;
  members: Aggregate<HouseholdMemberPayload>[];
  hasSecondary: boolean;
  primaryName: string;
}> = ({ state, update, members, hasSecondary, primaryName }) => (
  <ScheduleAnchorPicker
    label="Start"
    members={members}
    ageLabel={`At ${hasSecondary ? '' : `${primaryName}'s `}age`}
    value={scheduleStartToGlideAnchor(buildStart(state))}
    onChange={(anchor) => {
      const next = glideAnchorToScheduleStart(anchor);
      switch (next.kind) {
        case 'retirementStart':
          update({ startKind: 'retirementStart' });
          break;
        case 'age':
          update({
            startKind: 'age',
            startMemberId: next.memberId ?? state.startMemberId,
            startYears: next.years,
            startMonths: next.months,
          });
          break;
        case 'year':
          update({ startKind: 'year', startYear: next.year });
          break;
      }
    }}
  />
);

const EndSection: React.FC<{
  state: FormState;
  update: (patch: Partial<FormState>) => void;
  members: Aggregate<HouseholdMemberPayload>[];
  hasSecondary: boolean;
  primaryName: string;
  secondaryName: string;
}> = ({ state, update, members, hasSecondary, primaryName, secondaryName }) => {
  const endPhrase = describeEnd(buildEnd(state), members);
  const summary = endPhrase.charAt(0).toUpperCase() + endPhrase.slice(1);
  return (
  <AnchorCard
    label="End"
    summary={summary}
  >
    <RadioGroup
      aria-label="End"
      value={state.endKind}
      onChange={(v) => update({ endKind: v as FormState['endKind'] })}
      className="anchor-grid items-center gap-x-3 gap-y-3"
    >
      <RadioOption value="lifetime">Until death</RadioOption>
      {hasSecondary ? (
        <Select
          ariaLabel="Whose lifetime"
          value={state.endLifetimeWhose}
          disabled={state.endKind !== 'lifetime'}
          onChange={(v) =>
            update({ endLifetimeWhose: v as HouseholdRole | 'last' })
          }
          className="w-40 flex-shrink-0"
          options={[
            { value: 'primary', label: `of ${primaryName}` },
            { value: 'secondary', label: `of ${secondaryName}` },
            { value: 'last', label: 'of last surviving' },
          ]}
        />
      ) : (
        <span />
      )}

      <RadioOption value="age">
        At {hasSecondary ? '' : `${primaryName}'s `}age
      </RadioOption>
      <MemberAgeInput
        inline
        yearsOnly
        disabled={state.endKind !== 'age'}
        members={members}
        memberId={state.endMemberId}
        years={state.endYears}
        months={state.endMonths}
        ariaPrefix="End age"
        onChange={({ memberId, years, months }) =>
          update({
            endMemberId: memberId ?? state.endMemberId,
            endYears: years,
            endMonths: months,
          })
        }
      />

      <RadioOption value="year">In year</RadioOption>
      <div className={ANCHOR_SLIDER_WRAP}>
        <RangeSlider
          ariaLabel="End year"
          {...yearSliderBounds(state.endYear, members)}
          step={1}
          value={state.endYear}
          disabled={state.endKind !== 'year'}
          onChange={(v) => update({ endYear: v })}
          formatValue={(v) => `${v}`}
        />
      </div>

      <RadioOption value="endOfRetirementYear">After</RadioOption>
      <div className={ANCHOR_SLIDER_WRAP}>
        <RangeSlider
          ariaLabel="Number of retirement years"
          min={1}
          max={30}
          step={1}
          value={state.endOffsetYears + 1}
          disabled={state.endKind !== 'endOfRetirementYear'}
          onChange={(v) => update({ endOffsetYears: v - 1 })}
          formatValue={(v) => `${v} years`}
        />
      </div>

      <RadioOption value="durationFromStart">For</RadioOption>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TextInput
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="Duration value"
          disabled={state.endKind !== 'durationFromStart'}
          className={`${NUMBER_INPUT_CLASS} ${NUMBER_INPUT_WIDTH} text-center`}
          value={String(state.endDurationValue)}
          onChange={(e) => update({ endDurationValue: parseClampedInt(e.target.value, 1200) })}
        />
        {/* A Select, not a switch: a nested RadioGroup is invalid inside the End RadioGroup. */}
        <Select
          ariaLabel="Duration unit"
          disabled={state.endKind !== 'durationFromStart'}
          value={state.endDurationUnit}
          onChange={(v) =>
            update({ endDurationUnit: v as 'months' | 'years' })
          }
          options={[
            { value: 'months', label: 'months' },
            { value: 'years', label: 'years' },
          ]}
        />
      </div>
    </RadioGroup>
  </AnchorCard>
  );
};
