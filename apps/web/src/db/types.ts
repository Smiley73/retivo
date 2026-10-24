// Barrel over `db/types/`: add a new aggregate's types in their own file, re-export here and add to `PayloadByType`.
// Shared vocabulary lives in `aggregate-base.ts`; see AGENTS.md "Aggregate schema evolution — required companion edits".

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
