/**
 * The AI assistant's projection numbers are the Balance Projection page's: the same rows, field for field, and
 * the same headline the Scenarios cards derive. This file lives in `pages/` because the page glue it compares
 * against (`loadPageData`, `deriveScenarioDeterministicMetrics`) is not importable from `assistant/`.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import type { Aggregate, ScenarioPayload } from '../db/types';
import { loadDemoData } from '../lib/demo-data-loader';
import { realDeflatorAt } from '../lib/projection-context';
import { loadProjectionInputs } from '../lib/projection-inputs';
import { BASE_ID, EARLY_ID } from '../test/assistant-analysis-inputs';
import { TEST_NOW, callPlanTool, envelopeOf } from '../test/assistant-tools';
import { loadPageData } from './balance-projection-page-data';
import { deriveScenarioDeterministicMetrics } from './scenarios-page-metrics';

interface Row {
  year: number;
  balanceNominal: number;
  balanceTodayDollars: number;
  todayDollarsFactor: number;
  withdrawn: number;
  netNeed: number;
  deposit: number;
  growth: number;
  depleted: boolean;
  federalTax?: number;
  taxableSocialSecurity?: number;
  magi?: number;
}

interface ProjectionData {
  scenarioId: string;
  method: string;
  headline: {
    horizonYear: number | null;
    retirementYear: number | null;
    endingBalanceTodayDollars: number | null;
    runOutYear: number | null;
    portfolioAtRetirementNominal: number | null;
  };
  years: Row[];
}

let scenarios: Aggregate<ScenarioPayload>[];

async function pageDataFor(scenarioId: string) {
  const inputs = await loadProjectionInputs();
  return loadPageData({
    scenarios,
    selectedScenarioId: scenarioId,
    members: inputs.members,
    accounts: inputs.accounts,
    balances: inputs.balances,
    expenses: inputs.expenses,
    incomeStreams: inputs.incomeStreams,
    ssBenefits: inputs.ssBenefits,
    categories: inputs.categories,
    todayYear: TEST_NOW.getFullYear(),
    todayMonthIndex: TEST_NOW.getMonth(),
  });
}

async function projection(args: Record<string, unknown>): Promise<ProjectionData> {
  return envelopeOf(await callPlanTool('retivo_get_projection', args)).data as unknown as ProjectionData;
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
});

afterAll(async () => {
  await clearAllStores();
});

describe('retivo_get_projection against the Balance Projection page', () => {
  it('returns, for the base scenario by default, the rows the page projects, field for field', async () => {
    const page = await pageDataFor(BASE_ID);
    const planned = page.pageResult!.planned!;
    const data = await projection({});
    expect(data.scenarioId).toBe(BASE_ID);
    expect(data.method).toBe('planned');
    expect(data.years).toHaveLength(planned.years.length);
    expect(data.years.length).toBeGreaterThan(10);
    const ctx = page.pageResult!.sharedCtx.ctx;
    data.years.forEach((row, index) => {
      const year = planned.years[index]!;
      const deflator = realDeflatorAt(ctx, year.year, 11);
      expect(row.year).toBe(year.year);
      expect(row.balanceNominal).toBe(year.balance);
      // The deflator is applied once, to the nominal balance.
      expect(row.todayDollarsFactor).toBe(deflator);
      expect(row.balanceTodayDollars).toBe(year.balance * deflator);
      expect(row.withdrawn).toBe(year.withdrawn);
      expect(row.netNeed).toBe(year.netNeed);
      expect(row.deposit).toBe(year.deposit);
      expect(row.growth).toBe(year.growth);
      expect(row.depleted).toBe(year.depleted);
      // The engine's cents leave as dollars.
      if (year.federalTaxCents !== undefined) expect(row.federalTax).toBe(year.federalTaxCents / 100);
      else expect(row.federalTax).toBeUndefined();
      if (year.taxableSsCents !== undefined) expect(row.taxableSocialSecurity).toBe(year.taxableSsCents / 100);
      if (year.magiCents !== undefined) expect(row.magi).toBe(year.magiCents / 100);
    });
  });

  it('carries a headline equal to the page’s numbers', async () => {
    const page = await pageDataFor(BASE_ID);
    const metrics = deriveScenarioDeterministicMetrics(page.pageResult);
    const data = await projection({ scenarioId: BASE_ID });
    expect(data.headline.endingBalanceTodayDollars).toBe(metrics.endingBalance);
    expect(data.headline.endingBalanceTodayDollars).not.toBeNull();
    expect(data.headline.horizonYear).toBe(page.pageResult!.sharedCtx.horizonYear);
    expect(data.headline.retirementYear).toBe(page.pageResult!.sharedCtx.retirementYear);
    expect(data.headline.runOutYear).toBe(page.pageResult!.planned!.depletionYear);
    expect(data.headline.portfolioAtRetirementNominal).toBe(page.pageResult!.planned!.netPortfolioAtRetirement);
    // The last row's today's-dollar balance is the headline ending balance.
    expect(data.years.at(-1)!.balanceTodayDollars).toBeCloseTo(metrics.endingBalance!, 6);
  });

  it('gives the same rows for a scenario other than the base', async () => {
    const page = await pageDataFor(EARLY_ID);
    const planned = page.pageResult!.planned!;
    const data = await projection({ scenarioId: EARLY_ID });
    expect(data.years.map((row) => row.year)).toEqual(planned.years.map((year) => year.year));
    expect(data.years.map((row) => row.balanceNominal)).toEqual(planned.years.map((year) => year.balance));
  });

  it('gives retivo_explain’s ending balance and run-out year the same values', async () => {
    const page = await pageDataFor(EARLY_ID);
    const metrics = deriveScenarioDeterministicMetrics(page.pageResult);
    const ending = envelopeOf(await callPlanTool('retivo_explain', { scenarioId: EARLY_ID, metric: 'ending_balance' })).data as { value: number | null };
    const runOut = envelopeOf(await callPlanTool('retivo_explain', { scenarioId: EARLY_ID, metric: 'run_out_year' })).data as { value: number | null };
    expect(ending.value).toBe(metrics.endingBalance);
    expect(runOut.value).toBe(page.pageResult!.planned!.depletionYear);
  });
});
