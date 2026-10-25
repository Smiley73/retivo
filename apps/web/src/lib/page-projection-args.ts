// Argument assembly behind the Balance Projection page's data load, shared with the AI assistant tools so they report the resolved scenario and runner arguments the page runs on.

import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { RunBalanceProjectionArgs } from './balance-projection-runner';
import { medicalCategoryIdsFrom } from './expense-category-resolvers';
import { resolveMemberRetirementDates } from './retirement-date-math';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';

export interface PageProjectionInputs {
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly selectedScenarioId: string;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /** Source of the flag-derived medical set; omit for the `cat-medical` default. */
  readonly categories?: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}

export interface PageProjectionAssembly {
  readonly resolved: ScenarioOverrides;
  readonly medicalCategoryIds: string[] | undefined;
  readonly primaryMember: Aggregate<HouseholdMemberPayload> | null;
  readonly memberRetirementById: Map<string, string | null>;
  readonly primaryRetirementAbsMonth: number | null;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly hasAnyRealBalance: boolean;
  readonly canRun: boolean;
  readonly args: RunBalanceProjectionArgs;
}

function derivePrimaryRetirement(
  retirementAge: ScenarioOverrides['retirementAge'],
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): {
  readonly primaryMember: Aggregate<HouseholdMemberPayload> | null;
  readonly memberRetirementById: Map<string, string | null>;
  readonly primaryRetirementIso: string | null;
  readonly primaryRetirementAbsMonth: number | null;
} {
  const primaryMember = members.find((m) => m.payload.isPrimary) ?? null;
  const memberRetirementById = resolveMemberRetirementDates(
    retirementAge,
    members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate,
    })),
  );
  const primaryRetirementIso = primaryMember
    ? memberRetirementById.get(primaryMember.id) ?? null
    : null;
  const year = primaryRetirementIso
    ? Number(primaryRetirementIso.slice(0, 4))
    : null;
  const month0 = primaryRetirementIso
    ? Number(primaryRetirementIso.slice(5, 7)) - 1
    : null;
  return {
    primaryMember,
    memberRetirementById,
    primaryRetirementIso,
    primaryRetirementAbsMonth:
      year !== null && month0 !== null ? year * 12 + month0 : null,
  };
}

/** True when the row records a non-zero balance. MIXED money can live only in the split fields, so those are read too; the auto-$0 seed row is not real. */
function balanceRowIsReal(p: AccountBalancePayload): boolean {
  const candidates = [
    p.startingBalance,
    p.endingBalance,
    p.startingBalancePreTax ?? 0,
    p.startingBalancePostTax ?? 0,
    p.endingBalancePreTax ?? 0,
    p.endingBalancePostTax ?? 0,
  ];
  return candidates.some((v) => v !== 0);
}

/** Hidden-account footer counts: inactive accounts and active ones with no non-zero balance row, which the runner drops. Keyed on non-zero rows so seed accounts keep the NoAccountState and NoHistoryState distinction. */
function deriveHiddenAccountCounts(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
): {
  readonly activeAccounts: Aggregate<AccountPayload>[];
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly hasAnyRealBalance: boolean;
} {
  const realBalanceAccountIds = new Set(
    balances
      .filter((b) => balanceRowIsReal(b.payload))
      .map((b) => b.payload.accountId),
  );
  const activeAccounts = accounts.filter((a) => a.payload.active);
  return {
    activeAccounts,
    hiddenInactiveCount: accounts.length - activeAccounts.length,
    hiddenZeroHistoryCount: activeAccounts.filter(
      (a) => !realBalanceAccountIds.has(a.id),
    ).length,
    hasAnyRealBalance: activeAccounts.some((a) =>
      realBalanceAccountIds.has(a.id),
    ),
  };
}

/** Resolves one scenario and assembles what the page's deterministic projection runs on; throws when `selectedScenarioId` is not a scenario. */
export function assemblePageProjection(
  opts: PageProjectionInputs,
): PageProjectionAssembly {
  const { scenarios, selectedScenarioId, members, accounts, balances } = opts;
  const medicalCategoryIds = opts.categories
    ? medicalCategoryIdsFrom([...opts.categories])
    : undefined;
  const resolved = resolveScenario(selectedScenarioId, [...scenarios]);
  const {
    primaryMember,
    memberRetirementById,
    primaryRetirementIso,
    primaryRetirementAbsMonth,
  } = derivePrimaryRetirement(resolved.retirementAge, members);

  const {
    activeAccounts,
    hiddenInactiveCount,
    hiddenZeroHistoryCount,
    hasAnyRealBalance,
  } = deriveHiddenAccountCounts(accounts, balances);

  return {
    resolved,
    medicalCategoryIds,
    primaryMember,
    memberRetirementById,
    primaryRetirementAbsMonth,
    hiddenInactiveCount,
    hiddenZeroHistoryCount,
    hasAnyRealBalance,
    canRun: Boolean(
      primaryMember &&
        primaryRetirementIso &&
        resolved.retirementAge &&
        activeAccounts.length > 0,
    ),
    args: {
      scenarioId: selectedScenarioId,
      scenarios: [...scenarios],
      accounts: [...accounts],
      balances: [...balances],
      members: [...members],
      ssBenefits: [...opts.ssBenefits],
      expenses: [...opts.expenses],
      incomeStreams: [...opts.incomeStreams],
      todayYear: opts.todayYear,
      todayMonthIndex: opts.todayMonthIndex,
      method: 'planned',
      ...(medicalCategoryIds ? { medicalCategoryIds } : {}),
    },
  };
}
