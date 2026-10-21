/**
 * Pure logic behind the Expenses page "Add Medicare premiums" helper: build the
 * preview rows (one Part B and one Part D row per household member with a
 * birthdate), decide which rows look already entered, find fixed-name
 * collisions, and build the `ExpensePayload` for each row the person keeps.
 *
 * The helper only adds ordinary expenses; nothing links an expense to a person
 * or marks it as a premium. Duplicate detection is therefore a name heuristic
 * that stays visible in the preview rather than a silent filter. The written
 * rows are the same shape as the demo household's Medicare rows, so the
 * projection treats them like any Medical expense.
 */
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  HouseholdRole,
} from '../db/types';
import { medicalCategoryIdsFrom } from '../lib/expense-category-resolvers';
import { memberLabel } from '../lib/expense-format';
import { resolveExpensesForScenarioSparse } from '../lib/expense-override-resolution';
import {
  latestMedicarePremiums,
  type LatestMedicarePremiums,
} from '../lib/medicare-premiums';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

/** Query parameter that opens the preview when the Expenses page loads. */
export const MEDICARE_PREMIUMS_PARAM = 'medicarePremiums';

/** The Expenses page address that opens the preview on load. */
export const MEDICARE_PREMIUMS_URL = `/expenses?${MEDICARE_PREMIUMS_PARAM}=1`;

type MedicarePart = 'B' | 'D';

/** Same limit the expense form enforces on a name. */
const EXPENSE_NAME_MAX = 60;

/** Medicare starts at 65: the anchor every written row begins at. */
const MEDICARE_START_AGE_YEARS = 65;

/** An existing expense the preview points at, with the category it sits in. */
interface MatchedExpense {
  id: string;
  name: string;
  categoryName: string;
}

/** Why a row cannot be written. The helper never renames around any of them. */
export type PremiumBlock =
  | { kind: 'nameTaken'; expense: MatchedExpense }
  | { kind: 'nameRepeated' }
  | { kind: 'nameTooLong' };

export interface PremiumRow {
  /** Stable per row: `<member id>:<part>`. */
  key: string;
  memberId: string;
  role: HouseholdRole;
  memberLabel: string;
  part: MedicarePart;
  /** The exact name the helper would write. */
  expenseName: string;
  /** The built-in CMS monthly amount, before any edit. */
  monthly: number;
  /** Expenses whose name suggests this premium is already entered. */
  alreadyEntered: MatchedExpense[];
  block: PremiumBlock | null;
  /** On unless the row looks already entered or is blocked. */
  defaultIncluded: boolean;
}

export interface PremiumMemberGroup {
  memberId: string;
  label: string;
  /** True when the member has no usable birthdate, so no rows are offered. */
  missingBirthdate: boolean;
  rows: PremiumRow[];
}

export interface MedicarePremiumPreview {
  /** The CMS year the built-in amounts belong to. */
  year: number;
  /** The Medical category the rows would be written to; null when none exists. */
  medicalCategoryId: string | null;
  /** Empty when there is no Medical category. */
  members: PremiumMemberGroup[];
}

export interface PremiumPreviewInput {
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  /** Defaults to the newest year of the built-in snapshot. */
  premiums?: LatestMedicarePremiums;
}

/**
 * The expenses the selected scenario adds on top of the canonical list
 * (its own and its ancestors'), shaped as expense aggregates so the preview
 * checks them for an already-entered premium or a name clash like any other
 * expense. Scenario-only expenses are not in the canonical list, so without
 * this a premium entered only in a scenario would be added a second time.
 */
export function scenarioAddedExpenses(
  scenarioId: string,
  scenarios: ScenarioAggregate[],
): Aggregate<ExpensePayload>[] {
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) return [];
  return resolveExpensesForScenarioSparse(scenarioId, scenarios, [])
    .filter((e) => e.source === 'added')
    .map((e) => ({
      id: e.id,
      householdId: scenario.householdId,
      aggregateType: 'expense',
      schemaVersion: scenario.schemaVersion,
      version: 1,
      updatedAt: scenario.updatedAt,
      deviceId: scenario.deviceId,
      payload: e.payload,
    }));
}

