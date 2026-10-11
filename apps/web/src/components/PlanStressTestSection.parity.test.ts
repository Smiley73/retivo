/**
 * Seed-pinned MC parity test for the Plan Stress Test card.
 *
 * Drives the same input-building + MC-orchestration path
 * `PlanStressTestSection` uses (`runBalanceProjectionMc(runArgs)` →
 * `runMonteCarlo({ ...input, pathCount: PATH_COUNT, seed:
 * seedFromString(scenarioId) })`) against the demo dataset for every
 * scenario; asserts the resulting percentiles match the
 * captured fixture via `expectPracticalEqual`.
 *
 * The fixture (`apps/web/src/pages/__fixtures__/bpp-parity-mc-demo-dataset.json`)
 * is regenerated via the `describe.skip` capture suite at
 * `apps/web/src/test/capture-bpp-parity-mc-fixture.test.ts` — see that
 * file's header for the un-skip → run → re-skip → commit flow.
 *
 * Anchor: pinned to `todayYear: 2026, todayMonthIndex: 4` (May 2026 —
 * numbers-only API; no `Date` reaches the runner).
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fixtureJson from '../pages/__fixtures__/bpp-parity-mc-demo-dataset.json';
import { clearAllStores, listAggregates } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { runBalanceProjectionMc } from '../lib/balance-projection-runner';
import { ENGINE_VERSION, runMonteCarlo, type MonteCarloInput, type MonteCarloSummary } from '../lib/monte-carlo';
import { seedFromString } from '../lib/sfc32';
import { expectPracticalEqual } from '../test/expect-practical-equal';
import {
  applyStress,
  applyReturnCostInflationShocks,
  computeStressDelta,
  extendHorizon,
  resolveStressHorizonYear,
  STRESS_CASE_IDS,
  STRESS_CASES,
  STRESS_MAX_AGE,
} from '../lib/market-stress';
import { MAX_AGE } from '../db/types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

interface ScenarioPercentiles {
  readonly scenarioId: string;
  readonly firstYear: number;
  readonly horizonYears: number;
  readonly successProbability: number;
  readonly p10Real: number[];
  readonly p25Real: number[];
  readonly p50Real: number[];
  readonly medianDepletionYear: number | null;
}

interface McFixture {
  readonly anchor: { todayYear: number; todayMonthIndex: number };
  readonly pathCount: number;
  readonly engineVersion: number;
  readonly scenarios: ReadonlyArray<ScenarioPercentiles>;
}

const fixture = fixtureJson as McFixture;

describe('PlanStressTestSection — seed-pinned MC parity against demo-dataset fixture', () => {
  beforeAll(async () => {
    await clearAllStores();
    await loadDemoData({
      householdId: 'parity-mc',
      email: 'parity@example.test',
      displayName: 'Parity User',
      todayYear: fixture.anchor.todayYear,
    });
  });

  afterEach(async () => {
    // Keep demo data loaded for every test in this suite — clear only
    // at the end (no afterAll cleanup body needed; vitest's
    // worker-namespaced fake-indexeddb gets torn down by the harness).
  });

  // 1,000 paths per scenario, seed-pinned — bit-identity is path-count
  // independent; see the capture file for why the fixture is reduced.
  it('matches every demo-scenario percentile + success-probability + median-depletion year',
  { timeout: process.env.VITEST_COVERAGE === '1' ? 60_000 : 20_000 }, async () => {
    const [
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits,
      expenses,
      incomeStreams,
    ] = await Promise.all([
      listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
      listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
      listAggregates('accountBalance') as Promise<
        Aggregate<AccountBalancePayload>[]
      >,
      listAggregates('householdMember') as Promise<
        Aggregate<HouseholdMemberPayload>[]
      >,
      listAggregates('socialSecurityBenefit') as Promise<
        Aggregate<SocialSecurityBenefitPayload>[]
      >,
      listAggregates('expense') as Promise<Aggregate<ExpensePayload>[]>,
      listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
    ]);

    // Fixture must be current — regenerate via capture-bpp-parity-mc-fixture.test.ts if this fails.
    expect(fixture.engineVersion).toBe(ENGINE_VERSION);

    expect(scenarios.length).toBe(fixture.scenarios.length);

    for (const expectedRow of fixture.scenarios) {
      const scenario = scenarios.find((s) => s.id === expectedRow.scenarioId);
      expect(
        scenario,
        `demo scenario missing for fixture row ${expectedRow.scenarioId}`,
      ).toBeDefined();
      if (!scenario) continue;
      const input = runBalanceProjectionMc({
        scenarioId: scenario.id,
        scenarios,
        accounts,
        balances,
        members,
        ssBenefits,
        expenses,
        incomeStreams,
        todayYear: fixture.anchor.todayYear,
        todayMonthIndex: fixture.anchor.todayMonthIndex,
      });
      const summary = runMonteCarlo({
        ...input,
        pathCount: fixture.pathCount,
        seed: seedFromString(scenario.id),
      });

      expect(summary.firstYear).toBe(expectedRow.firstYear);
      expect(summary.horizonYears).toBe(expectedRow.horizonYears);
      expect(summary.medianDepletionYear).toBe(expectedRow.medianDepletionYear);
      // Percentiles + success-prob: practical tolerance.
      expectPracticalEqual(summary.successProbability, expectedRow.successProbability);
      expectPracticalEqual(summary.percentilesReal.p10, expectedRow.p10Real);
      expectPracticalEqual(summary.percentilesReal.p25, expectedRow.p25Real);
      expectPracticalEqual(summary.percentilesReal.p50, expectedRow.p50Real);
    }

    await clearAllStores();
  });
});

/**
 * Market-stress core — same-path stress transform properties.
 *
 * Builds one base `MonteCarloInput` from the demo dataset, then exercises the
 * pure `market-stress.ts` transforms + the engine's new fee/return/inflation/
 * longevity levers: IDENTITY (no-op shock is byte-identical), ISOLATION (each
 * lever moves output on its own), SAME PATHS (seed/first-year unchanged; a
 * zero-magnitude overlay reproduces the base bit-for-bit), and MONOTONICITY
 * (each adverse shock never raises the success probability). Uses a reduced
 * path count for speed — direction, not the frozen fixture magnitudes, is what
 * these assert.
 */
