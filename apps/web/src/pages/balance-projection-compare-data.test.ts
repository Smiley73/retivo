import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { mcCacheKey } from '../db/monte-carlo-cache';
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
import { loadDemoData } from '../lib/demo-data-loader';
import { accountBucket } from '../lib/account-bucket';
import { buildMonteCarloInputForScenario } from '../lib/monte-carlo-scenario-input';
import {
  makeAccountBalance,
  makeDrawdownYear,
} from '../lib/balance-projection-runner-tax-test-fixtures';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { buildCompareData, type CompareDrivers } from './balance-projection-compare-data';
import {
  buildQcdRows,
  buildRmdRows,
  buildRothConversionsSeries,
  buildTaxBurdenRows,
} from './balance-projection-burden-rows';
import { buildExpenseDeathMarkers } from './balance-projection-page-markers';
import { sumTaxBurden } from './balance-projection-page-tax-burden';
import {
  drawdownByMethodFromPageResult,
  loadPageData,
  type PipelineData,
} from './balance-projection-page-data';
import {
  buildBasisDeflator,
  buildViewDeflatorForExport,
} from './balance-projection-view-derivation';

const TODAY = { todayYear: 2026, todayMonthIndex: 4 };
const NO_KEYS = { viewed: null, comparison: null };

interface Inputs {
  scenarios: ScenarioAggregate[];
  members: Aggregate<HouseholdMemberPayload>[];
  accounts: Aggregate<AccountPayload>[];
  balances: Aggregate<AccountBalancePayload>[];
  expenses: Aggregate<ExpensePayload>[];
  incomeStreams: Aggregate<IncomeStreamPayload>[];
  ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
  categories: Aggregate<ExpenseCategoryPayload>[];
}

let inputs: Inputs;
let byName: Map<string, ScenarioAggregate>;

function pageData(selectedScenarioId: string, scenarios = inputs.scenarios): PipelineData {
  return loadPageData({ ...inputs, scenarios, selectedScenarioId, ...TODAY });
}

function named(name: string): PipelineData {
  return pageData(byName.get(name)!.id);
}

/** A synthetic child of `parent` carrying only `overrides`. */
function childOf(parent: ScenarioAggregate, id: string, overrides: ScenarioOverrides): ScenarioAggregate {
  return {
    ...parent,
    id,
    payload: { ...parent.payload, name: id, parentScenarioId: parent.id, isPrimary: false, overrides },
  };
}

async function stressKey(scenarioId: string, scenarios: ScenarioAggregate[]): Promise<string> {
  const input = buildMonteCarloInputForScenario({ scenarioId, scenarios, inputs, ...TODAY });
  return mcCacheKey(input!);
}

/** The Taxes tab's path, recomputed from the page's own builders. */
function taxesTabDrivers(data: PipelineData) {
  const viewDeflator = buildViewDeflatorForExport(
    'today',
    data.resolved.inflation?.ratePct,
    TODAY.todayYear,
    TODAY.todayMonthIndex,
  );
  const basisDeflator = buildBasisDeflator({
    isMcBasisActive: false,
    displayMode: 'today',
    activeRepresentativeRun: null,
    viewDeflator,
  });
  const secondary = data.members.find((m) => !m.payload.isPrimary) ?? null;
  const markers = buildExpenseDeathMarkers(
    data.primaryMember,
    secondary,
    data.resolved.lifeExpectancy,
    'light',
  );
  const lastDeathFractional = markers.length
    ? Math.max(...markers.map((m) => m.fractionalYear))
    : null;
  const drawdown = drawdownByMethodFromPageResult(data.pageResult)!.planned;
  const tax = sumTaxBurden(
    buildTaxBurdenRows({ resolvedDrawdown: drawdown, basisDeflator, lastDeathFractional, isMcBasisActive: false }),
  );
  let roth = 0;
  for (const r of buildRothConversionsSeries({ drawdown, lastDeathFractional })) {
    roth += r.dollars * basisDeflator(r.year);
  }
  let rmds = 0;
  for (const r of buildRmdRows({ drawdown, basisDeflator, lastDeathFractional })) {
    rmds += r.rmdMet + r.rmdShortfall;
  }
  let qcds = 0;
  for (const r of buildQcdRows({ drawdown, basisDeflator, lastDeathFractional, displayMode: 'today' })) {
    qcds += r.qcdDollars;
  }
  return { ...tax, roth, rmds, qcds, lastDeathFractional };
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({
    householdId: 'compare-data',
    email: 'compare@example.test',
    displayName: 'Compare User',
    todayYear: TODAY.todayYear,
  });
  const list = <T>(type: string) => listAggregates(type as never) as Promise<T[]>;
  inputs = {
    scenarios: await list<ScenarioAggregate['payload']>('scenario') as unknown as ScenarioAggregate[],
    members: await list('householdMember'),
    accounts: await list('account'),
    balances: await list('accountBalance'),
    expenses: await list('expense'),
    incomeStreams: await list('incomeStream'),
    ssBenefits: await list('socialSecurityBenefit'),
    categories: await list('expenseCategory'),
  };
  byName = new Map(inputs.scenarios.map((s) => [s.payload.name, s]));
}, 30_000);