/**
 * The expenses the preview checks for an already-entered premium: the
 * canonical list plus whatever the selected scenario adds on its own. The
 * effective scenario is the selected one, or the primary (base) when none is
 * picked or the pick is gone, as in the projection.
 */
export function premiumCheckExpenses(
  canonical: ReadonlyArray<Aggregate<ExpensePayload>>,
  scenarios: ReadonlyArray<ScenarioAggregate>,
  selectedScenarioId: string | null | undefined,
): ReadonlyArray<Aggregate<ExpensePayload>> {
  const effectiveId =
    selectedScenarioId && scenarios.some((s) => s.id === selectedScenarioId)
      ? selectedScenarioId
      : (scenarios.find((s) => s.payload.isPrimary)?.id ?? null);
  if (effectiveId === null) return canonical;
  return [
    ...canonical,
    ...scenarioAddedExpenses(effectiveId, scenarios as ScenarioAggregate[]),
  ];
}

/** Same case-folding and trimming the expense form applies to a name. */
const normalizeName = (name: string): string => name.trim().toLowerCase();

const hasBirthdate = (m: Aggregate<HouseholdMemberPayload>): boolean => {
  const raw = (m.payload.birthdate ?? '').trim();
  return raw !== '' && !Number.isNaN(Date.parse(raw));
};

const roleOf = (m: Aggregate<HouseholdMemberPayload>): HouseholdRole =>
  m.payload.isPrimary ? 'primary' : 'secondary';

/** Prefer the category named Medical, else the first medical-flagged one. */
function pickMedicalCategoryId(
  categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>,
): string | null {
  const ids = medicalCategoryIdsFrom(categories);
  if (ids.length === 0) return null;
  const named = ids.find((id) => {
    const cat = categories.find((c) => c.id === id);
    return normalizeName(cat?.payload.name ?? '') === 'medical';
  });
  return named ?? ids[0];
}

/**
 * Which premium rows a candidate expense name speaks to. `null` when the name
 * mentions neither Medicare nor a part. A named part matches that part only;
 * "Medicare" alone matches both.
 */
