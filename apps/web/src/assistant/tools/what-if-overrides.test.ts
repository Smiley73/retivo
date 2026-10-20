/**
 * What `retivo_run_what_if` accepts: the allowlist, the editors' bounds (each assertion reads the editor's own
 * constant from `lib/scenario-input-bounds.ts`, so a bound that moves is a one-line fix and a drifted tool fails
 * here), and the merge of a supplied section over what the base resolves to.
 */
import 'fake-indexeddb/auto';
import { TOOL_REGISTRY, WHAT_IF_OVERRIDES, type WhatIfOverrides } from '@retirement/assistant-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates, putAggregate } from '../../db/store';
import { DEFAULT_DOWNTURN_GUARDRAILS, DEFAULT_LIFE_EXPECTANCY_AGE, type Aggregate, type ScenarioOverrides, type ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { loadProjectionInputs } from '../../lib/projection-inputs';
import * as bounds from '../../lib/scenario-input-bounds';
import { resolveAccountReturnsForScenario, resolveInflationForScenario, resolveScenario } from '../../lib/scenario-resolution';
import { BASE_ID } from '../../test/assistant-analysis-inputs';
import { TEST_NOW, callPlanTool, envelopeOf } from '../../test/assistant-tools';
import type { ToolEnv } from './define';
import { SCENARIO_SECTION_KEYS } from './scenario-sections';
import { WHAT_IF_CLASSIFICATION, buildWhatIf, type WhatIfBuild } from './what-if-overrides';
import { throwawayFor } from './what-if';

const REDUCED_ID = 't-reduction-20';
const INFLATION_PARENT_ID = 't-inflation-parent';
const INFLATION_GRANDCHILD_ID = 't-inflation-grandchild';
const INACTIVE_ACCOUNT_ID = 't-inactive-account';
const WHOLE_RETIREMENT_ID = 't-whole-retirement-spending';
const INDEPENDENT_ID = 't-independent-retirement';
const ACCOUNT_ID = 'demo-account-john-401k';

let scenarios: Aggregate<ScenarioPayload>[];

async function envOf(): Promise<ToolEnv> {
  return { workspace: { ...(await loadProjectionInputs()), scenarios }, now: TEST_NOW } as unknown as ToolEnv;
}

async function build(overrides: WhatIfOverrides, baseId = BASE_ID): Promise<WhatIfBuild> {
  return buildWhatIf(baseId, overrides, await envOf());
}

/** The tool's own answer, so the message the agent reads is the one asserted. */
async function call(overrides: unknown, baseScenarioId = BASE_ID) {
  return callPlanTool('retivo_run_what_if', { baseScenarioId, overrides });
}

async function expectRejected(overrides: unknown, ...fragments: Array<string | number>) {
  const result = await call(overrides);
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  const message = result.ok ? '' : result.error.message;
  for (const fragment of fragments) expect(message, message).toContain(String(fragment));
}

async function addScenario(id: string, parentScenarioId: string, overrides: ScenarioOverrides): Promise<void> {
  const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
  await putAggregate('scenario', { ...base, id, payload: { ...base.payload, name: id, isPrimary: false, parentScenarioId, overrides } });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  const [account] = await listAggregates('account');
  await putAggregate('account', { ...account!, id: INACTIVE_ACCOUNT_ID, payload: { ...account!.payload, active: false } });
  await addScenario(REDUCED_ID, BASE_ID, {
    socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 }, benefitReductionPct: 20 },
  });
  await addScenario(WHOLE_RETIREMENT_ID, BASE_ID, { discretionarySpending: { bumpPct: 10, durationYears: null } });
  await addScenario(INDEPENDENT_ID, BASE_ID, { retirementAge: { primary: { ageYears: 65, ageMonths: 0 }, secondary: { ageYears: 60, ageMonths: 0 } } });
  await addScenario(INFLATION_PARENT_ID, BASE_ID, { inflation: { ratePct: 4.5 } });
  await addScenario('t-inflation-middle', INFLATION_PARENT_ID, {});
  await addScenario(INFLATION_GRANDCHILD_ID, 't-inflation-middle', { lifeExpectancy: { primary: 90 } });
});

afterAll(async () => {
  await clearAllStores();
});

