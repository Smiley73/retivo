/**
 * The search on small hand-built households: the shapes the demo dataset does
 * not cover (a spouse who dies inside the window, spending above the 12 %
 * ceiling with and without a later taxable account) and the households it must
 * decline.
 */
import { describe, expect, it } from 'vitest';
import { resolveFederalTaxSnapshotForYear } from '../federal-tax-extrapolation';
import { DEFAULT_TAX_CALIBRATION_BUNDLE, resolveSnapshotYear } from '../tax-integration-helpers';
import { MAX_PROJECTIONS } from './projection';
import { searchRothSuggestions } from './search';
import {
  TOY_BIRTH_YEAR,
  TOY_ROTH_ID,
  toyAccount,
  toyBalances,
  toyProjection,
  type ToyOptions,
} from './test-fixtures';
import type {
  RothCandidate,
  RothSuggestionOk,
  RothSuggestionProgress,
  RothSuggestionRequest,
  RothSuggestionResult,
} from './types';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;
/** The toy scenario's inflation, so tables extrapolate the way the engine does. */
const INFLATION_PCT = 2;
const TIMEOUT = { timeout: 60_000 };

function request(options: ToyOptions = {}, overrides: Partial<RothSuggestionRequest> = {}): RothSuggestionRequest {
  const couple = options.couple ?? true;
  return {
    projection: toyProjection(options),
    targetRothAccountId: TOY_ROTH_ID,
    leftoverTaxRate: 0.2,
    deathAges: couple ? { primary: 90, secondary: 90 } : { primary: 90 },
    ...overrides,
  };
}

