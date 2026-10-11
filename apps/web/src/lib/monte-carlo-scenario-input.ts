/**
 * Hook-free helper that builds the SAME `MonteCarloInput` the Balance
 * Projection page's Plan Stress Test card feeds the worker for a given
 * scenario — so a `computeCacheKey` derived from it matches the entry the
 * BPP page wrote (or vice-versa).
 *
 * Correctness contract (the key risk for the Scenarios list's cache-read
 * plan-success):
 *
 *   The BPP card's run input is, verbatim (PlanStressTestSection.tsx):
 *     `run({ ...runBalanceProjectionMc(runArgs), pathCount: MC_PATH_COUNT, seed })`
 *   and `MonteCarloProvider.computeCacheKey` hashes that input with `seed`
 *   and `onProgress` excluded — i.e. it hashes
 *     `{ ...runBalanceProjectionMc(runArgs), pathCount: MC_PATH_COUNT }`.
 *
 *   This helper reproduces exactly that: it calls the SAME
 *   `runBalanceProjectionMc(runArgs)` (which stamps the optimizer's
 *   `pathCount: 1000` / `seed: 1` defaults) and overrides `pathCount` with
 *   the shared `MC_PATH_COUNT`. The `seed` is irrelevant to the cache key,
 *   so we leave the runner's default seed in place. No field of the
 *   assembly is approximated — `runBalanceProjectionMc` is the single
 *   source of truth both call.
 *
 * Returns `null` when the scenario cannot run MC: no resolvable primary
 * retirement, no active accounts, or unconfigured CBP elections (the same
 * gates the BPP page applies before building `mcInput`). A `null` means the
 * card shows "—" with no "Recalculate" affordance (there is nothing to run).
 */
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

/**
 * Path count used for the Balance Projection page's Plan Stress Test MC
 * run. Centralised here (was a module-local const in
 * `PlanStressTestSection`) so the BPP card and the Scenarios-list
 * cache-read helper hash the SAME `pathCount` — a mismatch would change
 * the cache key and silently turn every list read into a miss.
 */
export const MC_PATH_COUNT = 10_000;

/** Aggregate inputs the projection runner needs — the same batch the
 *  Scenarios metrics hook already loads once for the deterministic
 *  ending-balance + sparkline. */
export interface ScenarioMcInputs {
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /** Household expense categories — the source for the flag-derived medical
   *  set. Without it the Scenarios-page MC cards would fall to the legacy
   *  default and diverge from BPP. Omit ⇒ legacy `cat-medical` default. */
  readonly categories?: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
}

/**
 * Build the `MonteCarloInput` the BPP page would feed the worker for
 * `scenarioId`, or `null` when the scenario can't run MC.
 *
 * Mirrors the view-model's `runArgs` gate (use-balance-projection-view-model
 * ~line 303): require a resolvable primary retirement + ≥1 active account.
 * Then defers entirely to `runBalanceProjectionMc` for the assembly and
 * stamps the shared `MC_PATH_COUNT` on top (parity contract, see file head).
 */
export function buildMonteCarloInputForScenario(opts: {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly inputs: ScenarioMcInputs;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  /** Live-advisory guardrail override: forces the funded-
   *  ratio baseline series to be computed for this config regardless of the
   *  scenario's stored `enabled` flag. Only the Guardrails page passes it; the
   *  Scenarios-list callers omit it and are unaffected. */
  readonly guardrailOverrideConfig?: GuardrailConfig;
  /**
   * Named market-stress case to overlay on the assembled BASE input. Absent →
   * the base plan, which carries NO investment cost and no stress lever. When
   * present, the returned input carries the case's fee/return/inflation shocks
   * and the age-105-capped longevity horizon — using the SAME seed, so a
   * base-vs-stress comparison shares random paths.
   */
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
    // SINGLE SOURCE OF TRUTH: same assembly the BPP card uses, then the
    // identical `pathCount` override the BPP call-site applies. `seed` is
    // excluded from the cache key, so the runner's default seed is fine.
    // Forward the live-advisory override when supplied.
    const mcInput = runBalanceProjectionMc(
      runArgs,
      opts.guardrailOverrideConfig !== undefined
        ? { guardrailOverrideConfig: opts.guardrailOverrideConfig }
        : undefined,
    );
    const base: MonteCarloInput = { ...mcInput, pathCount: MC_PATH_COUNT };
    if (opts.marketStressCase === undefined) return base;
    // Overlay the named stress on the base input. The age-105 longevity cap
    // anchors on the YOUNGEST member (latest birth year), whose age-105 year is
    // the last the horizon must span.
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
    // CBP-unconfigured / no-primary-retirement → no MC for this scenario
    // (BPP short-circuits the same cases). Any other throw is a real
    // pipeline bug, but on the read-only list we degrade to "—" rather
    // than crashing the whole card list.
    if (e instanceof CbpUnconfiguredError || e instanceof NoPrimaryRetirementError) {
      return null;
    }
    return null;
  }
}
