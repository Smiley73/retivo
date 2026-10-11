/**
 * Pure, throw-safe resolver that turns an un-synced mutation into a
 * human-readable label (friendly type + name) for the sync inspector list.
 *
 * Reads existing local IndexedDB state only — it changes no sync behaviour.
 * The resolved `name` is display-only: it is member/account/scenario PII in
 * this zero-knowledge app and MUST NOT reach any `console.*` / diagnostics
 * sink (the rejection log carries only a redaction-surviving id fragment).
 */
import type { AggregateType, PendingMutation } from '../db/types.js';
import { getAggregate } from '../db/store.js';

/**
 * Friendly type label for every `AggregateType`. Declared as a
 * `Record<AggregateType, string>` so a future new aggregate type fails
 * typecheck until it is labelled here.
 */
export const AGGREGATE_TYPE_LABEL: Record<AggregateType, string> = {
  household: 'Household',
  householdMember: 'Household member',
  account: 'Account',
  accountBalance: 'Account balance',
  socialSecurityBenefit: 'Social Security',
  scenario: 'Scenario',
  expenseCategory: 'Expense category',
  expense: 'Expense',
  incomeStream: 'Income',
};

export interface ResolvedMutationLabel {
  /** Friendly aggregate-type label. */
  typeLabel: string;
  /** Human name, or the raw aggregate id when it can't be resolved. */
  name: string;
  /** Optional secondary text (today: the account-balance year). */
  detail?: string;
}

/** Aggregate types whose human name is simply `payload.name`. */
const NAME_TYPES: ReadonlySet<AggregateType> = new Set<AggregateType>([
  'household',
  'scenario',
  'account',
  'expense',
  'incomeStream',
  'expenseCategory',
]);

/**
 * `getAggregate` that never throws: an IDB read error or a
 * `migrateAggregate` throw resolves to `null` so the caller falls back to the
 * raw id. `null` also covers the absent case (a delete-conflict whose local
 * aggregate is already gone). Deliberately not logged — the value it would
 * carry is display-only PII and the failure is inert for a label lookup.
 */
async function safeGet(type: AggregateType, id: string) {
  try {
    return await getAggregate(type, id);
  } catch {
    return null;
  }
}

/** Read a non-empty string field off a payload, else `null`. */
function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Join a first + last name, dropping absent halves. `null` when both absent. */
function fullName(payload: Record<string, unknown>): string | null {
  const parts = [stringField(payload, 'firstName'), stringField(payload, 'lastName')].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Resolve `{ typeLabel, name, detail? }` for one un-synced mutation. Always
 * safe to call — every failure path falls back to the raw aggregate id, so the
 * inspector never shows a blank or a broken row.
 */
export async function resolveMutationLabel(
  mutation: Pick<PendingMutation, 'aggregateType' | 'aggregateId'>,
): Promise<ResolvedMutationLabel> {
  const { aggregateType: type, aggregateId: id } = mutation;
  const typeLabel = AGGREGATE_TYPE_LABEL[type];

  if (NAME_TYPES.has(type)) {
    const agg = await safeGet(type, id);
    return { typeLabel, name: (agg && stringField(agg.payload, 'name')) ?? id };
  }

  if (type === 'householdMember') {
    const agg = await safeGet(type, id);
    return { typeLabel, name: (agg && fullName(agg.payload)) ?? id };
  }

  if (type === 'accountBalance') {
    // Resolve the owning account via the structured payload fields, NOT by
    // string-parsing the `bal-<accountId>-<year>` id (accountId is a dashed
    // UUID, so a naive split mis-parses).
    const balance = await safeGet('accountBalance', id);
    const accountId = balance && stringField(balance.payload, 'accountId');
    const year = balance && typeof balance.payload.year === 'number' ? balance.payload.year : null;
    if (accountId && year !== null) {
      const account = await safeGet('account', accountId);
      const accountName = account && stringField(account.payload, 'name');
      // Parent-absent (account gone) → raw-id fallback.
      if (accountName) return { typeLabel, name: accountName, detail: String(year) };
    }
    return { typeLabel, name: id };
  }

  if (type === 'socialSecurityBenefit') {
    const benefit = await safeGet('socialSecurityBenefit', id);
    const memberId = benefit && stringField(benefit.payload, 'householdMemberId');
    if (memberId) {
      const member = await safeGet('householdMember', memberId);
      if (member) {
        const name = fullName(member.payload);
        if (name) return { typeLabel, name };
      }
    }
    return { typeLabel, name: id };
  }

  // Unreachable — every `AggregateType` is handled above. The `NAME_TYPES`
  // set covers the remaining six via the first branch; this final return only
  // exists because `Set.has` does not narrow the union.
  return { typeLabel, name: id };
}
