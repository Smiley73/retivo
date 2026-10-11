/**
 * Active aggregate types served by sync pull / bootstrap.
 *
 * The MutationLog stores `aggregateType` as a free-form string, so rows
 * for retired types (e.g. the removed `plan` type) linger after a
 * deploy. Returning them to the client breaks IndexedDB writes —
 * `STORE_BY_TYPE['plan']` is undefined, so `db.transaction(undefined)`
 * throws "object stores was not found" and the cursor stalls forever.
 *
 * Egress filter: pull + bootstrap skip rows whose type isn't in this
 * set, with a one-line log so retired-type drift is observable. The
 * client mirrors with its own warn-and-skip in SyncContext as
 * defense-in-depth — neither side trusts the other's inventory.
 *
 * Ingress filter (sync/push): `PushMutationDto.aggregateType` is
 * validated against this list via `@IsIn(...)` so the API refuses to
 * write retired or unknown types into `MutationLog` / `AggregateVersion`
 * in the first place. The list is exported separately from the Set
 * because class-validator's `@IsIn(...)` needs an array literal.
 *
 * SINGLE SOURCE: `ACTIVE_AGGREGATE_TYPES_LIST` lives in `@retirement/contracts`
 * and is re-exported here for the API's own consumers (the web re-exports the
 * same union from `apps/web/src/db/types.ts`), so the inventory is defined
 * exactly once for both apps. `AggregateType` itself stays internal to this
 * file — this module's own drift-check is its only current consumer.
 */
import {
  ACTIVE_AGGREGATE_TYPES_LIST,
  type AggregateType,
} from '@retirement/contracts';

export { ACTIVE_AGGREGATE_TYPES_LIST };

/**
 * Compile-time drift sentinel — the API-side half of the single-source
 * guarantee. This file is the API's only consumer of the shared inventory, and
 * its runtime consumers (`@IsIn`, the `Set` below) are value-level, so nothing
 * else here would fail typecheck if `@retirement/contracts` gained or dropped a
 * member. This assertion couples the API to the shared union: a member
 * added/removed in the contract that this list of names doesn't match fails
 * `pnpm --filter @retirement/api typecheck` right here, forcing a conscious
 * update (it is the drift-detection proof's API-side tripwire). It is
 * type-only — the single `true` erases at runtime and defines no aggregate
 * inventory of its own.
 */
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
