// Active aggregate types served by pull and bootstrap, and accepted by push.
// The MutationLog keeps retired types after a deploy; returning one to the client breaks the IndexedDB write and stalls the cursor.
import {
  ACTIVE_AGGREGATE_TYPES_LIST,
  type AggregateType,
} from '@retirement/contracts';

export { ACTIVE_AGGREGATE_TYPES_LIST };

// Compile-time tripwire: fails typecheck if `@retirement/contracts` gains or drops a member this list of names does not match.
type ExpectedAggregateType =
  | 'household'
  | 'householdMember'
  | 'account'
  | 'accountBalance'
  | 'socialSecurityBenefit'
  | 'scenario'
  | 'expenseCategory'
  | 'expense'
  | 'incomeStream';
type AggregateInventoryInSync = [
  Exclude<AggregateType, ExpectedAggregateType>,
  Exclude<ExpectedAggregateType, AggregateType>,
] extends [never, never]
  ? true
  : never;
const _aggregateInventoryInSync: AggregateInventoryInSync = true;
void _aggregateInventoryInSync;

const ACTIVE_AGGREGATE_TYPES = new Set<AggregateType>(
  ACTIVE_AGGREGATE_TYPES_LIST,
);

export function isActiveAggregateType(type: string): boolean {
  return ACTIVE_AGGREGATE_TYPES.has(type as AggregateType);
}
