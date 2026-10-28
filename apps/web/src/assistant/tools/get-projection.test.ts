import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, deleteAggregateLocally, listAggregates, putAggregate } from '../../db/store';
import type { Aggregate, ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { loadProjectionInputs } from '../../lib/projection-inputs';
import { BASE_ID, EARLY_ID, NO_CONTRIB_ID } from '../../test/assistant-analysis-inputs';
import { TEST_NOW, callPlanTool, choicesWith, envelopeOf } from '../../test/assistant-tools';
import type { ToolEnv } from './define';
import { runPlan } from './projection-support';

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
  taxYearExtrapolated?: true;
  magiEstimatedFromProjection?: true;
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
    portfolioAtRetirementTodayDollars: number | null;
  };
  years: Row[];
  basis: Record<string, string>;
}

let scenarios: Aggregate<ScenarioPayload>[];

async function envOf(): Promise<ToolEnv> {
  return { workspace: { ...(await loadProjectionInputs()), scenarios }, now: TEST_NOW } as unknown as ToolEnv;
}

async function projection(args: Record<string, unknown>, choices = choicesWith()) {
  const envelope = envelopeOf(await callPlanTool('retivo_get_projection', args, choices));
  return { envelope, data: envelope.data as unknown as ProjectionData };
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
});

afterAll(async () => {
  await clearAllStores();
});

describe('retivo_get_projection', () => {
  it('reports a run-out year for the scenario that overspends and none for the base', async () => {
    const early = (await projection({ scenarioId: NO_CONTRIB_ID })).data;
    const funds = scenarios.find((scenario) => scenario.payload.name === 'Funds Run Out')!;
    const run = (await projection({ scenarioId: funds.id })).data;
    expect(run.headline.runOutYear).not.toBeNull();
    expect(run.years.some((row) => row.depleted)).toBe(true);
    expect(early.scenarioId).toBe(NO_CONTRIB_ID);
    expect((await projection({ scenarioId: BASE_ID })).data.headline.runOutYear).toBeNull();
  });

  it('clips the rows with fromYear and toYear without changing a value or the headline', async () => {
    const all = (await projection({ scenarioId: EARLY_ID })).data;
    const from = all.years[3]!.year;
    const to = all.years[9]!.year;
    const clipped = (await projection({ scenarioId: EARLY_ID, fromYear: from, toYear: to })).data;
    expect(clipped.years.map((row) => row.year)).toEqual(all.years.slice(3, 10).map((row) => row.year));
    expect(clipped.years).toEqual(all.years.slice(3, 10));
    expect(clipped.headline).toEqual(all.headline);
    expect((await projection({ scenarioId: EARLY_ID, fromYear: 2300 })).data.years).toEqual([]);
  });

  it('with Scenarios off still projects the base scenario, and refuses a named one', async () => {
    const off = choicesWith({ scenarios: false });
    expect((await projection({ scenarioId: BASE_ID }, off)).data.years.length).toBeGreaterThan(0);
    expect((await projection({}, off)).data.years.length).toBeGreaterThan(0);
    const { data } = await projection({ scenarioId: EARLY_ID }, off);
    expect(data).toMatchObject({ omittedSections: ['scenarios'] });
    expect(data.years).toBeUndefined();
  });

  it('refuses fromYear after toYear and an unknown scenario as INVALID_ARGS', async () => {
    const reversed = await callPlanTool('retivo_get_projection', { fromYear: 2050, toYear: 2040 });
    expect(reversed).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    const unknown = await callPlanTool('retivo_get_projection', { scenarioId: 'no-such-scenario' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(unknown)).not.toContain('no-such-scenario');
  });

  it('answers historical from the same run when the plan has the history for it', async () => {
    const run = runPlan(BASE_ID, await envOf());
    expect(run.pageResult!.twr).not.toBeNull();
    const { data } = await projection({ method: 'historical' });
    expect(data.method).toBe('historical');
    expect(data.years).toHaveLength(run.pageResult!.twr!.years.length);
    expect(data.headline.endingBalanceTodayDollars).toBe(run.pageResult!.twr!.atHorizonTodayDollars);
  });

  it('is INVALID_ARGS for historical on a plan without the two-year history', async () => {
    // Strip the balance history down to one entry per account so no account has a measured rate.
    const balances = await listAggregates('accountBalance');
    const seen = new Set<string>();
    const originals: typeof balances = [];
    for (const balance of balances) {
      const accountId = (balance.payload as { accountId: string }).accountId;
      if (seen.has(accountId)) {
        originals.push(balance);
        await deleteAggregateLocally('accountBalance', balance.id);
      } else seen.add(accountId);
    }
    try {
      expect(runPlan(BASE_ID, await envOf()).pageResult!.twr).toBeNull();
      const result = await callPlanTool('retivo_get_projection', { method: 'historical' });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
      expect(JSON.stringify(result)).toMatch(/Historical view is not available/);
      expect((await projection({})).data.years.length).toBeGreaterThan(0);
    } finally {
      for (const balance of originals) await putAggregate('accountBalance', balance);
    }
  });

  it('states the basis once and the assumptions the rows rest on', async () => {
    const { envelope, data } = await projection({});
    expect(data.basis.dollars).toMatch(/balanceTodayDollars is balanceNominal times todayDollarsFactor/);
    expect(envelope.assumptions.some((line) => /Planned: every account grows at the return planned/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /Tax tables:/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /^Health coverage:/.test(line))).toBe(true);
  });

  it('names the flags the engine stamped on the rows, and only then', async () => {
    const { envelope, data } = await projection({});
    const flagged = (name: keyof Row) => data.years.some((row) => row[name] === true);
    const mentions = (name: string) => envelope.assumptions.some((line) => line.includes(name));
    expect(mentions('taxYearExtrapolated')).toBe(flagged('taxYearExtrapolated'));
    expect(mentions('magiEstimatedFromProjection')).toBe(flagged('magiEstimatedFromProjection'));
  });
});

describe('retivo_get_projection under the sharing choices', () => {
  it('rounds every dollar figure to $1,000 and leaves years, flags and the factor alone', async () => {
    const exact = (await projection({ scenarioId: EARLY_ID })).data;
    const { data } = await projection({ scenarioId: EARLY_ID }, choicesWith({ exactDollars: false }));
    const dollarFields = ['balanceNominal', 'balanceTodayDollars', 'withdrawn', 'netNeed', 'deposit', 'growth', 'federalTax', 'taxableSocialSecurity', 'magi'] as const;
    expect(data.years.length).toBe(exact.years.length);
    data.years.forEach((row, index) => {
      for (const field of dollarFields) {
        const value = row[field];
        if (value !== undefined) expect(Math.abs(value % 1000), `${field} ${value}`).toBe(0);
      }
      expect(row.year).toBe(exact.years[index]!.year);
      expect(row.todayDollarsFactor).toBe(exact.years[index]!.todayDollarsFactor);
    });
    for (const value of [data.headline.endingBalanceTodayDollars, data.headline.portfolioAtRetirementNominal, data.headline.portfolioAtRetirementTodayDollars]) {
      if (value !== null) expect(Math.abs(value % 1000)).toBe(0);
    }
    expect(data.headline.runOutYear).toBe(exact.headline.runOutYear);
  });
});