describe('buildCompareData — driver parity with the Taxes tab', () => {
  it('matches the page path for base and "Retire early at 62"', () => {
    const base = named('Base');
    const early = named('Retire early at 62');
    const compare = buildCompareData({ viewed: base, comparison: early, stressCacheKeys: NO_KEYS });
    for (const [side, data] of [[compare.viewed, base], [compare.comparison, early]] as const) {
      const expected = taxesTabDrivers(data);
      expect(side.drivers!.federalTax).toBe(expected.federalTax);
      expect(side.drivers!.irmaaSurcharge).toBe(expected.irmaaSurcharge);
      expect(side.drivers!.acaPtcCredit).toBe(expected.acaPtcCredit);
      expect(side.drivers!.rothConversions).toBe(expected.roth);
      expect(side.drivers!.rmds).toBe(expected.rmds);
      expect(side.drivers!.qcds).toBe(expected.qcds);
    }
    // Retiring early at 62 lands on the ACA marketplace: a non-trivial credit.
    expect(compare.comparison.drivers!.acaPtcCredit).toBeGreaterThan(0);
    expect(compare.comparison.drivers!.rothConversions).toBeGreaterThan(0);
  });
});

describe('buildCompareData — headline', () => {
  it('reports the planned ending balance, run-out year and horizon', () => {
    const base = named('Base');
    const run = named('Funds Run Out');
    const compare = buildCompareData({ viewed: run, comparison: base, stressCacheKeys: NO_KEYS });
    expect(compare.viewed.endingBalance).toBe(run.pageResult!.planned!.atHorizonTodayDollars);
    expect(compare.comparison.endingBalance).toBe(base.pageResult!.planned!.atHorizonTodayDollars);
    expect(compare.viewed.runOutYear).not.toBeNull();
    expect(compare.comparison.runOutYear).toBeNull();
    expect(compare.difference.runOutYear).toBeNull();
  });

  it('reports a later horizon year for a longer life expectancy', () => {
    const base = byName.get('Base')!;
    const scenarios = [...inputs.scenarios, childOf(base, 'child-long-life', { lifeExpectancy: { primary: 100 } })];
    const compare = buildCompareData({
      viewed: pageData('child-long-life', scenarios),
      comparison: pageData(base.id, scenarios),
      stressCacheKeys: NO_KEYS,
    });
    expect(compare.difference.horizonYear).toBe(5);
    expect(compare.viewed.horizonYear).toBeGreaterThan(compare.comparison.horizonYear!);
  });

  it('negates every difference when the pair is swapped', () => {
    const base = named('Base');
    const delay = named('Delay — work to 70');
    const forward = buildCompareData({ viewed: base, comparison: delay, stressCacheKeys: NO_KEYS });
    const swapped = buildCompareData({ viewed: delay, comparison: base, stressCacheKeys: NO_KEYS });
    expect(forward.difference.endingBalance).not.toBe(0);
    expect(swapped.difference.endingBalance).toBeCloseTo(-forward.difference.endingBalance!, 6);
    expect(swapped.difference.horizonYear).toBeCloseTo(-forward.difference.horizonYear!, 6);
    for (const key of Object.keys(forward.difference.drivers!) as (keyof CompareDrivers)[]) {
      if (key === 'withdrawalYears') continue;
      expect(swapped.difference.drivers![key]).toBeCloseTo(-(forward.difference.drivers![key] as number), 6);
    }
    expect(swapped.difference.drivers!.withdrawalYears.pretax).toBeCloseTo(
      -forward.difference.drivers!.withdrawalYears.pretax,
      6,
    );
  });
});

describe('buildCompareData — identity', () => {
  it('reads a child with no overrides as identical on both flags', async () => {
    const base = byName.get('Base')!;
    const scenarios = [...inputs.scenarios, childOf(base, 'child-none', {})];
    const compare = buildCompareData({
      viewed: pageData('child-none', scenarios),
      comparison: pageData(base.id, scenarios),
      stressCacheKeys: {
        viewed: await stressKey('child-none', scenarios),
        comparison: await stressKey(base.id, scenarios),
      },
    });
    expect(compare.identity).toEqual({ planned: true, stress: true });
    expect(compare.changes.groups).toEqual([]);
  });

  it('reads a re-set retirement age as identical yet still names it', async () => {
    const early = byName.get('Retire early at 62')!;
    const scenarios = [
      ...inputs.scenarios,
      childOf(early, 'child-same-age', { retirementAge: early.payload.overrides.retirementAge }),
    ];
    const compare = buildCompareData({
      viewed: pageData('child-same-age', scenarios),
      comparison: pageData(early.id, scenarios),
      stressCacheKeys: {
        viewed: await stressKey('child-same-age', scenarios),
        comparison: await stressKey(early.id, scenarios),
      },
    });
    expect(compare.identity).toEqual({ planned: true, stress: true });
    expect(compare.changes.groups.flatMap((g) => g.changes.map((c) => c.key))).toEqual(['retirementAge']);
  });

  it('separates guardrails, which only the stress test reads, from the planned years', async () => {
    const base = byName.get('Base')!;
    const guardrails = { enabled: true, lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 100 };
    const scenarios = [...inputs.scenarios, childOf(base, 'child-guard', { downturnGuardrails: guardrails })];
    const compare = buildCompareData({
      viewed: pageData('child-guard', scenarios),
      comparison: pageData(base.id, scenarios),
      stressCacheKeys: {
        viewed: await stressKey('child-guard', scenarios),
        comparison: await stressKey(base.id, scenarios),
      },
    });
    expect(compare.identity).toEqual({ planned: true, stress: false });
  });

  it('leaves stress unknown when a key is missing and planned false for different plans', () => {
    const compare = buildCompareData({
      viewed: named('Base'),
      comparison: named('Delay — work to 70'),
      stressCacheKeys: { viewed: 'a', comparison: null },
    });
    expect(compare.identity).toEqual({ planned: false, stress: null });
  });
});

