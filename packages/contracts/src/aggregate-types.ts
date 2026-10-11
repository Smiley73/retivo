/**
 * The active aggregate inventory served by sync pull / bootstrap and accepted by
 * sync push — the SINGLE source of truth shared by both apps.
 *
 * `apps/api/src/sync/aggregate-types.ts` re-exports `ACTIVE_AGGREGATE_TYPES_LIST`
 * (its class-validator `@IsIn(...)` reads the array literal, and its egress /
 * ingress filters build a `Set` from it); `apps/web/src/db/types.ts` re-exports
 * the derived `AggregateType` union. Adding / removing a type here updates both
 * apps at once — neither keeps a hand-maintained local copy.
 *
 * The list is `as const` so the union is derived from it and the two can never
 * drift: the array literal is what class-validator needs at runtime, the union
 * is what the store / migrations / sync typing need at compile time.
 */
export const ACTIVE_AGGREGATE_TYPES_LIST = [
  'household',
  'householdMember',
  'account',
  'accountBalance',
  'socialSecurityBenefit',
  'scenario',
  'expenseCategory',
  'expense',
  'incomeStream',
] as const;

/** One active aggregate type, derived from {@link ACTIVE_AGGREGATE_TYPES_LIST}. */
export type AggregateType = (typeof ACTIVE_AGGREGATE_TYPES_LIST)[number];
