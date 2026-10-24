// Throw-safe resolver turning an un-synced mutation into a label (friendly type + name) for the sync inspector.
// The name is display-only PII and must never reach `console.*` or any diagnostics sink (the rejection log keeps an id fragment).
import type { AggregateType, PendingMutation } from '../db/types.js';
import { getAggregate } from '../db/store.js';

/** Friendly label per `AggregateType`; the `Record` makes a new aggregate type fail typecheck until it is labelled. */
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
  typeLabel: string;
  /** Human name, or the raw aggregate id when it can't be resolved. */
  name: string;
  /** Optional secondary text (today: the account-balance year). */
  detail?: string;
}

const NAME_TYPES: ReadonlySet<AggregateType> = new Set<AggregateType>([
  'household',
  'scenario',
  'account',
  'expense',
  'incomeStream',
  'expenseCategory',
]);

// Never throws: an IDB read error, a `migrateAggregate` throw or an absent aggregate (a delete-conflict whose local row
// is gone) resolves to null so the caller falls back to the raw id. Not logged: the value is display-only PII.
async function safeGet(type: AggregateType, id: string) {
  try {
    return await getAggregate(type, id);
  } catch {
    return null;
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function fullName(payload: Record<string, unknown>): string | null {
  const parts = [stringField(payload, 'firstName'), stringField(payload, 'lastName')].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Resolves `{ typeLabel, name, detail? }` for one un-synced mutation; every failure falls back to the raw aggregate id,
 * so the inspector never shows a blank row.
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
    // Resolve the account from structured payload fields, not by splitting the `bal-<accountId>-<year>` id (accountId
    // is a dashed UUID).
    const balance = await safeGet('accountBalance', id);
    const accountId = balance && stringField(balance.payload, 'accountId');
    const year = balance && typeof balance.payload.year === 'number' ? balance.payload.year : null;
    if (accountId && year !== null) {
      const account = await safeGet('account', accountId);
      const accountName = account && stringField(account.payload, 'name');
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

  // Unreachable: the types above are exhaustive, but `Set.has` does not narrow the union.
  return { typeLabel, name: id };
}
