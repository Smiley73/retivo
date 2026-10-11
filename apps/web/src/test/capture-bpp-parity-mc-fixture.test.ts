/**
 * Capture script (vitest-based) for the BPP MC parity fixture.
 *
 * `describe.skip` by default — does NOT run on `pnpm test`. To capture
 * or refresh the fixture:
 *
 *   1. Edit `describe.skip(...)` → `describe(...)` below.
 *   2. Run: `pnpm --filter @retirement/web exec vitest run capture-bpp-parity-mc-fixture`
 *   3. Inspect `apps/web/src/pages/__fixtures__/bpp-parity-mc-demo-dataset.json`.
 *   4. Re-apply `describe.skip(...)` BEFORE committing.
 *   5. Commit the fixture + the (still-skipped) capture test together.
 *
 * Pinned anchor: `todayYear: 2026, todayMonthIndex: 4` (May 2026 — the
 * plan-time current month; reproducible across machines / time zones).
 * `todayMonthIndex` is 0-indexed (4 = May).
 *
 * The fixture captures post-runner MC output (the SSA-actuarial SS formula the
 * runner uses, NOT the legacy BPP simple-reduction formula) and must be
 * (re-)captured after any deliberate change to the runner's SS arithmetic, or
 * any other change that moves Monte Carlo output for the demo household. The
 * parity test pins `fixture.engineVersion === ENGINE_VERSION`, so an
 * `ENGINE_VERSION` bump alone re-stamps it even when the captured numbers are
 * bit-identical (see "ENGINE_VERSION bump" in AGENTS.md).
 *
 * Routing: mirrors PlanStressTestSection's call site exactly —
 * `runBalanceProjectionMc(runArgs)` then `runMonteCarlo({ ...input,
 * pathCount: PATH_COUNT, seed: seedFromString(scenarioId) })`. A
 * runner-side change to the MC input-builder surfaces here as a
 * percentile drift on the next capture.
 */
import 'fake-indexeddb/auto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { runBalanceProjectionMc } from '../lib/balance-projection-runner';
import { runMonteCarlo } from '../lib/monte-carlo';
import { seedFromString } from '../lib/sfc32';
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

/** Pinned plan-time anchor so the fixture is reproducible across
 *  machines + timezones (numbers-only API; no Date object
 *  reaches the runner). */
const TODAY_YEAR = 2026;
/** 0-indexed (May). */
const TODAY_MONTH_INDEX = 4;

/** Deliberately reduced from production (`MC_PATH_COUNT`): the parity claim
 *  is seed-pinned, so bit-identity is path-count independent, and a smaller
 *  count keeps the parity test fast. */
const PATH_COUNT = 1_000;

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'pages',
  '__fixtures__',
  'bpp-parity-mc-demo-dataset.json',
);

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

// `describe.skip` keeps this off the standard test run. Un-skip to
// regenerate the fixture (see file header).
describe.skip('capture BPP MC parity fixture', () => {
  it('writes MC percentiles for every demo scenario', { timeout: 120_000 }, async () => {
    await clearAllStores();
    await loadDemoData({
      householdId: 'fixture-mc',
      email: 'fixture@example.test',
      displayName: 'Fixture User',
      todayYear: TODAY_YEAR,
    });

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

    const captured: ScenarioPercentiles[] = [];
    let engineVersion = 0;
    for (const scenario of scenarios) {
      const input = runBalanceProjectionMc({
        scenarioId: scenario.id,
        scenarios,
        accounts,
        balances,
        members,
        ssBenefits,
        expenses,
        incomeStreams,
        todayYear: TODAY_YEAR,
        todayMonthIndex: TODAY_MONTH_INDEX,
      });
      const summary = runMonteCarlo({
        ...input,
        pathCount: PATH_COUNT,
        seed: seedFromString(scenario.id),
      });
      engineVersion = summary.engineVersion;
      captured.push({
        scenarioId: scenario.id,
        firstYear: summary.firstYear,
        horizonYears: summary.horizonYears,
        successProbability: summary.successProbability,
        p10Real: summary.percentilesReal.p10.slice(),
        p25Real: summary.percentilesReal.p25.slice(),
        p50Real: summary.percentilesReal.p50.slice(),
        medianDepletionYear: summary.medianDepletionYear,
      });
    }

    const fixture: McFixture = {
      anchor: { todayYear: TODAY_YEAR, todayMonthIndex: TODAY_MONTH_INDEX },
      pathCount: PATH_COUNT,
      engineVersion,
      scenarios: captured.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
    };

    await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
    await fs.writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    // Sanity: every scenario emitted a non-zero-length percentile row.
    for (const row of captured) {
      expect(row.p50Real.length).toBeGreaterThan(0);
    }
    await clearAllStores();
  });
});