async function runOk(
  options: ToyOptions = {},
  overrides: Partial<RothSuggestionRequest> = {},
): Promise<RothSuggestionOk> {
  const result = await searchRothSuggestions(request(options, overrides));
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

function candidate(result: RothSuggestionOk, id: string): RothCandidate {
  const found = result.candidates.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no candidate ${id}`);
  return found;
}

describe('a spouse who dies inside the window', () => {
  // The secondary's death age 70 puts the death in 2036, inside 2028-2040.
  const DEATH_YEAR = TOY_BIRTH_YEAR + 70;
  let result: RothSuggestionOk;

  async function survivorSearch(): Promise<RothSuggestionOk> {
    return runOk({ iraBalance: 3_000_000 }, { deathAges: { primary: 90, secondary: 70 } });
  }

  it('files the later years Single with the Single bracket, deduction and IRMAA schedule', TIMEOUT, async () => {
    result = await survivorSearch();
    expect(result.window).toEqual({ startYear: 2028, endYear: 2040 });
    for (const c of result.candidates.filter((x) => !x.isReference)) {
      for (const record of c.years.filter((r) => r.limits !== null)) {
        const limits = record.limits;
        if (limits === null) continue;
        const survivor = record.year > DEATH_YEAR;
        const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(BUNDLE.federalTax, record.year, INFLATION_PCT);
        const config = snapshot.values[lookupYear];
        const status = survivor ? 'Single' : 'MFJ';
        const brackets = config.brackets[status];
        const at = brackets.findIndex((b) => Math.abs(b.rate - (c.bracketRate ?? 0)) < 1e-9);
        // Both turn 65 in 2031; the dead spouse's add-on goes with them.
        const seniors = record.year < 2031 ? 0 : survivor ? 1 : 2;
        expect(limits.bracket.filingStatus).toBe(status);
        expect(limits.bracket.bracketTopDollars).toBe(brackets[at + 1].floor);
        expect(limits.bracket.standardDeductionDollars).toBe(config.standardDeduction[status]);
        expect(limits.bracket.age65AddOnDollars).toBe(
          seniors * (survivor ? config.age65AddOn.singleOrHoH : config.age65AddOn.mfj),
        );
        if (limits.irmaa.applies && survivor) {
          const { effectiveYear } = resolveSnapshotYear(BUNDLE.irmaa, record.year + 2, INFLATION_PCT);
          expect(limits.irmaa.filingStatus).toBe('Single');
          expect(limits.irmaa.thresholdDollars).toBe(BUNDLE.irmaa.values[effectiveYear].bySingle[0].thresholdDollars);
        }
      }
    }
  });

  it('tiers the surviving spouse on the joint return that set the MAGI, as the engine does', TIMEOUT, async () => {
    result = result ?? (await survivorSearch());
    // The death-year return is still joint, and Medicare reads it two years on,
    // so that year's line is the joint threshold even though the surcharge year
    // is Single. A guarded plan stays under it on the projected rows.
    let checked = 0;
    for (const c of result.candidates.filter((x) => x.guarded === true)) {
      const rows = new Map(c.drawdownYears.map((r) => [r.year, r]));
      for (const record of c.years) {
        const irmaa = record.limits?.irmaa;
        if (irmaa === undefined || !irmaa.applies || record.year !== DEATH_YEAR) continue;
        const { effectiveYear } = resolveSnapshotYear(BUNDLE.irmaa, record.year + 2, INFLATION_PCT);
        const singleLine = BUNDLE.irmaa.values[effectiveYear].bySingle[0].thresholdDollars;
        expect(irmaa.filingStatus).toBe('MFJ');
        expect(irmaa.valueDollars).toBeGreaterThan(singleLine);
        // MAGI above the Single line but under the joint line stays tier none.
        if (record.magiCents / 100 > singleLine * irmaa.scalingFactor) {
          checked += 1;
          expect(rows.get(record.year + 2)?.irmaaTier ?? 'none').toBe('none');
        }
      }
      expect(c.unranked.filter((u) => u.kind === 'guard-crossed')).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('spending above the 12 % ceiling', () => {
  const HOUSEHOLD: ToyOptions = { iraBalance: 3_000_000, annualExpense: 170_000 };

  it('reroutes to a later taxable account: ranked, and flagged', TIMEOUT, async () => {
    const result = await runOk({ ...HOUSEHOLD, rothBalance: 900_000 });
    const plan = candidate(result, 'bracket-12-guarded');
    const fromRows = plan.drawdownYears.filter((r) => (r.magiCapTierOverrideDollars ?? 0) > 0).map((r) => r.year);
    expect(fromRows.length).toBeGreaterThan(0);
    expect(plan.reroutedYears).toEqual(fromRows);
    expect(plan.drawdownYears.some((r) => (r.magiCapBreachDollars ?? 0) > 0)).toBe(false);
    expect(plan.unranked).toEqual([]);
    expect(plan.rank).not.toBeNull();
    expect(result.rankedIds).toContain(plan.id);
    for (const record of plan.years.filter((r) => fromRows.includes(r.year))) {
      expect(record.reroutedDollars).toBeGreaterThan(0);
      expect(record.breachedDollars).toBe(0);
    }
  });

  it('breaches without one: unranked, with the years', TIMEOUT, async () => {
    const result = await runOk({ ...HOUSEHOLD, rothBalance: 0 });
    const plan = candidate(result, 'bracket-12-guarded');
    const breached = plan.drawdownYears.filter((r) => (r.magiCapBreachDollars ?? 0) > 0).map((r) => r.year);
    expect(breached.length).toBeGreaterThan(0);
    expect(plan.unranked).toContainEqual({ kind: 'cap-breached', years: breached });
    expect(plan.rank).toBeNull();
    expect(result.rankedIds).not.toContain(plan.id);
    for (const record of plan.years.filter((r) => breached.includes(r.year))) {
      expect(record.stop).toBe('breach');
      expect(record.breachedDollars).toBeGreaterThan(0);
    }
    // A higher bracket's ceiling leaves room for the same spending, so it is ranked.
    expect(candidate(result, 'bracket-24-guarded').rank).not.toBeNull();
  });
});

describe('households the search declines', () => {
  async function reasonFor(options: ToyOptions, overrides: Partial<RothSuggestionRequest> = {}): Promise<string> {
    const result = await searchRothSuggestions(request(options, overrides));
    if (result.kind !== 'unsupported') throw new Error(`expected unsupported, got ${result.kind}`);
    return result.reason;
  }

  it('has no Roth IRA to convert into', async () => {
    expect(await reasonFor({}, { targetRothAccountId: 'missing' })).toBe('no-roth-ira');
  });

  it('is offered an inherited Roth IRA', async () => {
    const base = request();
    const projection = {
      ...base.projection,
      accounts: base.projection.accounts.map((a) =>
        a.id === TOY_ROTH_ID ? toyAccount(TOY_ROTH_ID, 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', { rmdInheritedAccount: true }) : a,
      ),
    };
    const result = await searchRothSuggestions({ ...base, projection });
    expect(result).toEqual({ kind: 'unsupported', reason: 'no-roth-ira' });
  });

  it('retires at the RMD trigger age, so there is no window', async () => {
    // Born 1966, the trigger age is 75; retiring at 75 leaves no year before it.
    const retireAt75 = { primary: { ageYears: 75, ageMonths: 0 }, secondary: { ageYears: 75, ageMonths: 0 } };
    expect(await reasonFor({ overrides: { retirementAge: retireAt75 } })).toBe('no-retirement-window');
  });

  it('files separate returns', async () => {
    const separate = {
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    } as const;
    expect(await reasonFor({ overrides: { taxFilingPlan: separate } })).toBe('separate-filing-plan');
  });

  it('has a filing plan that cannot be resolved', async () => {
    // A couple with a stored Single status: which spouse's return is dropped is ambiguous.
    expect(await reasonFor({ overrides: { taxFilingPlan: undefined, filingStatus: 'Single' } })).toBe(
      'filing-unresolved',
    );
  });

  it('has an unconfigured cash balance plan', async () => {
    const base = request();
    const projection = {
      ...base.projection,
      accounts: [...base.projection.accounts, toyAccount('cbp', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX')],
      balances: [...base.projection.balances, ...toyBalances({ cbp: 200_000 })],
    };
    expect(await searchRothSuggestions({ ...base, projection })).toEqual({
      kind: 'unsupported',
      reason: 'cbp-unconfigured',
    });
  });

  it('has no primary member', async () => {
    const base = request();
    const projection = {
      ...base.projection,
      members: base.projection.members.map((m) => ({ ...m, payload: { ...m.payload, isPrimary: false } })),
    };
    expect(await searchRothSuggestions({ ...base, projection })).toEqual({
      kind: 'unsupported',
      reason: 'no-primary-retirement',
    });
  });

  it('has no portfolio to draw down', async () => {
    expect(await reasonFor({ iraBalance: 0, rothBalance: 0 })).toBe('no-projection');
  });
});

describe('an engine failure the caller can show', () => {
  it('surfaces a missing custom drawdown order as an error with its message', async () => {
    const result: RothSuggestionResult = await searchRothSuggestions(
      request({ overrides: { withdrawalStrategy: { kind: 'customOrder' } } }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/customOrder/);
  });
});

describe('arguments a caller should never send', () => {
  it.each([
    ['a leftover rate of 1', { leftoverTaxRate: 1 }],
    ['a negative leftover rate', { leftoverTaxRate: -0.01 }],
    ['a NaN leftover rate', { leftoverTaxRate: Number.NaN }],
    ['a death age of 0', { deathAges: { primary: 0, secondary: 90 } }],
    ['a death age past the maximum', { deathAges: { primary: 90, secondary: 101 } }],
    ['a fractional death age', { deathAges: { primary: 80.5, secondary: 90 } }],
    ['no secondary death age for a couple', { deathAges: { primary: 90 } }],
  ] as const)('rejects %s', async (_label, overrides) => {
    await expect(searchRothSuggestions(request({}, overrides))).rejects.toThrow(RangeError);
  });

  it('rejects an unknown scenario', async () => {
    const base = request();
    await expect(
      searchRothSuggestions({ ...base, projection: { ...base.projection, selectedScenarioId: 'nope' } }),
    ).rejects.toThrow(RangeError);
  });

  it('accepts a leftover rate of 0 (the boundary of [0, 1))', async () => {
    const result = await searchRothSuggestions(request({}, { leftoverTaxRate: 0, signal: AbortSignal.abort() }));
    expect(result.kind).toBe('cancelled');
  });
});

describe('progress and cancellation', () => {
  it('ticks once per projection and reaches 100 % of the candidates on the last one', TIMEOUT, async () => {
    const ticks: RothSuggestionProgress[] = [];
    const result = await runOk({}, { onProgress: (p) => ticks.push(p) });
    expect(ticks.length).toBe(result.projectionsRun);
    expect(ticks.map((t) => t.projectionsRun)).toEqual(ticks.map((_, i) => i + 1));
    expect(ticks[0]).toEqual({ projectionsRun: 1, candidatesDone: 1, candidatesTotal: 9 });
    expect(ticks.map((t) => t.candidatesDone)).toEqual([...ticks.map((t) => t.candidatesDone)].sort((a, b) => a - b));
    expect(ticks[ticks.length - 1].candidatesDone).toBe(9);
    expect(result.projectionsRun).toBeLessThanOrEqual(MAX_PROJECTIONS);
  });

  it('stops after k ticks: cancelled, at most k + 1 projections, no further ticks', TIMEOUT, async () => {
    const k = 3;
    const controller = new AbortController();
    const ticks: RothSuggestionProgress[] = [];
    const result = await searchRothSuggestions(
      request(
        {},
        {
          signal: controller.signal,
          onProgress: (p) => {
            ticks.push(p);
            if (ticks.length === k) controller.abort();
          },
        },
      ),
    );
    expect(result.kind).toBe('cancelled');
    if (result.kind !== 'cancelled') return;
    expect(result.projectionsRun).toBeLessThanOrEqual(k + 1);
    expect(ticks.length).toBe(k);
  });

  it('resolves cancelled without running anything when already aborted', async () => {
    const ticks: RothSuggestionProgress[] = [];
    const result = await searchRothSuggestions(
      request({}, { signal: AbortSignal.abort(), onProgress: (p) => ticks.push(p) }),
    );
    expect(result).toEqual({ kind: 'cancelled', projectionsRun: 0 });
    expect(ticks).toEqual([]);
  });

  it('yields a macrotask between projections so a queued cancel is delivered', TIMEOUT, async () => {
    const controller = new AbortController();
    let lastTick = 0;
    const search = searchRothSuggestions(
      request({}, { signal: controller.signal, onProgress: (p) => (lastTick = p.projectionsRun) }),
    );
    // A timer is a macrotask: it only runs if the search lets the loop turn.
    let projectionsWhenTimerRan = -1;
    setTimeout(() => {
      projectionsWhenTimerRan = lastTick;
      controller.abort();
    }, 0);
    const result = await search;
    expect(result.kind).toBe('cancelled');
    expect(projectionsWhenTimerRan).toBeGreaterThanOrEqual(0);
    expect(projectionsWhenTimerRan).toBeLessThan(5);
  });
});

describe('determinism', () => {
  it('gives the same answer for the same inputs', TIMEOUT, async () => {
    const options: ToyOptions = { brokerage: true, iraBalance: 2_000_000 };
    expect(await runOk(options)).toEqual(await runOk(options));
  });

});
