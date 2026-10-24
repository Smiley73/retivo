// The seven-aggregate batch every deterministic projection reads, shared by the Scenarios cards and the AI assistant tools so they see the app's numbers.
// Reads through `db/store`, not a hook, so it also works outside React.

import { listAggregates } from '../db/store';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

export interface ProjectionInputs {
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /** Threaded into the projections so the Scenarios cards apply the flag-derived +2pp medical-inflation default, else they diverge from the Balance Projection page. */
  readonly categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
}

/** Reads every aggregate the deterministic projection needs, in one batch. */
export async function loadProjectionInputs(): Promise<ProjectionInputs> {
  const [
    members,
    accounts,
    balances,
    expenses,
    incomeStreams,
    ssBenefits,
    categories,
  ] = await Promise.all([
    listAggregates('householdMember') as Promise<
      Aggregate<HouseholdMemberPayload>[]
    >,
    listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
    listAggregates('accountBalance') as Promise<
      Aggregate<AccountBalancePayload>[]
    >,
    listAggregates('expense') as Promise<Aggregate<ExpensePayload>[]>,
    listAggregates('incomeStream') as Promise<
      Aggregate<IncomeStreamPayload>[]
    >,
    listAggregates('socialSecurityBenefit') as Promise<
      Aggregate<SocialSecurityBenefitPayload>[]
    >,
    listAggregates('expenseCategory') as Promise<
      Aggregate<ExpenseCategoryPayload>[]
    >,
  ]);
  return {
    members,
    accounts,
    balances,
    expenses,
    incomeStreams,
    ssBenefits,
    categories,
  };
}