describe('the allowlist', () => {
  it('classifies every ScenarioOverrides key, and the registry schema takes exactly the allowed ones', () => {
    expect(Object.keys(WHAT_IF_CLASSIFICATION).sort()).toEqual([...SCENARIO_SECTION_KEYS].sort());
    const allowed = Object.entries(WHAT_IF_CLASSIFICATION)
      .filter(([, kind]) => kind === 'allowed')
      .map(([key]) => key)
      .sort();
    expect(Object.keys(WHAT_IF_OVERRIDES.shape).sort()).toEqual(allowed);
  });

  it.each([
    ['expenses', { expenses: { disabledIds: ['x'] } }, 'overrides.expenses'],
    ['income', { income: { disabledIds: ['x'] } }, 'overrides.income'],
    ['customDrawdownOrder', { customDrawdownOrder: { tiers: [], excludedAccountIds: [] } }, 'overrides.customDrawdownOrder'],
    ['taxFilingPlan', { taxFilingPlan: { kind: 'joint' } }, 'overrides.taxFilingPlan'],
    ['the survivor block', { socialSecurity: { survivor: { primary: { ageYears: 67 } } } }, 'overrides.socialSecurity.survivor'],
    ['inflation.categoryRates', { inflation: { ratePct: 3, categoryRates: { 'cat-medical': 4 } } }, 'overrides.inflation.categoryRates'],
    ['an unknown key', { zzUnknown: true }, 'overrides.zzUnknown'],
    ['an unknown key inside an allowed section', { retirementAge: { primary: { ageYears: 62 }, zzUnknown: 1 } }, 'overrides.retirementAge.zzUnknown'],
    ['withdrawalStrategy customOrder', { withdrawalStrategy: { kind: 'customOrder' } }, 'overrides.withdrawalStrategy.kind'],
  ])('rejects %s, naming it', async (_label, overrides, path) => {
    await expectRejected(overrides, path);
  });

  it('rejects an id that is not an account of the household, an inactive account, and __proto__ as an id, naming the section', async () => {
    const entry = { planningReturnPct: 5 };
    await expectRejected({ accountReturns: { perAccount: { 'no-such-account': entry } } }, 'overrides.accountReturns.perAccount', 'active account');
    await expectRejected({ accountReturns: { perAccount: { [INACTIVE_ACCOUNT_ID]: entry } } }, 'overrides.accountReturns.perAccount', 'active account');
    const polluting = JSON.parse('{"accountReturns":{"perAccount":{"__proto__":{"planningReturnPct":5}}}}') as unknown;
    await expectRejected(polluting, 'overrides.accountReturns.perAccount');
    expect(Object.prototype).not.toHaveProperty('planningReturnPct');
  });

  it('refuses an unknown base scenario as INVALID_ARGS without echoing it', async () => {
    const result = await call({}, 'no-such-scenario-zz');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(result)).not.toContain('no-such-scenario-zz');
  });
});

