import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExplainMetric } from '@retirement/assistant-protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMonteCarloCache, mcCacheKey, monteCarloCacheCount, putCached } from '../../db/monte-carlo-cache';
import { clearAllStores, deleteAggregateLocally, listAggregates, putAggregate } from '../../db/store';
import type { Aggregate, ScenarioPayload } from '../../db/types';
import type { DrawdownYear } from '../../lib/drawdown-engine';
import { loadDemoData } from '../../lib/demo-data-loader';
import { loadProjectionInputs } from '../../lib/projection-inputs';
import { BASE_ID, EARLY_ID, EXPLAIN_METRICS, savedSummary } from '../../test/assistant-analysis-inputs';
import { TEST_NOW, callPlanTool, choicesWith, envelopeOf } from '../../test/assistant-tools';
import type { ToolEnv } from './define';
import { rowAssumptions } from './projection-assumptions';
import { SCENARIO_SECTION_KEYS } from './scenario-sections';
import { monteCarloInputFor } from './stress-cache';

interface ExplainData {
  scenarioId: string;
  metric: string;
  value: number | null;
  valueTodayDollars?: number | null;
  unit: string;
  basis: string;
  stressTest?: { source?: string; reason?: string; tool?: string; seed?: number; pathCount?: number };
  inputs: Record<string, { source?: { kind: string }; withheld?: boolean; switch?: string }> | { omittedSections: string[] };
  defaultsApplied: Array<{ setting: string; field?: string; basis: string }>;
  doc: { path: string; heading: string };
  alsoSee?: { path: string; heading: string };
}

let scenarios: Aggregate<ScenarioPayload>[];

async function explain(metric: ExplainMetric, extra: Record<string, unknown> = {}, choices = choicesWith()) {
  const envelope = envelopeOf(await callPlanTool('retivo_explain', { metric, ...extra }, choices));
  return { envelope, data: envelope.data as unknown as ExplainData };
}

async function plantSaved(scenarioId = BASE_ID): Promise<void> {
  const env = { workspace: { ...(await loadProjectionInputs()), scenarios }, now: TEST_NOW } as unknown as ToolEnv;
  await putCached(await mcCacheKey(monteCarloInputFor(scenarioId, env)!), savedSummary(9));
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
});

beforeEach(async () => {
  await clearMonteCarloCache();
});

afterAll(async () => {
  await clearMonteCarloCache();
  await clearAllStores();
});

describe('the metric tables', () => {
  const inputKeys = {} as Record<ExplainMetric, readonly string[]>;
  const docs = {} as Record<ExplainMetric, { path: string; heading: string; alsoSee?: string }>;

  beforeAll(async () => {
    for (const metric of EXPLAIN_METRICS) {
      const { data } = await explain(metric);
      inputKeys[metric] = Object.keys(data.inputs);
      docs[metric] = { ...data.doc, ...(data.alsoSee !== undefined && { alsoSee: data.alsoSee.heading }) };
    }
  });

  it('names only ScenarioOverrides keys for each metric', () => {
    const known = new Set<string>(SCENARIO_SECTION_KEYS);
    for (const metric of EXPLAIN_METRICS) {
      expect(inputKeys[metric].length, metric).toBeGreaterThan(3);
      for (const key of inputKeys[metric]) expect(known.has(key), `${metric}: ${key}`).toBe(true);
    }
  });

  it('pins what the portfolio at retirement rests on, which stops short of the withdrawal settings', () => {
    expect([...inputKeys.portfolio_at_retirement].sort()).toEqual(
      [
        'retirementAge',
        'inflation',
        'income',
        'expenses',
        'discretionarySpending',
        'contributions',
        'accountContributions',
        'accountReturns',
        'accountAssetMix',
        'retirementAllocation',
        'preRetirementRothConversions',
        'preRetirementRothConversionTaxRatePct',
        'preRetirementTaxableIncomeDollars',
      ].sort(),
    );
    for (const key of ['withdrawalStrategy', 'magiCap', 'lifeExpectancy', 'socialSecurity']) {
      expect(inputKeys.portfolio_at_retirement).not.toContain(key);
      expect(inputKeys.ending_balance).toContain(key);
    }
    expect(inputKeys.plan_success).toContain('downturnGuardrails');
  });

  it('names the capital-gains, IRMAA, ACA, HSA and penalty settings for every metric that rests on the tax pass', () => {
    const taxSettings = [
      'assumedCostBasisFractionOfTaxableWithdrawal',
      'magiBootstrapLookbackMinus2',
      'magiBootstrapLookbackMinus1',
      'acaPtcBenchmark',
      'acaFplRegion',
      'acaMarketplaceOptOutMemberIds',
      'healthCoverageMonths',
      'hsaQualifiedMedicalExpensePct',
      'earlyWithdrawalPenaltyExemptAccountIds',
    ];
    for (const metric of EXPLAIN_METRICS.filter((name) => name !== 'portfolio_at_retirement')) {
      for (const key of taxSettings) expect(inputKeys[metric], `${metric}: ${key}`).toContain(key);
    }
  });

  it('points every metric at a heading that exists in the named markdown file', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    for (const metric of EXPLAIN_METRICS) {
      const doc = docs[metric];
      const lines = readFileSync(join(repoRoot, doc.path), 'utf8').split('\n');
      const headings = new Set(lines.filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#{1,6} /, '').trim()));
      expect(headings.has(doc.heading), `${metric}: ${doc.heading}`).toBe(true);
      if (doc.alsoSee !== undefined) expect(headings.has(doc.alsoSee), `${metric}: ${doc.alsoSee}`).toBe(true);
    }
  });

  it('sends deterministic metrics to the number definitions and Monte Carlo ones to reading the result', () => {
    for (const metric of ['ending_balance', 'run_out_year', 'portfolio_at_retirement'] as const) {
      expect(docs[metric].heading).toBe('What each number means');
      expect(docs[metric]).toMatchObject({ alsoSee: 'Planned and Historical' });
    }
    for (const metric of ['plan_success', 'typical_ending_balance', 'pessimistic_ending_balance', 'bad_luck_ending_balance'] as const) {
      expect(docs[metric].heading).toBe('Reading the result');
    }
  });
});

