/**
 * /expenses/new and /expenses/:id/edit — canonical Expense form.
 *
 * Defaults: monthly, essential, start of retirement, until death of
 * last surviving (or `lifetime` for single-member). Form participates
 * in the standard unsaved-edits guard.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * single scenario-aware canonical/added/patch expense editor — one
 * form/validation/scenario-write state machine in which the field state, the
 * classification/frequency/timepoint cross-validation, and the
 * canonical-vs-added-vs-patch write path all read and mutate the same draft.
 * The pure scenario-patch delta/save and glide-facts helpers are already
 * extracted to `./expense-form-logic`. The apparent duplication with
 * IncomeFormPage is not a reason to merge the two forms: they are
 * domain-divergent (income and expenses carry different override / patch
 * semantics — glide paths, discretionary classification, and lifetime-end
 * anchors are expense-only), and the only genuinely identical helpers
 * (`jsonEq`, `safeReturnTo`, the scenario-patch write) are already extracted
 * to shared modules. The live projection preview adds only thin wiring here
 * (the extracted `buildExpensePayload`, a debounced selector, and one
 * `<ExpenseProjectionPreview>` render line); all projection / marker / trim
 * logic lives in that bounded component. Trigger: a change adding 5 or more
 * lines here must either refactor the file back under the limit or
 * re-justify this exception in this note.
 */
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

/** This flow's `safeReturnTo` fallback (parity with IncomeFormPage). */
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

  /** Optional discretionary glide. Edited via `DiscretionaryGlideFields`
   *  (rendered for any classification, gated only on a non-one-off
   *  frequency). Toggling the editor off persists `undefined` in
   *  BOTH canonical and scenario-patch mode. */
  discretionaryGlide?: DiscretionaryGlideOverride;
  /**
   * Whether this expense can be paid tax-free from an HSA.
   * Default `true` for new medical-category expenses (most medical costs
   * are qualified; premiums are the exception — the user turns it off).
   * Editing retains the value when the user moves to a non-medical category
   * and back; the engine ignores it for non-medical rows.
   * `stateFromPayload` maps an ABSENT legacy value to `false` (not the
   * new-expense default — conservative for imported rows).
   */
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
  // New medical expenses default to qualified (true) — most spending is
  // HSA-eligible; premiums are the exception the user turns off.
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

