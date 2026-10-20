/**
 * The pure argument assembly behind the Balance Projection page's data load:
 * resolve the scenario, find the primary member and each member's retirement
 * date, count the accounts the runner will drop, and build the arguments (plus
 * the `canRun` guard) for `runBalanceProjectionForPage`. `loadPageData` is the
 * thin caller that runs the projection and maps rows; the AI assistant tools
 * call this same function so the resolved scenario and the runner arguments
 * they report are the ones the page runs on.
 */
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
  /** Household expense categories — the source for the flag-derived medical
   *  set. Omit to keep the legacy `cat-medical` default (back-compat for
   *  callers that don't load categories). */
  readonly categories?: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}

export interface PageProjectionAssembly {
  readonly resolved: ScenarioOverrides;
  /** Flag-derived medical category ids; absent when no category source was given. */
  readonly medicalCategoryIds: string[] | undefined;
  readonly primaryMember: Aggregate<HouseholdMemberPayload> | null;
  readonly memberRetirementById: Map<string, string | null>;
  readonly primaryRetirementAbsMonth: number | null;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  /** True when ≥1 active account has at least one balance row with a non-zero balance. */
  readonly hasAnyRealBalance: boolean;
  /** The runner needs a primary member, a resolved primary retirement date and an active account. */
  readonly canRun: boolean;
  readonly args: RunBalanceProjectionArgs;
}

/** Resolve the household's primary member and the per-member retirement
 *  dates, then derive the primary's retirement ISO date + its absolute-month
 *  index (`year * 12 + month0`) the page uses to anchor markers. Returns
 *  nulls when there is no primary or its retirement date is unresolved. */
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

/**
 * Does a balance row record an actual (non-zero) balance? For a MIXED-treatment
 * account the money can live only in the split fields, so we read
 * `startingBalancePreTax/PostTax` + `endingBalancePreTax/PostTax` with the
 * top-level `startingBalance`/`endingBalance` as a fallback. A row whose
 * every relevant balance field is 0 is NOT real — that includes the auto-$0
 * seed an account picks up at creation.
 */
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

/** Hidden-account footer counts (presentation only): inactive accounts and
 *  active accounts with no **non-zero** balance row (the runner drops both from
 *  `accountProjections`). Re-keyed from "no balance row at all" to "no non-zero
 *  balance row" so the NoAccountState vs NoHistoryState distinction stays
 *  correct once auto-$0 seed accounts always carry a row. Also surfaces
 *  the portfolio-level `hasAnyRealBalance` predicate the empty-state gate reads.
 *  Returned alongside the active-account list the caller uses to decide whether
 *  the runner has anything to project. */
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

/**
 * Resolve one scenario and assemble everything the page's deterministic
 * projection runs on. Throws when `selectedScenarioId` is not a scenario (the
 * resolver's own error), exactly as `loadPageData` always did.
 */
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