describe('the editors’ bounds: rejected, never clamped', () => {
  it('retirementAge: whole years from the editor’s floor to MAX_AGE, months 0 to 11', async () => {
    const at = (ageYears: number, ageMonths = 0) => ({ retirementAge: { primary: { ageYears, ageMonths } } });
    await expect(build(at(bounds.RETIREMENT_AGE_MIN))).resolves.toBeDefined();
    await expect(build(at(bounds.RETIREMENT_AGE_MAX))).resolves.toBeDefined();
    await expect(build(at(bounds.RETIREMENT_AGE_MIN, bounds.AGE_MONTHS_MAX))).resolves.toBeDefined();
    await expectRejected(at(bounds.RETIREMENT_AGE_MIN - 1), 'overrides.retirementAge.primary.ageYears', bounds.RETIREMENT_AGE_MIN, bounds.RETIREMENT_AGE_MAX);
    await expectRejected(at(bounds.RETIREMENT_AGE_MAX + 1), 'overrides.retirementAge.primary.ageYears');
    await expectRejected(at(65, bounds.AGE_MONTHS_MAX + 1), 'overrides.retirementAge.primary.ageMonths', bounds.AGE_MONTHS_MAX);
  });

  it('socialSecurity claim ages: 62y0m through 70y0m, so 61y11m and 70y1m fail', async () => {
    const claim = (ageYears: number, ageMonths = 0) => ({ socialSecurity: { primary: { ageYears, ageMonths } } });
    await expect(build(claim(bounds.SS_CLAIM_MIN, 0))).resolves.toBeDefined();
    await expect(build(claim(bounds.SS_CLAIM_MAX, 0))).resolves.toBeDefined();
    await expect(build(claim(bounds.SS_CLAIM_MIN, 1))).resolves.toBeDefined();
    await expectRejected(claim(bounds.SS_CLAIM_MIN - 1, 11), 'overrides.socialSecurity.primary', bounds.SS_CLAIM_MIN, bounds.SS_CLAIM_MAX);
    await expectRejected(claim(bounds.SS_CLAIM_MAX, 1), 'overrides.socialSecurity.primary');
    await expectRejected(claim(bounds.SS_CLAIM_MAX + 1, 0), 'overrides.socialSecurity.primary');
  });

  it('socialSecurity benefit cut and COLA, and a fixed COLA only while benefits do not track inflation', async () => {
    const cut = (benefitReductionPct: number) => ({ socialSecurity: { benefitReductionPct } });
    await expect(build(cut(bounds.BENEFIT_REDUCTION_MIN))).resolves.toBeDefined();
    await expect(build(cut(bounds.BENEFIT_REDUCTION_MAX))).resolves.toBeDefined();
    await expectRejected(cut(bounds.BENEFIT_REDUCTION_MAX + 1), 'overrides.socialSecurity.benefitReductionPct', bounds.BENEFIT_REDUCTION_MAX);
    await expectRejected(cut(bounds.BENEFIT_REDUCTION_MIN - 1), 'overrides.socialSecurity.benefitReductionPct');

    const fixed = (colaPct: number) => ({ socialSecurity: { colaTracksInflation: false, colaPct } });
    await expect(build(fixed(bounds.COLA_MIN))).resolves.toBeDefined();
    await expect(build(fixed(bounds.COLA_MAX))).resolves.toBeDefined();
    await expectRejected(fixed(bounds.COLA_MAX + 0.5), 'overrides.socialSecurity.colaPct', bounds.COLA_MAX);
    await expectRejected(fixed(bounds.COLA_MIN - 0.5), 'overrides.socialSecurity.colaPct');
    // The demo base tracks inflation, so a fixed rate alone would be silently ignored.
    await expectRejected({ socialSecurity: { colaPct: 2 } }, 'overrides.socialSecurity.colaPct', 'colaTracksInflation');
  });

  it('lifeExpectancy: the editor’s planning-age range', async () => {
    await expect(build({ lifeExpectancy: { primary: bounds.LIFE_MIN } })).resolves.toBeDefined();
    await expect(build({ lifeExpectancy: { primary: bounds.LIFE_MAX } })).resolves.toBeDefined();
    await expectRejected({ lifeExpectancy: { primary: bounds.LIFE_MIN - 1 } }, 'overrides.lifeExpectancy.primary', bounds.LIFE_MIN, bounds.LIFE_MAX);
    await expectRejected({ lifeExpectancy: { primary: bounds.LIFE_MAX + 1 } }, 'overrides.lifeExpectancy.primary');
  });

  it('inflation.ratePct: the editor’s range', async () => {
    await expect(build({ inflation: { ratePct: bounds.INFLATION_MIN } })).resolves.toBeDefined();
    await expect(build({ inflation: { ratePct: bounds.INFLATION_MAX } })).resolves.toBeDefined();
    await expectRejected({ inflation: { ratePct: bounds.INFLATION_MAX + 0.5 } }, 'overrides.inflation.ratePct', bounds.INFLATION_MAX);
    await expectRejected({ inflation: { ratePct: bounds.INFLATION_MIN - 0.5 } }, 'overrides.inflation.ratePct');
  });

  it('discretionarySpending: the adjustment and the duration, with null meaning the whole retirement', async () => {
    await expect(build({ discretionarySpending: { bumpPct: bounds.ADJUSTMENT_MIN, durationYears: bounds.DURATION_MIN } })).resolves.toBeDefined();
    await expect(build({ discretionarySpending: { bumpPct: bounds.ADJUSTMENT_MAX, durationYears: bounds.DURATION_MAX } })).resolves.toBeDefined();
    await expect(build({ discretionarySpending: { bumpPct: 10, durationYears: null } })).resolves.toBeDefined();
    await expectRejected({ discretionarySpending: { bumpPct: bounds.ADJUSTMENT_MAX + 1 } }, 'overrides.discretionarySpending.bumpPct', bounds.ADJUSTMENT_MAX);
    await expectRejected({ discretionarySpending: { bumpPct: bounds.ADJUSTMENT_MIN - 1 } }, 'overrides.discretionarySpending.bumpPct');
    await expectRejected({ discretionarySpending: { durationYears: bounds.DURATION_MIN - 1 } }, 'overrides.discretionarySpending.durationYears', bounds.DURATION_MAX);
    await expectRejected({ discretionarySpending: { durationYears: bounds.DURATION_MAX + 1 } }, 'overrides.discretionarySpending.durationYears');
  });

  it('downturnGuardrails: the editor’s bands, and isGuardrailConfigValid, so lowerBandPct >= upperBandPct fails', async () => {
    const valid = { enabled: true, lowerBandPct: bounds.GUARDRAIL_LOWER_BAND_MIN, upperBandPct: bounds.GUARDRAIL_UPPER_BAND_MAX, stepPct: bounds.GUARDRAIL_STEP_MIN, maxRaisePct: bounds.GUARDRAIL_MAX_RAISE_MAX };
    await expect(build({ downturnGuardrails: valid })).resolves.toBeDefined();
    await expect(build({ downturnGuardrails: { discretionaryFloorPct: bounds.GUARDRAIL_DISCRETIONARY_FLOOR_MAX } })).resolves.toBeDefined();
    await expectRejected({ downturnGuardrails: { ...valid, lowerBandPct: bounds.GUARDRAIL_LOWER_BAND_MIN - 1 } }, 'overrides.downturnGuardrails.lowerBandPct', bounds.GUARDRAIL_LOWER_BAND_MIN);
    await expectRejected({ downturnGuardrails: { ...valid, upperBandPct: bounds.GUARDRAIL_UPPER_BAND_MAX + 1 } }, 'overrides.downturnGuardrails.upperBandPct');
    await expectRejected({ downturnGuardrails: { ...valid, stepPct: bounds.GUARDRAIL_STEP_MAX + 1 } }, 'overrides.downturnGuardrails.stepPct');
    await expectRejected({ downturnGuardrails: { ...valid, maxRaisePct: bounds.GUARDRAIL_MAX_RAISE_MIN - 1 } }, 'overrides.downturnGuardrails.maxRaisePct');
    await expectRejected({ downturnGuardrails: { ...valid, discretionaryFloorPct: bounds.GUARDRAIL_DISCRETIONARY_FLOOR_MAX + 1 } }, 'overrides.downturnGuardrails.discretionaryFloorPct');
    // Both inside their editor ranges, yet not a valid pair.
    await expectRejected(
      { downturnGuardrails: { ...valid, lowerBandPct: bounds.GUARDRAIL_LOWER_BAND_MAX, upperBandPct: bounds.GUARDRAIL_UPPER_BAND_MIN } },
      'overrides.downturnGuardrails',
      'lower band must be below the upper band',
    );
  });

  it('contributions.stopContributionsToday and withdrawalStrategy.kind: a boolean, and a kind that needs no extra input', async () => {
    const built = await build({ contributions: { stopContributionsToday: true }, withdrawalStrategy: { kind: 'rothFirst' } });
    expect(built.overrides).toMatchObject({ contributions: { stopContributionsToday: true }, withdrawalStrategy: { kind: 'rothFirst' } });
    await expectRejected({ contributions: { stopContributionsToday: 'yes' } }, 'overrides.contributions.stopContributionsToday');
  });

  it('accountReturns: the planned-returns editor’s range, for an active account', async () => {
    const set = (planningReturnPct: number) => ({ accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct } } } });
    await expect(build(set(bounds.PLANNING_RETURN_MIN))).resolves.toBeDefined();
    await expect(build(set(bounds.PLANNING_RETURN_MAX))).resolves.toBeDefined();
    await expectRejected(set(bounds.PLANNING_RETURN_MAX + 1), 'overrides.accountReturns.perAccount.planningReturnPct', bounds.PLANNING_RETURN_MAX);
    await expectRejected(set(bounds.PLANNING_RETURN_MIN - 1), 'overrides.accountReturns.perAccount.planningReturnPct');
  });

  it('a pass and a fail for every allowed section above: the classification has no allowed key left uncovered', () => {
    const covered = ['retirementAge', 'socialSecurity', 'lifeExpectancy', 'inflation', 'discretionarySpending', 'downturnGuardrails', 'contributions', 'accountReturns', 'withdrawalStrategy'];
    const allowed = Object.entries(WHAT_IF_CLASSIFICATION).filter(([, kind]) => kind === 'allowed').map(([key]) => key);
    expect([...allowed].sort()).toEqual([...covered].sort());
  });

  it('refuses a secondary member’s setting when the household has none', async () => {
    const env = await envOf();
    const solo = { ...env, workspace: { ...env.workspace, members: env.workspace.members.filter((member) => member.payload.isPrimary) } } as ToolEnv;
    expect(() => buildWhatIf(BASE_ID, { lifeExpectancy: { secondary: 90 } }, solo)).toThrow(/no secondary member/);
  });

  it('the registry accepts what the tab accepts: every allowed section’s passing example parses', () => {
    const entry = TOOL_REGISTRY.find((tool) => tool.name === 'retivo_run_what_if')!;
    const example = {
      retirementAge: { primary: { ageYears: bounds.RETIREMENT_AGE_MIN } },
      socialSecurity: { primary: { ageYears: bounds.SS_CLAIM_MAX } },
      lifeExpectancy: { primary: bounds.LIFE_MIN },
      inflation: { ratePct: bounds.INFLATION_MAX },
      discretionarySpending: { bumpPct: bounds.ADJUSTMENT_MIN, durationYears: null },
      downturnGuardrails: { enabled: true },
      contributions: { stopContributionsToday: false },
      accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: bounds.PLANNING_RETURN_MAX } } },
      withdrawalStrategy: { kind: 'proportional' },
    };
    expect(entry.inputSchema.safeParse({ baseScenarioId: BASE_ID, overrides: example }).success).toBe(true);
  });
});