describe('deterministic metrics', () => {
  it('equals the projection’s headline for the same scenario', async () => {
    const projection = envelopeOf(await callPlanTool('retivo_get_projection', { scenarioId: EARLY_ID })).data as unknown as {
      headline: Record<string, number | null>;
    };
    const ending = (await explain('ending_balance', { scenarioId: EARLY_ID })).data;
    expect(ending.value).toBe(projection.headline.endingBalanceTodayDollars);
    expect(ending.unit).toBe("today's dollars");
    expect(ending.basis).toMatch(/horizon/);
    const runOut = (await explain('run_out_year', { scenarioId: EARLY_ID })).data;
    expect(runOut.value).toBe(projection.headline.runOutYear);
    const retirement = (await explain('portfolio_at_retirement', { scenarioId: EARLY_ID })).data;
    expect(retirement.value).toBe(projection.headline.portfolioAtRetirementNominal);
    expect(retirement.valueTodayDollars).toBe(projection.headline.portfolioAtRetirementTodayDollars);
    expect(retirement.unit).toMatch(/nominal dollars/);
  });

  it('refuses to explain a run whose cash balance plan has no payout election, since no projection ran', async () => {
    const income = (await listAggregates('incomeStream')).find((stream) => stream.id === 'demo-income-cbp-payout')!;
    await deleteAggregateLocally('incomeStream', income.id);
    try {
      for (const metric of ['ending_balance', 'run_out_year', 'portfolio_at_retirement'] as const) {
        const result = await callPlanTool('retivo_explain', { metric }, choicesWith());
        expect(result, metric).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
        expect(JSON.stringify(result), metric).toMatch(/payout election/);
      }
    } finally {
      await putAggregate('incomeStream', income);
    }
  });

  it('defaults to the base scenario and points at the number definitions', async () => {
    const { data } = await explain('ending_balance');
    expect(data.scenarioId).toBe(BASE_ID);
    expect(data.doc).toEqual({ path: 'docs/math-projections.md', heading: 'What each number means' });
    expect(data.alsoSee).toEqual({ path: 'docs/math-projections.md', heading: 'Planned and Historical' });
  });

  it('reports the settings behind the number with their provenance, and the defaults applied among them', async () => {
    const { data } = await explain('ending_balance');
    const inputs = data.inputs as Record<string, { source?: { kind: string } }>;
    expect(inputs.retirementAge!.source!.kind).toBe('scenario');
    expect(data.defaultsApplied.some((fill) => fill.setting === 'lifeExpectancy' && /DEFAULT_LIFE_EXPECTANCY_AGE/.test(fill.basis))).toBe(true);
    expect(data.defaultsApplied.some((fill) => fill.setting === 'socialSecurity' && fill.field === 'colaTracksInflation')).toBe(true);
  });

  it('names the engine flags in the assumptions exactly when the rows carry them', async () => {
    // The demo plan retires after the newest tax table, so its rows are all extrapolated, and it is not on Medicare early.
    const { envelope } = await explain('run_out_year');
    expect(envelope.assumptions.some((line) => line.includes('taxYearExtrapolated'))).toBe(true);
    expect(envelope.assumptions.some((line) => line.includes('magiEstimatedFromProjection'))).toBe(false);

    const env = { now: TEST_NOW } as unknown as ToolEnv;
    const row = (flags: Partial<DrawdownYear>) => ({ year: 2030, ...flags }) as DrawdownYear;
    const plain = rowAssumptions([row({}), row({ taxYearExtrapolated: false })], env).join('\n');
    expect(plain).not.toContain('taxYearExtrapolated');
    expect(plain).not.toContain('magiEstimatedFromProjection');
    expect(plain).toMatch(/Tax tables: every projected year uses a built-in federal table/);
    const flagged = rowAssumptions([row({ taxYearExtrapolated: true }), row({ magiEstimatedFromProjection: true, taxYearExtrapolated: true })], env).join('\n');
    expect(flagged).toContain('2 of 2 projected years');
    expect(flagged).toContain('taxYearExtrapolated');
    expect(flagged).toContain('magiEstimatedFromProjection');
    expect(rowAssumptions([row({ magiEstimatedFromProjection: true })], env).join('\n')).toContain('magiEstimatedFromProjection');
  });

  it('adds the defaults the engine filled in for the horizon and the dollar basis', async () => {
    const { envelope } = await explain('ending_balance');
    expect(envelope.assumptions.some((line) => /DEFAULT_LIFE_EXPECTANCY_AGE/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /^Health coverage:/.test(line))).toBe(true);
  });

  it('rounds the dollar figures to $1,000 while exact figures are off', async () => {
    const { data } = await explain('portfolio_at_retirement', {}, choicesWith({ exactDollars: false }));
    expect(Math.abs(data.value! % 1000)).toBe(0);
    expect(Math.abs(data.valueTodayDollars! % 1000)).toBe(0);
  });

  it('leaves the inputs out, and still answers, while the Scenarios switch is off', async () => {
    const { data } = await explain('ending_balance', {}, choicesWith({ scenarios: false }));
    expect(data.inputs).toEqual({ omittedSections: ['scenarios'] });
    expect(data.defaultsApplied).toEqual([]);
    expect(data.value).not.toBeNull();
  });

  it('withholds a setting whose own category is off, naming the switch', async () => {
    const { data } = await explain('ending_balance', {}, choicesWith({ accounts: false }));
    const inputs = data.inputs as Record<string, { withheld?: boolean; switch?: string }>;
    expect(inputs.accountReturns).toEqual({ withheld: true, switch: 'accounts' });
  });
});

