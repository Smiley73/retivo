/**
 * The seven-aggregate batch every deterministic projection reads, loaded in
 * one place. The Scenarios cards, the AI assistant tools and any later
 * consumer share it, so "the numbers the assistant sees are the numbers the
 * app shows" starts from the same rows. Reads IndexedDB through `db/store`
 * (never a hook), so it also works outside React.
 */
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
  /** Household expense categories — threaded into the deterministic +
   *  MC projections so the Scenarios cards apply the flag-derived +2pp
   *  medical-inflation default (else they diverge from BPP). */
  readonly categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
}

/** Read every aggregate the deterministic projection needs (one batch). */
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