describe('merging a section over what the base resolves to', () => {
  it('keeps a base benefit cut of 20 when only the primary claim age is supplied, and reports it unchanged', async () => {
    const built = await build({ socialSecurity: { primary: { ageYears: 70 } } }, REDUCED_ID);
    expect(built.overrides.socialSecurity).toMatchObject({ benefitReductionPct: 20, primary: { ageYears: 70, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } });
    expect(built.kept).toContainEqual(expect.objectContaining({ path: 'benefitReductionPct', value: 20, source: 'scenario' }));
    expect(built.changes.map((change) => change.path)).not.toContain('benefitReductionPct');
    expect(built.changes.find((change) => change.path === 'primary.ageYears')).toMatchObject({ previous: 67, new: 70, changed: true, previousSource: 'scenario' });
  });

  it('keeps the base’s survivor claim ages and inflation categories, which the agent cannot supply', async () => {
    const built = await build({ socialSecurity: { primary: { ageYears: 70 } }, inflation: { ratePct: 4 } });
    expect(built.overrides.socialSecurity?.survivor).toEqual(scenarios.find((scenario) => scenario.id === BASE_ID)!.payload.overrides.socialSecurity?.survivor);
    expect(built.overrides.inflation).toMatchObject({ ratePct: 4, categoryRates: { 'cat-housing': 2.5 } });
    expect(built.kept.some((entry) => entry.path.includes('categoryRates') || entry.path.includes('survivor'))).toBe(false);
  });

  it('a what-if on a grandchild inherits the grandparent’s inflation when the parent sets none', async () => {
    const built = await build({ lifeExpectancy: { primary: 85 } }, INFLATION_GRANDCHILD_ID);
    expect(built.overrides.inflation).toBeUndefined();
    const grandchild = scenarios.find((scenario) => scenario.id === INFLATION_GRANDCHILD_ID)!;
    const throwaway = throwawayFor(grandchild, built.overrides, TEST_NOW);
    const all = [...scenarios, throwaway];
    expect(resolveInflationForScenario(throwaway.id, all).ratePct).toBe(4.5);
    expect(resolveScenario(throwaway.id, all).lifeExpectancy).toEqual({ primary: 85 });
    // And the echo of a change to it names the grandparent's value as the previous one.
    const echo = await build({ inflation: { ratePct: 5 } }, INFLATION_GRANDCHILD_ID);
    expect(echo.changes[0]).toMatchObject({ path: 'ratePct', previous: 4.5, previousSource: 'scenario', new: 5 });
  });

  it('a per-account return for one account leaves every other account’s resolved return identical', async () => {
    const built = await build({ accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: 3.25 } } } });
    const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
    const throwaway = throwawayFor(base, built.overrides, TEST_NOW);
    const accounts = (await loadProjectionInputs()).accounts;
    const before = resolveAccountReturnsForScenario(BASE_ID, scenarios, accounts);
    const after = resolveAccountReturnsForScenario(throwaway.id, [...scenarios, throwaway], accounts);
    for (const account of accounts) {
      if (account.id === ACCOUNT_ID) expect(after.get(account.id)).toBe(3.25);
      else expect(after.get(account.id), account.id).toBe(before.get(account.id));
    }
    expect(before.get(ACCOUNT_ID)).not.toBe(3.25);
  });

  it('reports source default, with the engine default, for a field nothing in the chain set, and scenario otherwise', async () => {
    const built = await build({
      lifeExpectancy: { primary: 90 },
      downturnGuardrails: { enabled: true },
      discretionarySpending: { bumpPct: 10 },
      inflation: { ratePct: 4 },
    });
    const change = (path: string) => built.changes.find((entry) => entry.path === path)!;
    expect(change('primary')).toMatchObject({ previous: DEFAULT_LIFE_EXPECTANCY_AGE, previousSource: 'default', new: 90 });
    expect(change('enabled')).toMatchObject({ previous: DEFAULT_DOWNTURN_GUARDRAILS.enabled, previousSource: 'default', new: true });
    expect(change('bumpPct')).toMatchObject({ previous: null, previousSource: 'default' });
    expect(change('bumpPct').basis).toBeTruthy();
    // The demo base sets its inflation.
    expect(change('ratePct')).toMatchObject({ previous: 3, previousSource: 'scenario', new: 4 });
    // Merging over defaults keeps the rest of the default guardrail bands.
    expect(built.overrides.downturnGuardrails).toMatchObject({ enabled: true, lowerBandPct: DEFAULT_DOWNTURN_GUARDRAILS.lowerBandPct });
  });

  it('ties the other member’s retirement age to the anchor’s date, and refuses one that breaks the tie', async () => {
    const built = await build({ retirementAge: { primary: { ageYears: 62 } } });
    expect(built.overrides.retirementAge).toMatchObject({ primary: { ageYears: 62, ageMonths: 0 }, secondary: { ageYears: 65, ageMonths: 3 }, sameDateAnchor: 'primary' });
    expect(built.changes.filter((change) => change.derived !== undefined).map((change) => change.path)).toEqual(['secondary.ageYears', 'secondary.ageMonths']);
    await expectRejected({ retirementAge: { primary: { ageYears: 62 }, secondary: { ageYears: 60 } } }, 'overrides.retirementAge.secondary', 'same date');
    // The tied age itself is accepted.
    await expect(build({ retirementAge: { primary: { ageYears: 62 }, secondary: { ageYears: 65, ageMonths: 3 } } })).resolves.toBeDefined();
  });

  it('keeps an inherited whole-retirement spending duration when only the bump is supplied', async () => {
    const built = await build({ discretionarySpending: { bumpPct: 20 } }, WHOLE_RETIREMENT_ID);
    expect(built.overrides.discretionarySpending).toEqual({ bumpPct: 20, durationYears: null });
    expect(built.kept.find((entry) => entry.path === 'durationYears')).toMatchObject({ value: null });
  });

  it('ties the ages to a newly chosen anchor even when no age is supplied', async () => {
    const built = await build({ retirementAge: { sameDateAnchor: 'primary' } }, INDEPENDENT_ID);
    expect(built.overrides.retirementAge).toMatchObject({ primary: { ageYears: 65, ageMonths: 0 }, sameDateAnchor: 'primary' });
    const secondary = built.overrides.retirementAge!.secondary!;
    expect(secondary).not.toEqual({ ageYears: 60, ageMonths: 0 });
    expect(built.changes.filter((change) => change.derived !== undefined).map((change) => change.path)).toEqual(['secondary.ageYears', 'secondary.ageMonths']);
  });

  it('lets a null anchor clear an inherited one, so the members can retire on different dates', async () => {
    await expectRejected({ retirementAge: { secondary: { ageYears: 60 } } }, 'overrides.retirementAge.secondary', 'sameDateAnchor');
    const built = await build({ retirementAge: { secondary: { ageYears: 60 }, sameDateAnchor: null } });
    expect(built.overrides.retirementAge).not.toHaveProperty('sameDateAnchor');
    expect(built.overrides.retirementAge).toMatchObject({ secondary: { ageYears: 60, ageMonths: 0 } });
    expect(built.changes.find((change) => change.path === 'sameDateAnchor')).toMatchObject({ previous: 'primary', new: null, changed: true });
  });

  it('notes that guardrail bands do nothing while guardrails are off', async () => {
    const built = await build({ downturnGuardrails: { lowerBandPct: 80 } });
    expect(built.notes.join(' ')).toMatch(/guardrails are off/i);
  });

  it('never mutates the scenarios it reads', async () => {
    const before = JSON.stringify(scenarios);
    await build({ socialSecurity: { primary: { ageYears: 70 } }, inflation: { ratePct: 4 }, accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: 2 } } } });
    expect(JSON.stringify(scenarios)).toBe(before);
    expect(envelopeOf(await call({}))).toBeDefined();
  });
});
