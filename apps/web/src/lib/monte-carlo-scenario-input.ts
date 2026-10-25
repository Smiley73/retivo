/** Builds the `MonteCarloInput` the Plan Stress Test feeds the worker, so a `computeCacheKey` derived from it matches the page's cache entry.
 * Returns `null` when the scenario cannot run MC. */
import {
  resolveScenario,
  type ScenarioAggregate,
} from './scenario-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import {
  runBalanceProjectionMc,
  CbpUnconfiguredError,
  NoPrimaryRetirementError,
} from './balance-projection-runner';
import type { RunBalanceProjectionArgs } from './balance-projection-runner-types';
import type { MonteCarloInput } from './monte-carlo';
import type { GuardrailConfig } from './guardrails';
import { applyStress, type StressCaseId } from './market-stress';
import { medicalCategoryIdsFrom } from './expense-category-resolvers';
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

/** Plan Stress Test path count; shared so the card and the Scenarios-list cache read hash the same `pathCount`. */
export const MC_PATH_COUNT = 10_000;

export interface ScenarioMcInputs {
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /** Source of the flag-derived medical set; omitted falls back to the `cat-medical` default. */
  readonly categories?: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
}

/**
 * Builds the input the page would feed the worker for `scenarioId`, or `null` when the scenario can't run MC
 * (no resolvable primary retirement, no active account, unconfigured CBP). Calls `runBalanceProjectionMc` and
 * overrides `pathCount` with `MC_PATH_COUNT`, so the cache key (which excludes `seed`) matches the page's.
 */
export function buildMonteCarloInputForScenario(opts: {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly inputs: ScenarioMcInputs;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  /** Forces the guardrail baseline series for this config regardless of the stored `enabled` flag; only the Guardrails page passes it. */
  readonly guardrailOverrideConfig?: GuardrailConfig;
  /** Overlays a named stress case on the base input (fee/return/inflation shocks, age-105-capped horizon) with the same seed, so base and stress share paths. */
  readonly marketStressCase?: StressCaseId;
}): MonteCarloInput | null {
  const { scenarioId, scenarios, inputs, todayYear, todayMonthIndex } = opts;
  let resolved;
  try {
    resolved = resolveScenario(scenarioId, [...scenarios]);
  } catch {
    return null;
  }
  if (!resolved.retirementAge) return null;

  const primaryMember = inputs.members.find((m) => m.payload.isPrimary) ?? null;
  if (!primaryMember) return null;

  const retirementById = resolveMemberRetirementDates(
    resolved.retirementAge,
    inputs.members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate,
    })),
  );
  const primaryIso = retirementById.get(primaryMember.id) ?? null;
  if (!primaryIso) return null;

  const activeAccounts = inputs.accounts.filter((a) => a.payload.active);
  if (activeAccounts.length === 0) return null;

  const runArgs: RunBalanceProjectionArgs = {
    scenarioId,
    scenarios: [...scenarios],
    accounts: [...inputs.accounts],
    balances: [...inputs.balances],
    members: [...inputs.members],
    ssBenefits: [...inputs.ssBenefits],
    expenses: [...inputs.expenses],
    incomeStreams: [...inputs.incomeStreams],
    todayYear,
    todayMonthIndex,
    method: 'planned',
    ...(inputs.categories
      ? { medicalCategoryIds: medicalCategoryIdsFrom([...inputs.categories]) }
      : {}),
  };

  try {
    const mcInput = runBalanceProjectionMc(
      runArgs,
      opts.guardrailOverrideConfig !== undefined
        ? { guardrailOverrideConfig: opts.guardrailOverrideConfig }
        : undefined,
    );
    const base: MonteCarloInput = { ...mcInput, pathCount: MC_PATH_COUNT };
    if (opts.marketStressCase === undefined) return base;
    // The age-105 horizon cap anchors on the youngest member (latest birth year).
    const birthYears = inputs.members
      .map((m) => {
        const iso = m.payload.birthdate;
        const y = iso ? Number(iso.slice(0, 4)) : NaN;
        return Number.isFinite(y) ? y : null;
      })
      .filter((y): y is number => y !== null);
    if (birthYears.length === 0) return base;
    const longestLivedBirthYear = Math.max(...birthYears);
    return applyStress(base, opts.marketStressCase, { longestLivedBirthYear });
  } catch (e) {
    // Unconfigured CBP or no primary retirement means no MC, as on the page; any other throw degrades to "—" instead of crashing the list.
    if (e instanceof CbpUnconfiguredError || e instanceof NoPrimaryRetirementError) {
      return null;
    }
    return null;
  }
}
