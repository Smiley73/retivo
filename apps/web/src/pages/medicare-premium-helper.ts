/** Pure logic behind the Expenses page "Add Medicare premiums" helper: preview rows, already-entered detection, name collisions and the ExpensePayload per kept row.
* Duplicate detection is a name heuristic shown in the preview, never a filter, since nothing links an expense to a person. */
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
import { latestMedicarePremiums } from '../lib/medicare-premiums';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

/** Query parameter that opens the preview when the Expenses page loads. */
export const MEDICARE_PREMIUMS_PARAM = 'medicarePremiums';

/** The Expenses page address that opens the preview on load. */
export const MEDICARE_PREMIUMS_URL = `/expenses?${MEDICARE_PREMIUMS_PARAM}=1`;

type MedicarePart = 'B' | 'D';

const EXPENSE_NAME_MAX = 60;

const MEDICARE_START_AGE_YEARS = 65;

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
  key: string;
  memberId: string;
  role: HouseholdRole;
  memberLabel: string;
  part: MedicarePart;
  expenseName: string;
  monthly: number;
  alreadyEntered: MatchedExpense[];
  block: PremiumBlock | null;
  defaultIncluded: boolean;
}

export interface PremiumMemberGroup {
  memberId: string;
  label: string;
  missingBirthdate: boolean;
  rows: PremiumRow[];
}

export interface MedicarePremiumPreview {
  year: number;
  medicalCategoryId: string | null;
  members: PremiumMemberGroup[];
}

export interface PremiumPreviewInput {
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
}

function scenarioExpenses(
  scenarioId: string,
  scenarios: ScenarioAggregate[],
  canonical: ReadonlyArray<Aggregate<ExpensePayload>>,
): Aggregate<ExpensePayload>[] {
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) return [];
  const byId = new Map(canonical.map((c) => [`aggregate:${c.id}`, c]));
  const out: Aggregate<ExpensePayload>[] = [];
  for (const e of resolveExpensesForScenarioSparse(scenarioId, scenarios, canonical)) {
    if (e.source === 'added') {
      out.push({
        id: e.id,
        householdId: scenario.householdId,
        aggregateType: 'expense',
        schemaVersion: scenario.schemaVersion,
        version: 1,
        updatedAt: scenario.updatedAt,
        deviceId: scenario.deviceId,
        payload: e.payload,
      });
    } else if (e.source === 'patched') {
      const original = byId.get(e.id);
      if (
        original &&
        normalizeName(e.payload.name ?? '') !== normalizeName(original.payload.name ?? '')
      ) {
        out.push({ ...original, payload: e.payload });
      }
    }
  }
  return out;
}

/**
 * The expenses the preview checks: the canonical list, the rows the effective
 * scenario renames, and the rows it adds. The effective scenario is the selected
 * one, else the primary, as in the projection.
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
  return [...canonical, ...scenarioExpenses(effectiveId, scenarios as ScenarioAggregate[], canonical)];
}

const normalizeName = (name: string): string => name.trim().toLowerCase();

const hasBirthdate = (m: Aggregate<HouseholdMemberPayload>): boolean => {
  const raw = (m.payload.birthdate ?? '').trim();
  return raw !== '' && !Number.isNaN(Date.parse(raw));
};

const roleOf = (m: Aggregate<HouseholdMemberPayload>): HouseholdRole =>
  m.payload.isPrimary ? 'primary' : 'secondary';

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

// Which premium rows a candidate expense name speaks to. `null` when the name
// mentions neither Medicare nor a part. A named part matches that part only;
// "Medicare" alone matches both.
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
  toMatch: (e: Aggregate<ExpensePayload>) => MatchedExpense,
): Candidate[] {
  const out: Candidate[] = [];
  for (const e of expenses) {
    const parts = partsNamedBy(e.payload.name ?? '');
    if (!parts) continue;
    out.push({ match: toMatch(e), parts, memberId: attributeToMember(e.payload, members) });
  }
  return out;
}

/** One Part B and one Part D row per member with a birthdate; nothing writable
 *  without a Medical category. */
export function buildMedicarePremiumPreview(
  input: PremiumPreviewInput,
): MedicarePremiumPreview {
  const premiums = latestMedicarePremiums();
  const medicalCategoryId = pickMedicalCategoryId(input.categories);
  const base = { year: premiums.year, medicalCategoryId };
  if (medicalCategoryId === null) return { ...base, members: [] };

  const categoryNameById = new Map(
    input.categories.map((c) => [c.id, c.payload.name]),
  );
  const toMatch = (e: Aggregate<ExpensePayload>): MatchedExpense => ({
    id: e.id,
    name: e.payload.name,
    categoryName: categoryNameById.get(e.payload.categoryId) ?? '(unknown category)',
  });
  const candidates = findCandidates(input.expenses, input.members, toMatch);
  const expenseByName = new Map<string, MatchedExpense>();
  for (const e of input.expenses) {
    const key = normalizeName(e.payload.name ?? '');
    if (!expenseByName.has(key)) expenseByName.set(key, toMatch(e));
  }

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

export function isRowIncluded(
  row: PremiumRow,
  edits: Readonly<Record<string, boolean>>,
): boolean {
  if (row.block !== null) return false;
  return edits[row.key] ?? row.defaultIncluded;
}

// Monthly, essential, HSA-eligible, from the member's 65th birthday for life;
// anchors name the member's role, never an id.
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