/**
 * Pure `FormState → ExpensePayload` assembly. Single source of
 * truth so the live form preview projects exactly what Save persists —
 * `onSubmit` calls this after its own name/category/amount/glide
 * validation (which stays in `onSubmit`, not here). The glide value is
 * retained even when the expense is essential because spending glides
 * apply to any non-one-off expense regardless of classification;
 * classification only gates the scenario-level discretionary adjustment
 * (`bumpPct`), not the glide.
 */
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
  // Persist hsaQualified only when true (absent ⇒ false,
  // so omitting false is semantically equivalent and keeps the payload sparse).
  // A once-set true is retained even on a non-medical-category row (the
  // engine ignores the flag there, so persisting is harmless).
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
    // Expense always carries an explicit memberId; legacy demo data
    // could theoretically omit it — fall back to primary so the form
    // doesn't crash on shape it didn't author.
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
  // Absent on a legacy/imported row → not qualified (false).
  // This is NOT the new-expense default (true) — conservative for existing data.
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
  // Scenario context: `/expenses/new?scenarioId=` → scenario-only add
  // (writes overrides.expenses.added[]); `/expenses/:id/edit?scenarioId=`
  // → scenario-patch mode (writes overrides.expenses.patches[id] with
  // only the changed keys, never the canonical aggregate). No scenario
  // param → canonical create / canonical edit (today's behaviour).
  const scenarioId = searchParams.get('scenarioId');
  // Scenario-only add-EDIT: `/expenses/scenario-entry?scenarioId=…&editLocalId=…`
  // re-opens an existing `added[]` entry (matched by `_localId`) in the
  // full form. Present → replace-by-`_localId` on Save; absent → append.
  const editLocalId = searchParams.get('editLocalId');
  const returnTo = searchParams.get('returnTo');

  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [categories, setCategories] = useState<Aggregate<ExpenseCategoryPayload>[]>([]);
  const [loadedExpense, setLoadedExpense] = useState<Aggregate<ExpensePayload> | null>(null);
  const [scenarioForAdd, setScenarioForAdd] = useState<Aggregate<ScenarioPayload> | null>(null);
  // Scenario-only add-edit: the `_localId` of the `added[]` entry being
  // re-edited. Null → append a fresh entry; set → replace in place.
  const [editingAddedLocalId, setEditingAddedLocalId] = useState<string | null>(null);
  // Scenario-patch edit mode: the scenario being patched + the resolved
  // expense payload the form opened with (the per-key delta baseline).
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
  // Bumped whenever the form re-seeds from a fresh resolved payload
  // (initial load, scenario-patch Reset). Drives the
  // `<DiscretionaryGlideFields key>` so an external reseed remounts the
  // glide editor with a fresh mode-aware seed, while in-progress
  // keystrokes (which never change this nonce) never remount it.
  const [seedNonce, setSeedNonce] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Reset mode-specific state at the START of every load so a
        // same-component route/query transition (e.g. add-edit → plain add)
        // doesn't carry stale mode state. These are otherwise only SET inside
        // conditional branches, never reset — leaving e.g. a stale
        // `editingAddedLocalId` that would make Save replace a row instead of
        // appending, or a stale `loadedExpense` that would route Save into
        // the update branch. Guarded by `active` like the rest of the effect.
        if (active) {
          // On a same-component query-only transition (e.g.
          // add-edit → plain add) `loading` was left `false` by the prior
          // load's `finally`, so the form body would render the OLD state
          // (mode flags already reset above) during the async reseed window
          // — a fast Save there could write stale data through the canonical
          // branch, or a stale load `error` could linger. Re-enter the
          // loading state (which gates the form body / Save) and clear any
          // stale error so the reseed window shows the skeleton, not a
          // stale-but-actionable form.
          setLoading(true);
          setError(null);
          setLoadedExpense(null);
          setScenarioForAdd(null);
          setEditingAddedLocalId(null);
          setScenarioForPatch(null);
          setOpenedResolved(null);
          setNameError(null);
          // Also clear the form data. The mode-flag reset above plus
          // `loading=true` is not enough — on a same-route query-only
          // transition to a MISSING editLocalId the load hits its not-found
          // early return (sets `error`, clears `loading` in `finally`) but
          // leaves the OLD `state` non-null, so the `!state && error` error
          // branch is masked and the stale form renders (and a Save would
          // route through the canonical branch with stale data). Clearing
          // state/baseline here makes the not-found path render the error and
          // is identical to a fresh mount on the success path (the loading
          // skeleton shows until the reseed completes).
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
          // Scenario-patch mode: pre-fill from the scenario-RESOLVED
          // expense (canonical + inherited/own patches per key) so the
          // form opens showing what this scenario actually projects;
          // Save then stores only the keys the user changes vs this
          // opened-resolved value.
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
            // Scenario-only add-edit: re-open an existing `added[]` entry
            // (matched by `_localId`) seeded with its stored payload; Save
            // replaces it in place. Missing entry → hard error (never
            // silently fall back to an append, which would orphan the row).
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

  // Already-retired heuristic: resolve the primary scenario's retirement
  // age, project the primary member's retirement year, and compare to
  // today. Used to surface the conditional Amount hint when the user
  // has already passed retirement — amounts are today's dollars, so
  // post-retirement users should enter what each expense costs today,
  // not what it cost when they retired.
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

  // Live single-expense preview. The first resolved state
  // paints immediately (no flash on edit-load); subsequent edits
  // recompute on a ~200 ms debounce so the money input doesn't churn
  // the projection per keystroke. The preview projects exactly what
  // Save persists via the shared `buildExpensePayload`.
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
  // Resolve under the form's TARGET scenario so the preview matches
  // what Save produces: scenario-patch → `scenarioForPatch`;
  // scenario-only add → `scenarioForAdd`; else the primary scenario.
  const previewTargetScenarioId =
    scenarioForPatch?.id ?? scenarioForAdd?.id ?? null;

  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  // A load-time error (expense / scenario / scenario-only entry not found)
  // leaves `state` null, so surface it instead of an endless skeleton —
  // the form body below only renders once a real state is seeded.
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
    // Scenario-only adds intentionally skip the canonical-collision
    // check — a scenario can carry an entry named "Vacation" alongside
    // a household-list "Vacation" without conflict (different
    // aggregates, different scopes). Collision still applies inside
    // the scenario's own added[] to avoid duplicates.
    if (scenarioForAdd) {
      const added = scenarioForAdd.payload.overrides.expenses?.added ?? [];
      // In add-edit mode the entry being edited is allowed to keep its own
      // name; only OTHER added entries collide.
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
    // Scenario-patch mode: name uniqueness is scoped to what THIS
    // scenario projects (the resolved list), not the canonical list —
    // the resolved list is what the scenario actually shows.
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

  /** Schedule-resolve context for save-time glide validation: the
   *  resolved scenario's retirement year + member birthdates. */
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
      // Mirror buildExpenseProjectionContext's two life-expectancy
      // fields exactly so canonical / scenario-patch / scenario-only-add
      // Save paths resolve a `lifetime`-bound `expenseEnd` identically
      // to the live preview/engine.
      lifeExpectancy,
      extendBeyondLifetime: false,
    };
  };

  // NOTE: `onSave` exceeds the 40-line shape limit. The scenario-patch
  // write algebra is extracted (`computeScenarioPatchSave` +
  // `buildScenarioExpensePatchWrite`); the residual length is
  // four inherently-distinct save branches (canonical create/update,
  // scenario-patch, scenario-only add) plus field validation and
  // post-save navigation, which cannot collapse without obscuring the
  // dispatch. A separate decomposition would be its own change.
  // No-arg (matches IncomeFormPage) so it can drive both the form's
  // submit event and the PageHeader Save action.
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
      // Pure assembly extracted to module scope so the live
      // preview below projects exactly what this Save persists.
      const payload = buildExpensePayload(state);

      // Glide validation. Runs whenever the glide is ENABLED on
      // any non-one-off expense (essential or discretionary) — i.e.
      // it is present — even when the
      // numbers currently form a value-equivalent no-op (a glide-end
      // before glide-start at the default 100% End is still a
      // mis-configuration the user must see). A cleared glide is now
      // `undefined` in BOTH canonical and scenario-patch mode (the editor
      // emits `undefined` when off; the scenario patch carries a `null`
      // clear-marker, not the old neutral object), so the
      // `state.discretionaryGlide &&` guard already skips an off glide
      // without a mode-specific sentinel.
      //
      // A one-off is never glided (the engine early-returns multiplier 1
      // for `frequency === 'oneOff'`, so a stored/inherited glide is
      // ignored). Validating that hidden, ignored glide would hard-block
      // Save on an unfixable error, so the block is skipped for one-offs
      // — exactly mirroring the `<DiscretionaryGlideFields>` render gate
      // (`state.frequency !== 'oneOff'`). One rule across Save + preview
      // + engine: a one-off is never glided and never glide-validated.
      if (state.frequency !== 'oneOff' && state.discretionaryGlide) {
        // Resolve the glide context under the form's target
        // scenario — scenario-patch → the patched scenario; scenario-
        // only add → the add-target; else the primary scenario. Mirrors
        // the preview's `previewTargetScenarioId` so Save and the inline
        // preview validate under the same scenario in all three modes.
        const glideCtx = buildGlideCtx(
          scenarioForPatch?.id ?? scenarioForAdd?.id ?? null,
        );
        // Resolve THIS expense's own start so `durationFromExpenseStart`
        // glide anchors validate against the real start, not a
        // retirement-year stand-in. Fall back to the retirement-year
        // probe when the start can't resolve (e.g. unresolvable `age`).
        const resolvedStart = resolveStartMonth(payload.start, glideCtx);
        const probe = resolvedStart ?? {
          year: Number.isFinite(glideCtx.retirementYear)
            ? glideCtx.retirementYear
            : 0,
          // Keep the resolved retirement *month* in the fallback so the
          // month-precise before-expense rule is evaluated correctly
          // for a mid-year retiree; only drop to 0 when the retirement
          // date itself can't resolve / month0 is absent.
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
        // Scenario-patch mode: write only the keys that changed vs the
        // opened-resolved value, merged into THIS scenario's
        // existing patch. Clearing an inherited optional emits
        // the `null` clear-marker, not key deletion. The
        // canonical aggregate is never touched.
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
        // Scenario-only add / add-edit — write into the scenario's
        // overrides.expenses.added[]. Add-edit (`editingAddedLocalId` set)
        // replaces the matching entry in place, keeping its `_localId` so
        // the row is updated, not duplicated; plain add appends a fresh one.
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
      // Use the guard's `navigateUnguarded` — `setBaseline` is async so
      // `isDirty` is still `true` at the moment `navigate()` fires; the
      // patched `pushState` would otherwise intercept the save path
      // and surface the Stay/Leave modal.
      navigateUnguarded(safeReturnTo(returnTo, RETURN_TO_FALLBACK));
    } catch {
      setError('Failed to save expense.');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Re-seed the form from the scenario-resolved expense after a write
   * that changed this scenario's patches (the whole-expense Reset). Refetches
   * scenarios, re-resolves THIS expense, and bumps `seedNonce` so the
   * glide editor remounts with a fresh mode-aware seed.
   */
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

  /**
   * Whole-expense reset: delete THIS scenario's entire patch
   * entry for this expense (every overridden key reverts to inherited
   * at once), then re-seed the form from the now fully-inherited
   * resolved value. Visible only in scenario-patch mode when this
   * scenario currently patches the expense.
   */
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
          // Reset overrides (scenario-patch mode only) sits left of Cancel
          // as the destructive (danger) header button.
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
            // Cancel is an intentional discard — bypass the dirty
            // guard per CODING_STANDARDS.md.
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
        {/* Two columns: the expense's identity + money shape on the left,
            when-it-happens + the spending glide on the right. The
            projection graph spans the full width below the grid. */}
        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-6 sm:grid-cols-2">
          {/* Column 1 — Name, Description (full-width rows), then
              Category | Frequency and Amount | Classification sharing rows. */}
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
                // Validate on blur (not only at Save) so a name collision or
                // empty name surfaces while the user is still here, not after
                // a round-trip from the Save button.
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

            {/* Essential vs discretionary is a binary CHOICE, not an on/off
                enablement, so it's a radio group (not a ToggleSwitch): neither
                value reads naturally as "off". (NOT a `<fieldset>`;
                labelled group instead.) */}
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

            {/* HSA-qualified toggle — visible only for medical-category
                rows. The value is retained across a non-medical
                detour; the engine ignores it for non-medical rows. */}
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

            {/* Projection graph under the left column's fields. */}
            <div className="col-span-2 min-w-0">
              <ExpenseProjectionPreview
                draft={previewDraft}
                members={members}
                scenarios={scenarios}
                targetScenarioId={previewTargetScenarioId}
              />
            </div>
          </div>

          {/* Column 2 — Start, End, and the spending glide (each its own
              row). Collapsible anchor cards keep this column compact; the
              `AnchorCardGroup` keeps only one open at a time. */}
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

              {/* Always-present polite live region: the glide section shows
                  for any non-one-off expense, so announce it to
                  assistive tech (content flips empty → message only when it
                  mounts — e.g. switching frequency away from one-off). */}
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

// The expense Start picker delegates to the shared `ScheduleAnchorPicker`
// (collapsible by default — same `<AnchorCard>` chrome it had before)
// via the `GlideAnchor ↔ ScheduleStart` bridge. The split `FormState`
// start fields are bridged at the value/onChange boundary; the persisted
// shape is unchanged. The personalized single-member age-radio label is
// preserved via the additive `ageLabel` prop; Expense always keeps
// `age.memberId` (no `ownerRole` / `memberSelectable` passed → defaults).
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
  // `describeEnd` returns a mid-sentence phrase ("until death of …");
  // capitalise the first letter for the standalone card summary.
  const endPhrase = describeEnd(buildEnd(state), members);
  const summary = endPhrase.charAt(0).toUpperCase() + endPhrase.slice(1);
  return (
  <AnchorCard
    label="End"
    summary={summary}
  >
    {/* Alignment grid: radios in column 1, their inputs in column 2 so
        the controls line up vertically. */}
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
        {/* User-facing N = stored offsetYears + 1 (1 = first year only,
            6 = first 6 years). Slider spans 1–30 retirement years. */}
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
        {/* Months/years is a two-value CHOICE, but this row lives inside the
            End `RadioGroup`, and a nested RadioGroup is invalid — so a small
            Select (showing both options) replaces the old switch, whose label
            only showed the current value and gave no hint which state was
            which. */}
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