function partsNamedBy(name: string): ReadonlySet<MedicarePart> | null {
  const parts = new Set<MedicarePart>();
  if (/\bpart\s+b\b/i.test(name)) parts.add('B');
  if (/\bpart\s+d\b/i.test(name)) parts.add('D');
  if (parts.size > 0) return parts;
  if (/medicare/i.test(name)) return new Set<MedicarePart>(['B', 'D']);
  return null;
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsWholeWord = (text: string, word: string): boolean =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`,
    'iu',
  ).test(text);

/** The member an expense belongs to, or `null` when it cannot be told. */
function attributeToMember(
  expense: ExpensePayload,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string | null {
  const named = members.filter((m) => {
    const first = (m.payload.firstName ?? '').trim();
    return first !== '' && containsWholeWord(expense.name, first);
  });
  if (named.length === 1) return named[0].id;
  if (named.length > 1) return null;
  // An `age` anchor with no member id means the primary.
  const startRole =
    expense.start.kind === 'age' ? (expense.start.memberId ?? 'primary') : null;
  const endRole =
    expense.end?.kind === 'age' ? (expense.end.memberId ?? 'primary') : null;
  const role = startRole ?? endRole;
  if (role === null) return null;
  return members.find((m) => roleOf(m) === role)?.id ?? null;
}

interface Candidate {
  match: MatchedExpense;
  parts: ReadonlySet<MedicarePart>;
  /** `null` = ambiguous, shown on every member's rows. */
  memberId: string | null;
}

function findCandidates(
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  categoryNameById: ReadonlyMap<string, string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const e of expenses) {
    const parts = partsNamedBy(e.payload.name ?? '');
    if (!parts) continue;
    out.push({
      match: {
        id: e.id,
        name: e.payload.name,
        categoryName:
          categoryNameById.get(e.payload.categoryId) ?? '(unknown category)',
      },
      parts,
      memberId: attributeToMember(e.payload, members),
    });
  }
  return out;
}

/**
 * Build the preview: one Part B and one Part D row for every member with a
 * birthdate, a one-line explanation for members without one, and nothing
 * writable when the household has no Medical category.
 */
export function buildMedicarePremiumPreview(
  input: PremiumPreviewInput,
): MedicarePremiumPreview {
  const premiums = input.premiums ?? latestMedicarePremiums();
  const medicalCategoryId = pickMedicalCategoryId(input.categories);
  const base = { year: premiums.year, medicalCategoryId };
  if (medicalCategoryId === null) return { ...base, members: [] };

  const categoryNameById = new Map(
    input.categories.map((c) => [c.id, c.payload.name]),
  );
  const candidates = findCandidates(
    input.expenses,
    input.members,
    categoryNameById,
  );
  const expenseByName = new Map<string, MatchedExpense>();
  for (const e of input.expenses) {
    const key = normalizeName(e.payload.name ?? '');
    if (!expenseByName.has(key)) {
      expenseByName.set(key, {
        id: e.id,
        name: e.payload.name,
        categoryName:
          categoryNameById.get(e.payload.categoryId) ?? '(unknown category)',
      });
    }
  }

  // Primary first, so the preview reads in household order.
  const ordered = [...input.members].sort(
    (a, b) => Number(b.payload.isPrimary) - Number(a.payload.isPrimary),
  );
  const namesInPreview = new Set<string>();
  const members: PremiumMemberGroup[] = ordered.map((m) => {
    const role = roleOf(m);
    const label = memberLabel(m, input.members, role);
    if (!hasBirthdate(m)) {
      return { memberId: m.id, label, missingBirthdate: true, rows: [] };
    }
    const rows = (['B', 'D'] as const).map((part): PremiumRow => {
      const expenseName = `${label} Medicare Part ${part}`;
      const taken = expenseByName.get(normalizeName(expenseName));
      let block: PremiumBlock | null = null;
      if (taken) block = { kind: 'nameTaken', expense: taken };
      else if (expenseName.length > EXPENSE_NAME_MAX) {
        block = { kind: 'nameTooLong' };
      } else if (namesInPreview.has(normalizeName(expenseName))) {
        block = { kind: 'nameRepeated' };
      }
      namesInPreview.add(normalizeName(expenseName));
      const alreadyEntered = candidates
        .filter(
          (c) =>
            c.parts.has(part) && (c.memberId === null || c.memberId === m.id),
        )
        .map((c) => c.match);
      return {
        key: `${m.id}:${part}`,
        memberId: m.id,
        role,
        memberLabel: label,
        part,
        expenseName,
        monthly:
          part === 'B'
            ? premiums.partBStandardMonthly
            : premiums.partDNationalBaseMonthly,
        alreadyEntered,
        block,
        defaultIncluded: block === null && alreadyEntered.length === 0,
      };
    });
    return { memberId: m.id, label, missingBirthdate: false, rows };
  });
  return { ...base, members };
}

/** The include state a row has once the person's toggles are applied. */
export function isRowIncluded(
  row: PremiumRow,
  edits: Readonly<Record<string, boolean>>,
): boolean {
  if (row.block !== null) return false;
  return edits[row.key] ?? row.defaultIncluded;
}

/**
 * The expense a row writes: monthly, essential, HSA-eligible, from the
 * member's 65th birthday to the end of their life. Anchors name the member's
 * role, never an id.
 */
function buildPremiumPayload(
  row: PremiumRow,
  amount: number,
  categoryId: string,
): ExpensePayload {
  return {
    name: row.expenseName,
    amount: Math.round(amount * 100) / 100,
    frequency: 'monthly',
    classification: 'essential',
    categoryId,
    start: {
      kind: 'age',
      memberId: row.role,
      years: MEDICARE_START_AGE_YEARS,
      months: 0,
    },
    end: { kind: 'lifetime', whose: row.role },
    hsaQualified: true,
  };
}

/**
 * Payloads for exactly the rows the person kept: included, not blocked, with
 * any amount they edited. Empty without a Medical category.
 */
export function buildPremiumPayloads(
  preview: MedicarePremiumPreview,
  includeEdits: Readonly<Record<string, boolean>>,
  amountEdits: Readonly<Record<string, number>>,
): ExpensePayload[] {
  const categoryId = preview.medicalCategoryId;
  if (categoryId === null) return [];
  return preview.members
    .flatMap((g) => g.rows)
    .filter((row) => isRowIncluded(row, includeEdits))
    .map((row) =>
      buildPremiumPayload(row, amountEdits[row.key] ?? row.monthly, categoryId),
    );
}
