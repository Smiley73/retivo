/**
 * Per-aggregate domain types stored in IndexedDB. Mirrors the server
 * aggregate inventory in `packages/contracts`. Each aggregate type
 * carries its own payload shape; `Aggregate<T>` is the wrapper.
 *
 * Schema versions live alongside the per-type type definitions and the
 * migration registry — see `migrations.ts`.
 *
 * This module is a barrel over the per-aggregate files in `db/types/`, so
 * every existing `db/types` import site is unchanged. Add a new aggregate's
 * types in its own `db/types/<aggregate>.ts` file, re-export it below, and add
 * its payload to `PayloadByType`. The cross-aggregate shared vocabulary
 * (`AggregateType`, `Aggregate`, `PatchWithClears`, the schedule/anchor unions,
 * the local-only store shapes) lives in `db/types/aggregate-base.ts`.
 */

import type { HouseholdPayload, HouseholdMemberPayload } from './types/household';
import type { AccountPayload, AccountBalancePayload } from './types/account';
import type { SocialSecurityBenefitPayload } from './types/social-security';
import type { ScenarioPayload } from './types/scenario';
import type { ExpenseCategoryPayload, ExpensePayload } from './types/expense';
import type { IncomeStreamPayload } from './types/income';

export * from './types/aggregate-base';
export * from './types/household';
export * from './types/account';
export * from './types/social-security';
export * from './types/scenario-overrides';
export * from './types/scenario';
export * from './types/expense';
export * from './types/income';

// Map an aggregate type to its payload shape.
export interface PayloadByType {
  household: HouseholdPayload;
  householdMember: HouseholdMemberPayload;
  account: AccountPayload;
  accountBalance: AccountBalancePayload;
  socialSecurityBenefit: SocialSecurityBenefitPayload;
  scenario: ScenarioPayload;
  expenseCategory: ExpenseCategoryPayload;
  expense: ExpensePayload;
  incomeStream: IncomeStreamPayload;
}