describe('Monte Carlo metrics', () => {
  it.each(['plan_success', 'typical_ending_balance', 'pessimistic_ending_balance', 'bad_luck_ending_balance'] as const)(
    '%s is null with a pointer to retivo_get_stress_test when nothing is saved, and computes nothing',
    async (metric) => {
      const { data, envelope } = await explain(metric);
      expect(data.value).toBeNull();
      expect(data.stressTest).toMatchObject({ reason: 'not_computed', tool: 'retivo_get_stress_test' });
      expect(data.basis).toContain('retivo_get_stress_test');
      expect(data.doc).toEqual({ path: 'docs/math-projections.md', heading: 'Reading the result' });
      expect(data.alsoSee).toBeUndefined();
      expect(envelope.data.inputs).toBeDefined();
      expect(await monteCarloCacheCount()).toBe(0);
    },
  );

  it('reads each tier from the saved result, in today’s dollars', async () => {
    await plantSaved();
    const saved = savedSummary();
    const success = (await explain('plan_success')).data;
    expect(success.value).toBeCloseTo(saved.successProbability * 100, 10);
    expect(success.unit).toMatch(/percent/);
    expect(success.stressTest).toMatchObject({ source: 'cache', seed: 9, pathCount: saved.pathCount });
    expect((await explain('typical_ending_balance')).data.value).toBe(saved.medianEndingBalanceReal);
    expect((await explain('pessimistic_ending_balance')).data.value).toBe(saved.p25EndingBalanceReal);
    expect((await explain('bad_luck_ending_balance')).data.value).toBe(saved.p10EndingBalanceReal);
    expect((await explain('typical_ending_balance')).data.basis).toMatch(/50th percentile/);
  });

  it('carries the sampling-error note, the seed rule and the tax-table sentence, and leaves the cache untouched', async () => {
    await plantSaved();
    const { envelope } = await explain('plan_success');
    expect(envelope.assumptions.some((line) => /Sampling error:/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /Seed rule:/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /^Tax tables:/.test(line))).toBe(true);
    expect(await monteCarloCacheCount()).toBe(1);
  });

  it('rounds a tier to $1,000 while exact figures are off', async () => {
    await plantSaved();
    expect((await explain('typical_ending_balance', {}, choicesWith({ exactDollars: false }))).data.value).toBe(654_000);
  });
});

describe('arguments', () => {
  it('is INVALID_ARGS for an unknown scenario and for a metric outside the closed set', async () => {
    expect(await callPlanTool('retivo_explain', { scenarioId: 'no-such-scenario-zz', metric: 'ending_balance' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });
    expect(await callPlanTool('retivo_explain', { metric: 'success rate' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(await callPlanTool('retivo_explain', { metric: 'constructor' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });
});