describe('market-stress-core — same-path stress transforms', () => {
  /** Budget for the multi-run MC tests below. v8 instrumentation roughly doubles
   *  each 800-path run, and a fully parallel local coverage run (maxWorkers is
   *  CI-only) adds CPU contention on top — measured 13.1s
   *  against the old flat 10s budget, so these two failed under coverage on main
   *  regardless of what changed. Non-coverage runs keep the tight 10s budget so
   *  a genuine hang still fails fast. Mirrors the coverage-aware timeout on this
   *  file's first test. */
  const MC_TEST_TIMEOUT_MS = process.env.VITEST_COVERAGE === '1' ? 60_000 : 10_000;
  const PATHS = 800;
  const SEED = 1234567;
  let base: MonteCarloInput;
  let baseSummary: MonteCarloSummary;
  let longestLivedBirthYear: number;

  beforeAll(async () => {
    await clearAllStores();
    await loadDemoData({
      householdId: 'stress-mc',
      email: 'stress@example.test',
      displayName: 'Stress User',
      todayYear: fixture.anchor.todayYear,
    });
    const [scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams] =
      await Promise.all([
        listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
        listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
        listAggregates('accountBalance') as Promise<Aggregate<AccountBalancePayload>[]>,
        listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
        listAggregates('socialSecurityBenefit') as Promise<
          Aggregate<SocialSecurityBenefitPayload>[]
        >,
        listAggregates('expense') as Promise<Aggregate<ExpensePayload>[]>,
        listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
      ]);
    const target = fixture.scenarios[0].scenarioId;
    const built = runBalanceProjectionMc({
      scenarioId: target,
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits,
      expenses,
      incomeStreams,
      todayYear: fixture.anchor.todayYear,
      todayMonthIndex: fixture.anchor.todayMonthIndex,
      method: 'planned',
    });
    base = { ...built, pathCount: PATHS, seed: SEED };
    baseSummary = runMonteCarlo({ ...base, seed: SEED, pathCount: PATHS });
    longestLivedBirthYear = Math.max(
      ...members.map((m) => Number(m.payload.birthdate.slice(0, 4))),
    );
  });

  afterEach(async () => {
    // keep demo data loaded across this suite's cases
  });

  const run = (input: MonteCarloInput) => runMonteCarlo({ ...input, seed: SEED, pathCount: PATHS });

  it('pure helpers: age-105 bound is distinct from MAX_AGE and caps the horizon', () => {
    expect(STRESS_MAX_AGE).toBe(105);
    expect(STRESS_MAX_AGE).toBeGreaterThan(MAX_AGE); // 105 > 100 — a distinct bound
    // +5 years, but never past birthYear + 105 even when the base already sits
    // at MAX_AGE (birthYear + 100).
    const birthYear = 1970;
    const atMaxAge = birthYear + MAX_AGE; // horizon already at age 100
    expect(resolveStressHorizonYear(atMaxAge, birthYear, 5)).toBe(birthYear + STRESS_MAX_AGE);
    // A horizon well below the cap extends by the full 5 years.
    expect(resolveStressHorizonYear(birthYear + 90, birthYear, 5)).toBe(birthYear + 95);
    // Already past the cap → clamped down to the cap, never shortened below base.
    expect(resolveStressHorizonYear(birthYear + 104, birthYear, 5)).toBe(birthYear + 105);
    // NEVER-SHORTEN: a base horizon already BEYOND the age-105 cap is
    // returned UNCHANGED — the `Math.max` floor holds, so the longevity stress
    // must not pull a longer-than-cap horizon back in to the cap.
    expect(resolveStressHorizonYear(birthYear + 107, birthYear, 5)).toBe(birthYear + 107);
    // No shock → unchanged.
    expect(resolveStressHorizonYear(atMaxAge, birthYear, 0)).toBe(atMaxAge);
  });

  it('every named stress case produces a runnable input with a valid summary', () => {
    for (const caseId of STRESS_CASE_IDS) {
      const stressed = applyStress(base, caseId, { longestLivedBirthYear });
      const summary = run(stressed);
      expect(summary.engineVersion).toBe(ENGINE_VERSION);
      expect(summary.successProbability).toBeGreaterThanOrEqual(0);
      expect(summary.successProbability).toBeLessThanOrEqual(1);
    }
    // Four full MC runs (800 paths each) at roughly 1s per run — already sitting
    // close to the 5s default. The health-coverage facts are memoized once
    // per RUN-YEAR (`healthCoverageYearFacts`), so their measured contribution
    // here is a fraction of that; the headroom is for the base run cost.
  }, MC_TEST_TIMEOUT_MS);

  it('IDENTITY: a zero-magnitude overlay reproduces the base bit-for-bit', () => {
    const noShock = applyReturnCostInflationShocks(base, {
      investmentCostPctDelta: 0,
      returnShockStocksPct: 0,
      returnShockBondsPct: 0,
      returnShockCashPct: 0,
      inflationShockPct: 0,
      longevityShockYears: 0,
    });
    // Referential identity — the helper returns the same object for a no-op.
    expect(noShock).toBe(base);
    const a = baseSummary;
    const b = run(noShock);
    // Same seed → byte-identical summary (proves the RNG stream is untouched).
    expect(b.successProbability).toBe(a.successProbability);
    expect(b.percentilesReal.p50).toEqual(a.percentilesReal.p50);
    expect(a.engineVersion).toBe(ENGINE_VERSION);
  }, MC_TEST_TIMEOUT_MS);

  it('MAGNITUDE: the base carries no cost, so "Higher fees" puts EXACTLY the 0.5 pp on the input', () => {
    // The base plan has no investment-cost setting (the scenario override and
    // its Balance Projection field were removed), so the stress overlay is the
    // ONLY thing that can put a fee on a `MonteCarloInput` — and the number it
    // puts there IS the modeled fee, not an increment on a stored one.
    //
    // Asserting the magnitude directly is load-bearing: every other stress test
    // here checks that the fee moves the result in the ADVERSE direction, which
    // a wrong magnitude (0.05, or 0.75 from a leaked base cost) would satisfy
    // just as well — and `STRESS_CASE_COPY.higherFees.changed` interpolates
    // from the same constant, so the on-screen "0.5% a year higher" would agree
    // with a base that was actually being charged something else.
    expect(base.annualInvestmentCostPct).toBeUndefined();
    const feeInput = applyStress(base, 'higherFees', { longestLivedBirthYear });
    expect(feeInput.annualInvestmentCostPct).toBe(0.5);
    expect(feeInput.annualInvestmentCostPct).toBe(
      STRESS_CASES.higherFees.investmentCostPctDelta,
    );
    // The other three cases leave the fee lever alone entirely, so none of them
    // can silently price a cost the base plan never had.
    for (const caseId of ['lowerReturns', 'higherInflation', 'longerLife'] as const) {
      expect(
        applyStress(base, caseId, { longestLivedBirthYear }).annualInvestmentCostPct,
      ).toBeUndefined();
    }
  });

  it('SAME PATHS: a stressed run shares the base seed / first year / horizon shape', () => {
    const fee = run(applyStress(base, 'higherFees', { longestLivedBirthYear }));
    expect(fee.seed).toBe(baseSummary.seed);
    expect(fee.firstYear).toBe(baseSummary.firstYear);
    // Fees do not extend the horizon.
    expect(fee.horizonYears).toBe(baseSummary.horizonYears);
  }, MC_TEST_TIMEOUT_MS);

  it('ISOLATION: each single lever moves output in the adverse direction', () => {
    const fee = run(applyStress(base, 'higherFees', { longestLivedBirthYear }));
    const lowerReturns = run(applyStress(base, 'lowerReturns', { longestLivedBirthYear }));
    const higherInflation = run(applyStress(base, 'higherInflation', { longestLivedBirthYear }));
    const longerLife = run(applyStress(base, 'longerLife', { longestLivedBirthYear }));

    // Fees + lower returns cut the real median ending balance.
    expect(fee.medianEndingBalanceReal).toBeLessThan(baseSummary.medianEndingBalanceReal);
    expect(lowerReturns.medianEndingBalanceReal).toBeLessThan(
      baseSummary.medianEndingBalanceReal,
    );
    // Higher inflation erodes the REAL ending balance (same nominal draws,
    // deflated harder per path).
    expect(higherInflation.medianEndingBalanceReal).toBeLessThan(
      baseSummary.medianEndingBalanceReal,
    );
    // Longer life extends the horizon by up to five years (age-105 capped).
    expect(longerLife.horizonYears).toBeGreaterThan(baseSummary.horizonYears);
    expect(longerLife.horizonYears - baseSummary.horizonYears).toBeLessThanOrEqual(5);
    // None of the adverse levers RAISE the success probability — including
    // higher inflation and longer life. Longevity extends the horizon,
    // but more years to fund never HELPS success, so the same base comparison
    // holds for the horizon-extending case too.
    expect(fee.successProbability).toBeLessThanOrEqual(baseSummary.successProbability);
    expect(lowerReturns.successProbability).toBeLessThanOrEqual(baseSummary.successProbability);
    expect(higherInflation.successProbability).toBeLessThanOrEqual(
      baseSummary.successProbability,
    );
    expect(longerLife.successProbability).toBeLessThanOrEqual(baseSummary.successProbability);
    // Five full MC runs — same pre-existing ~1s-per-run cost as above.
  }, MC_TEST_TIMEOUT_MS);

  it('MONOTONICITY: a larger fee drag never raises success and cuts the ending balance', () => {
    const light = run({ ...base, annualInvestmentCostPct: 0.5 });
    const heavy = run({ ...base, annualInvestmentCostPct: 2 });
    expect(heavy.successProbability).toBeLessThanOrEqual(light.successProbability);
    expect(heavy.medianEndingBalanceReal).toBeLessThan(light.medianEndingBalanceReal);
  }, MC_TEST_TIMEOUT_MS);

  it('DELTA: computeStressDelta reports the base-vs-stress difference', () => {
    const fee = run(applyStress(base, 'higherFees', { longestLivedBirthYear }));
    const delta = computeStressDelta('higherFees', baseSummary, fee);
    expect(delta.caseId).toBe('higherFees');
    expect(delta.baseSuccessProbability).toBe(baseSummary.successProbability);
    expect(delta.stressSuccessProbability).toBe(fee.successProbability);
    expect(delta.successProbabilityDelta).toBe(
      fee.successProbability - baseSummary.successProbability,
    );
    expect(delta.successProbabilityDelta).toBeLessThanOrEqual(0);
    expect(delta.medianEndingBalanceRealDelta).toBe(
      fee.medianEndingBalanceReal - baseSummary.medianEndingBalanceReal,
    );
  }, MC_TEST_TIMEOUT_MS);

  it('extendHorizon: pads every horizon-length series and preserves early-year paths', () => {
    const extended = extendHorizon(base, base.horizonYear + 3);
    const expectedSteps = (extended.horizonYear - base.firstYear + 1) * 12;
    expect(extended.monthlyExpenseBase.length).toBe(expectedSteps);
    expect(extended.ssByYear.length).toBe(base.ssByYear.length + 3);
    expect(extended.incomeByYear.length).toBe(base.incomeByYear.length + 3);
    for (const entry of extended.accountMcLedger) {
      expect(entry.contribPre.length).toBe(expectedSteps);
      expect(entry.contribPost.length).toBe(expectedSteps);
      expect(entry.deposit.length).toBe(expectedSteps);
    }
    // Same seed → the base-horizon years replay the identical draws; per-path
    // early-year balances are unchanged, so the p50 series agrees over the
    // overlapping horizon.
    const extendedSummary = run(extended);
    const overlap = baseSummary.horizonYears;
    expect(extendedSummary.percentilesReal.p50.slice(0, overlap)).toEqual(
      baseSummary.percentilesReal.p50.slice(0, overlap),
    );
  }, MC_TEST_TIMEOUT_MS);

  it('extendHorizon: reconciles member death years with the padded income', () => {
    const baseTax = base.taxContext;
    // The named-strategy demo run always carries a tax context; the death-year
    // reconciliation has nothing to act on without one.
    expect(baseTax).toBeDefined();
    if (!baseTax) return;

    const originalHorizon = base.horizonYear;
    const newHorizon = originalHorizon + 4;
    // Mixed-age household: PRIMARY still alive AT the base horizon end, SECONDARY
    // already dead six years before it. `extendHorizon` pads income/SS for both
    // as if alive through the extended window — the death markers must stay
    // consistent (no appended year both paying income AND treating the member as
    // deceased for tax/RMD). Exercise BOTH the taxContext and mcRmdContext paths.
    const withDeaths: MonteCarloInput = {
      ...base,
      taxContext: {
        ...baseTax,
        primaryDeathYear: originalHorizon,
        secondaryDeathYear: originalHorizon - 6,
      },
      mcRmdContext: {
        members: baseTax.members,
        rmdSnapshot: baseTax.taxBundle.rmd,
        primaryDeathYear: originalHorizon,
        secondaryDeathYear: originalHorizon - 6,
      },
    };
    const extended = extendHorizon(withDeaths, newHorizon);

    // PRIMARY (alive at the original horizon end) is pushed out so it never gates
    // an appended year as post-death — stays alive across the whole extension.
    expect(extended.taxContext?.primaryDeathYear ?? Infinity).toBeGreaterThanOrEqual(newHorizon);
    expect(extended.mcRmdContext?.primaryDeathYear ?? Infinity).toBeGreaterThanOrEqual(newHorizon);
    // SECONDARY (already dead before the extension) is left EXACTLY unchanged —
    // the padded income tail already reflects the survivor.
    expect(extended.taxContext?.secondaryDeathYear).toBe(originalHorizon - 6);
    expect(extended.mcRmdContext?.secondaryDeathYear).toBe(originalHorizon - 6);

    // Self-consistency for every appended year: the PRIMARY (whose income keeps
    // being paid by the flat padding) is NOT treated as deceased for tax/RMD.
    for (let y = originalHorizon + 1; y <= newHorizon; y += 1) {
      const taxDeath = extended.taxContext?.primaryDeathYear;
      const rmdDeath = extended.mcRmdContext?.primaryDeathYear;
      expect(taxDeath === undefined || y <= taxDeath).toBe(true);
      expect(rmdDeath === undefined || y <= rmdDeath).toBe(true);
    }
  });

  it('extendHorizon: pads injected returns/cpi so a longevity stress does not throw', () => {
    const origSteps = (base.horizonYear - base.firstYear + 1) * 12;
    const injectedBase: MonteCarloInput = {
      ...base,
      injectedReturns: new Float64Array(origSteps).fill(0.3),
      injectedCpi: new Float64Array(origSteps).fill(0.2),
    };
    const stressed = applyStress(injectedBase, 'longerLife', { longestLivedBirthYear });
    // The longevity stress extends the horizon; both injected companion arrays
    // must grow to the new step count or the strict length check throws.
    const newSteps = (stressed.horizonYear - stressed.firstYear + 1) * 12;
    expect(stressed.horizonYear).toBeGreaterThan(base.horizonYear);
    expect(stressed.injectedReturns?.length).toBe(newSteps);
    expect(stressed.injectedCpi?.length).toBe(newSteps);
    expect(() => run(stressed)).not.toThrow();
  }, MC_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await clearAllStores();
  });
});