describe('buildCompareData — years of withdrawals', () => {
  it('counts a bucket for each death-clipped planned year it is drawn on', () => {
    const base = named('Base');
    const { drivers } = buildCompareData({ viewed: base, comparison: base, stressCacheKeys: NO_KEYS }).viewed;
    const markers = base.pageResult!.sharedCtx.lifeExpectancyMarkers.map((m) => m.fractionalYear);
    const clipped = base.pageResult!.planned!.years.filter((y) => y.year <= Math.floor(Math.max(...markers)));
    const counts = Object.values(drivers!.withdrawalYears);
    expect(Math.max(...counts)).toBeGreaterThan(0);
    for (const count of counts) expect(count).toBeLessThanOrEqual(clipped.length);
  });

  it('skips ids absent from the accounts and years past the death clip', () => {
    const base = named('Base');
    const pretax = base.accounts.find((a) => accountBucket(a.payload.type) === 'pretax')!;
    const death = Math.floor(
      Math.max(...base.pageResult!.sharedCtx.lifeExpectancyMarkers.map((m) => m.fractionalYear)),
    );
    const years = [
      makeDrawdownYear(death - 1, 1_000, new Map([
        [pretax.id, makeAccountBalance(10_000, 500)],
        ['synthetic-rmd-overflow-cash', makeAccountBalance(10_000, 700)],
      ])),
      makeDrawdownYear(death, 1_000, new Map([[pretax.id, makeAccountBalance(10_000, 0)]])),
      makeDrawdownYear(death + 1, 1_000, new Map([[pretax.id, makeAccountBalance(10_000, 500)]])),
    ];
    const planned = { ...base.pageResult!.planned!, years };
    const synthetic: PipelineData = {
      ...base,
      pageResult: { ...base.pageResult!, planned },
    };
    const { viewed } = buildCompareData({ viewed: synthetic, comparison: base, stressCacheKeys: NO_KEYS });
    expect(viewed.drivers!.withdrawalYears).toEqual({ pretax: 1, roth: 0, taxable: 0, cash: 0, tax_free: 0 });
  });
});

describe('buildCompareData — change list', () => {
  const keysOf = (viewed: string, other: string) => {
    const list = buildCompareData({ viewed: named(viewed), comparison: named(other), stressCacheKeys: NO_KEYS }).changes;
    return { list, keys: list.groups.flatMap((g) => g.changes.map((c) => c.key)) };
  };
  const OWN = ['lifeExpectancy', 'contributions', 'discretionarySpending', 'expenses'];

  it('unions its own and the intermediate scenario keys, grouped under the four titles', () => {
    const { list, keys } = keysOf('Funds Run Out', 'Base');
    expect(list.relation).toBe('descendant');
    expect(list.groups.map((g) => g.title)).toEqual([
      'Timing & longevity',
      'Income & expenses',
      'Savings & investments',
      'Withdrawals & taxes',
    ]);
    expect(keys).toEqual(expect.arrayContaining([
      ...OWN, 'retirementAge', 'socialSecurity', 'accountContributions', 'accountReturns', 'withdrawalStrategy', 'magiCap',
    ]));
  });

  it('lists only its own keys against its direct parent', () => {
    const { keys } = keysOf('Funds Run Out', 'Retire early at 62');
    expect([...keys].sort()).toEqual([...OWN].sort());
  });

  it('is empty for unrelated branches and keeps the list when swapped', () => {
    const unrelated = keysOf('Retire early at 62', 'Delay — work to 70');
    expect(unrelated.list).toEqual({ relation: 'unrelated', groups: [] });
    const forward = keysOf('Funds Run Out', 'Base');
    const swapped = keysOf('Base', 'Funds Run Out');
    expect(swapped.list.relation).toBe('ancestor');
    expect(swapped.list.groups).toEqual(forward.list.groups);
  });
});
