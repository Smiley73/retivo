import { describe, expect, it } from 'vitest';
import type { HouseholdMemberPayload, Aggregate } from '../../db/types';
import { formatCurrency } from '../../lib/format-currency';
import { searchRothSuggestions } from '../../lib/roth-suggestion/search';
import { TOY_ROTH_ID, toyProjection, toyScenario } from '../../lib/roth-suggestion/test-fixtures';
import type {
  CandidateAfterTax,
  CandidateTotals,
  UnrankedReason,
} from '../../lib/roth-suggestion/types';
import type {
  RothSuggestionWorkerCandidate,
  RothSuggestionWorkerResult,
} from '../../workers/roth-suggestion.worker';
import { buildRothBETRPageData, type AccountOption, type RothBETRPageData } from './roth-betr-data';
import {
  LEFTOVER_TAX_FALLBACK_PCT,
  buildSuggestionTable,
  buildSuggestionWorkerInput,
  defaultLeftoverTaxPct,
  describeDeathAges,
  formatSignedDollars,
  leftoverTaxFraction,
  rerankResult,
  resolveAssumedDeathAges,
  suggestionAvailability,
  suggestionDataSignature,
  type RothSuggestionRow,
} from './roth-suggestion-view-model';

const ZERO_TOTALS: CandidateTotals = {
  yearsConverted: 0,
  totalConvertedTodayDollars: 0,
  incomeTaxTodayDollars: 0,
  irmaaTodayDollars: 0,
  acaCreditTodayDollars: 0,
};

interface CandidateSpec {
  readonly id: string;
  readonly bracketRate?: number | null;
  readonly guarded?: boolean | null;
  readonly ending?: number;
  readonly preTax?: number;
  readonly totals?: Partial<CandidateTotals>;
  readonly delta?: Partial<CandidateTotals>;
  readonly unranked?: readonly UnrankedReason[];
  readonly reroutedYears?: readonly number[];
}

function candidate(spec: CandidateSpec): RothSuggestionWorkerCandidate {
  const isReference = spec.id === 'current-plan';
  const afterTax: CandidateAfterTax = {
    endingTodayDollars: spec.ending ?? 1_000_000,
    preTaxTodayDollars: spec.preTax ?? 0,
    afterTaxTodayDollars: 0,
    deltaVsReferenceTodayDollars: 0,
  };
  return {
    id: spec.id,
    isReference,
    bracketRate: isReference ? null : (spec.bracketRate ?? 0.22),
    guarded: isReference ? null : (spec.guarded ?? true),
    ladder: [],
    years: [],
    totals: { ...ZERO_TOTALS, yearsConverted: 3, totalConvertedTodayDollars: 100_000, ...spec.totals },
    deltaVsReference: { ...ZERO_TOTALS, ...spec.delta },
    afterTax,
    rank: null,
    unranked: spec.unranked ?? [],
    reroutedYears: spec.reroutedYears ?? [],
    passes: 1,
    converged: true,
  };
}

function resultOf(specs: readonly CandidateSpec[]): RothSuggestionWorkerResult {
  return {
    kind: 'ok',
    candidates: specs.map(candidate),
    rankedIds: [],
    window: { startYear: 2028, endYear: 2040 },
    horizonYear: 2056,
    leftoverTaxRate: 0,
    deathAges: { primary: 90 },
    projectionsRun: 10,
  };
}

function rowsOf(result: RothSuggestionWorkerResult, rate: number): readonly RothSuggestionRow[] {
  const table = buildSuggestionTable(result, rate);
  if (table.kind !== 'rows') throw new Error('expected rows');
  return table.rows;
}

describe('defaultLeftoverTaxPct', () => {
  it('follows the page RMD-era rate rounded to a whole percent', () => {
    expect(defaultLeftoverTaxPct(0.224)).toBe(22);
    expect(defaultLeftoverTaxPct(0.236)).toBe(24);
    expect(defaultLeftoverTaxPct(0.12)).toBe(12);
  });

  it('falls back to the documented default when there are no RMD-era rows', () => {
    expect(defaultLeftoverTaxPct(0)).toBe(LEFTOVER_TAX_FALLBACK_PCT);
    expect(defaultLeftoverTaxPct(0.001)).toBe(LEFTOVER_TAX_FALLBACK_PCT);
  });
});

describe('leftoverTaxFraction', () => {
  it('turns percent into a fraction the search accepts', () => {
    expect(leftoverTaxFraction(22)).toBe(0.22);
    expect(leftoverTaxFraction(0)).toBe(0);
    expect(leftoverTaxFraction(150)).toBe(0.99);
    expect(leftoverTaxFraction(-5)).toBe(0);
    expect(leftoverTaxFraction(Number.NaN)).toBe(0);
  });
});

describe('suggestionAvailability', () => {
  const roth: AccountOption = { id: 'roth', name: 'My Roth', type: 'RETIREMENT_ROTH_IRA', ownerId: 'm1' };
  const couple = toyProjection({ couple: true });

  function page(over: {
    retirementYear?: number;
    rothIraAccounts?: AccountOption[];
  }): RothBETRPageData {
    return {
      ctx: {
        filingStatus: 'MFJ',
        ownerBirthYear: 1966,
        retirementYear: over.retirementYear ?? 2028,
        lifeExpectancyAnchorYear: 2056,
        currentCalendarYear: 2026,
      },
      rothIraAccounts: over.rothIraAccounts ?? [roth],
    } as unknown as RothBETRPageData;
  }

  it('is ready with the first Roth IRA as the target', () => {
    expect(suggestionAvailability(page({}), couple, 'toy')).toEqual({ kind: 'ready', targetRoth: roth });
  });

  it('explains that no own Roth IRA is on file', () => {
    expect(suggestionAvailability(page({ rothIraAccounts: [] }), couple, 'toy')).toEqual({
      kind: 'unavailable',
      reason: 'no-roth-ira',
    });
  });

  it('explains that no retirement year falls before the RMD age', () => {
    // Born 1966: the RMD trigger age is 75, so 2041 is the first year past it.
    expect(suggestionAvailability(page({ retirementYear: 2041 }), couple, 'toy')).toEqual({
      kind: 'unavailable',
      reason: 'no-retirement-window',
    });
  });

  describe('a scenario whose filing plan files separate returns', () => {
    const separate = toyProjection({
      couple: true,
      overrides: {
        taxFilingPlan: {
          kind: 'separate',
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
          ],
        },
      },
    });

    it('declines, ahead of the other reasons', () => {
      expect(suggestionAvailability(page({ rothIraAccounts: [] }), separate, 'toy')).toEqual({
        kind: 'unavailable',
        reason: 'separate-filing',
      });
    });

    it('declines on page data built from the scenario, whose scalar filing status is never MFS', () => {
      const built = buildRothBETRPageData(separate);
      if (built === null) throw new Error('separate-filing page data is null');
      expect(built.ctx.filingStatus).not.toBe('MFS');
      expect(suggestionAvailability(built, separate, 'toy')).toEqual({
        kind: 'unavailable',
        reason: 'separate-filing',
      });
    });
  });
});

describe('resolveAssumedDeathAges and describeDeathAges', () => {
  it('reads the scenario life expectancies and names them', () => {
    const projection = toyProjection({ couple: true });
    const ages = resolveAssumedDeathAges(projection.scenarios, 'toy', projection.members);
    expect(ages).toEqual({ primary: 90, secondary: 90 });
    expect(describeDeathAges(ages, projection.members)).toBe('age 90 for m1 and 90 for m2');
  });

  it('sends no partner age for a single household and names one age', () => {
    const projection = toyProjection({ couple: false });
    const ages = resolveAssumedDeathAges(projection.scenarios, 'toy', projection.members);
    expect(ages).toEqual({ primary: 90 });
    expect(describeDeathAges(ages, projection.members)).toBe('age 90');
  });

  it('falls back to the default age where the scenario sets none', () => {
    const projection = toyProjection({ couple: false });
    const scenario = toyScenario();
    const bare = {
      ...scenario,
      payload: { ...scenario.payload, overrides: { ...scenario.payload.overrides, lifeExpectancy: undefined } },
    };
    expect(resolveAssumedDeathAges([bare], 'toy', projection.members)).toEqual({ primary: 95 });
  });

  it('leaves the partner age unset for a couple whose scenario stores only the primary age', () => {
    const projection = toyProjection({ couple: true });
    const scenario = toyScenario();
    const primaryOnly = {
      ...scenario,
      payload: { ...scenario.payload, overrides: { ...scenario.payload.overrides, lifeExpectancy: { primary: 85 } } },
    };
    const ages = resolveAssumedDeathAges([primaryOnly], 'toy', projection.members);
    expect(ages).toEqual({ primary: 85 });
    expect(describeDeathAges(ages, projection.members)).toBe(
      'age 85 for m1 and the age your projection assumes for m2',
    );
  });

  it('names members by first name when they have one', () => {
    const projection = toyProjection({ couple: true });
    const named = projection.members.map(
      (m, i): Aggregate<HouseholdMemberPayload> => ({
        ...m,
        payload: { ...m.payload, firstName: i === 0 ? 'Alex' : 'Sam' },
      }),
    );
    expect(describeDeathAges({ primary: 91, secondary: 88 }, named)).toBe('age 91 for Alex and 88 for Sam');
  });
});

describe('suggestionDataSignature', () => {
  it('changes when a row version changes and not otherwise', () => {
    const base = toyProjection();
    const same = suggestionDataSignature(base);
    expect(suggestionDataSignature({ ...base })).toBe(same);
    const bumped = { ...base, accounts: base.accounts.map((a, i) => (i === 0 ? { ...a, version: 2 } : a)) };
    expect(suggestionDataSignature(bumped)).not.toBe(same);
  });
});

describe('formatSignedDollars', () => {
  it('shows a sign on every non-zero value and none on zero', () => {
    expect(formatSignedDollars(1234.4)).toBe('+$1,234');
    expect(formatSignedDollars(-1234.6)).toBe('−$1,235');
    expect(formatSignedDollars(0)).toBe('$0');
    expect(formatSignedDollars(0.3)).toBe('$0');
    expect(formatSignedDollars(-0.3)).toBe('$0');
  });
});

describe('rerankResult', () => {
  const result = resultOf([
    { id: 'current-plan', ending: 1_000_000, preTax: 800_000, totals: { totalConvertedTodayDollars: 0 } },
    { id: 'bracket-12-guarded', bracketRate: 0.12, ending: 950_000, preTax: 400_000 },
    { id: 'bracket-22-guarded', bracketRate: 0.22, ending: 900_000, preTax: 100_000 },
  ]);

  it('ranks on ending minus pre-tax times the rate, without projecting', () => {
    const low = rerankResult(result, 0);
    expect(low.rankedIds).toEqual(['current-plan', 'bracket-12-guarded', 'bracket-22-guarded']);

    const high = rerankResult(result, 0.4);
    // 1,000,000 - 320,000 = 680,000; 950,000 - 160,000 = 790,000; 900,000 - 40,000 = 860,000
    expect(high.rankedIds).toEqual(['bracket-22-guarded', 'bracket-12-guarded', 'current-plan']);
    expect(high.candidates.map((c) => c.rank)).toEqual([3, 2, 1]);
    expect(high.candidates.map((c) => c.afterTax.afterTaxTodayDollars)).toEqual([680_000, 790_000, 860_000]);
    expect(high.candidates.map((c) => c.afterTax.deltaVsReferenceTodayDollars)).toEqual([0, 110_000, 180_000]);
    expect(high.leftoverTaxRate).toBe(0.4);
  });

  it('leaves an unranked candidate unranked whatever the rate', () => {
    const withBreach = resultOf([
      { id: 'current-plan', ending: 1_000_000 },
      { id: 'bracket-12-guarded', bracketRate: 0.12, ending: 2_000_000, unranked: [{ kind: 'cap-breached', years: [2030] }] },
    ]);
    const ranked = rerankResult(withBreach, 0);
    expect(ranked.rankedIds).toEqual(['current-plan']);
    expect(ranked.candidates[1].rank).toBeNull();
  });
});

describe('buildSuggestionTable', () => {
  it('sorts by after-tax ending balance with unranked plans last, the current plan at its rank', () => {
    const result = resultOf([
      { id: 'current-plan', ending: 900_000 },
      { id: 'bracket-12-guarded', bracketRate: 0.12, ending: 1_000_000 },
      { id: 'bracket-22-guarded', bracketRate: 0.22, ending: 2_000_000, unranked: [{ kind: 'cap-breached', years: [2030, 2031] }] },
      { id: 'bracket-24-guarded', bracketRate: 0.24, ending: 950_000 },
    ]);
    const rows = rowsOf(result, 0.2);
    expect(rows.map((r) => r.id)).toEqual([
      'bracket-12-guarded',
      'bracket-24-guarded',
      'current-plan',
      'bracket-22-guarded',
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, null]);
    expect(rows.map((r) => r.isTop)).toEqual([true, false, false, false]);
    expect(rows[2].isReference).toBe(true);
    expect(rows[2].label).toBe('Current plan');
    expect(rows[3].notRanked).toBe('Not ranked: cap not met in 2 years');
    expect(rows[0].notRanked).toBe('');
  });

  it('shows the current plan with zero differences and signed values elsewhere', () => {
    const result = resultOf([
      { id: 'current-plan' },
      {
        id: 'bracket-12-guarded',
        bracketRate: 0.12,
        totals: { irmaaTodayDollars: 4200, yearsConverted: 5, totalConvertedTodayDollars: 250_000 },
        delta: {
          incomeTaxTodayDollars: -8000,
          irmaaTodayDollars: 1100,
          acaCreditTodayDollars: -2500,
        },
      },
    ]);
    const [reference, other] = [...rowsOf(result, 0)].sort((a) => (a.isReference ? -1 : 1));
    expect(reference.extraIncomeTax).toBe('$0');
    expect(reference.irmaaSurcharges).toBe('$0 ($0)');
    expect(reference.acaCreditChange).toBe('$0');
    expect(other.extraIncomeTax).toBe('−$8,000');
    expect(other.irmaaSurcharges).toBe('$4,200 (+$1,100)');
    expect(other.acaCreditChange).toBe('−$2,500');
    expect(other.yearsConverted).toBe(5);
    expect(other.totalConverted).toBe('$250,000');
    expect(other.bracket).toBe('12%');
    expect(other.label).toBe('Fill the 12% bracket');
  });

  it('marks a plan whose ceiling rerouted spending withdrawals', () => {
    const rows = rowsOf(
      resultOf([
        { id: 'current-plan' },
        { id: 'bracket-12-guarded', bracketRate: 0.12, reroutedYears: [2031, 2032] },
      ]),
      0,
    );
    expect(rows.find((r) => r.id === 'bracket-12-guarded')?.reroutedYears).toEqual([2031, 2032]);
    expect(rows.find((r) => r.isReference)?.reroutedYears).toEqual([]);
  });

  it('says whether the cliff lines were kept', () => {
    const rows = rowsOf(
      resultOf([
        { id: 'current-plan' },
        { id: 'bracket-12-guarded', bracketRate: 0.12, guarded: true },
        { id: 'bracket-12-unguarded', bracketRate: 0.12, guarded: false },
        {
          id: 'bracket-22-guarded',
          bracketRate: 0.22,
          guarded: true,
          unranked: [{ kind: 'guard-crossed', crossings: [{ year: 2031, line: 'aca' }] }],
        },
      ]),
      0,
    );
    const cliffs = Object.fromEntries(rows.map((r) => [r.id, r.cliffs]));
    expect(cliffs).toEqual({
      'current-plan': 'Not assessed',
      'bracket-12-guarded': 'Kept under both lines',
      'bracket-12-unguarded': 'Not limited',
      'bracket-22-guarded': 'Crossed a line',
    });
    expect(rows.find((r) => r.id === 'bracket-22-guarded')?.notRanked).toBe(
      'Not ranked: crossed the health-subsidy line in 1 year',
    );
  });

  it('is one notice, not a table, when every plan converts $0', () => {
    const none = { totals: { totalConvertedTodayDollars: 0, yearsConverted: 0 } };
    const result = resultOf([
      { id: 'current-plan', ...none },
      { id: 'bracket-12-guarded', bracketRate: 0.12, ...none },
    ]);
    expect(buildSuggestionTable(result, 0.2)).toEqual({ kind: 'no-room' });
  });

  it('still shows the table when only the current plan converts', () => {
    const result = resultOf([
      { id: 'current-plan' },
      { id: 'bracket-12-guarded', bracketRate: 0.12, totals: { totalConvertedTodayDollars: 0, yearsConverted: 0 } },
    ]);
    expect(buildSuggestionTable(result, 0.2).kind).toBe('rows');
  });

  it('re-ranks the rows when the rate changes', () => {
    const result = resultOf([
      { id: 'current-plan', ending: 1_000_000, preTax: 800_000 },
      { id: 'bracket-22-guarded', ending: 900_000, preTax: 100_000 },
    ]);
    expect(rowsOf(result, 0).map((r) => r.id)).toEqual(['current-plan', 'bracket-22-guarded']);
    expect(rowsOf(result, 0.3).map((r) => r.id)).toEqual(['bracket-22-guarded', 'current-plan']);
  });
});

describe('against a real search on the toy household', () => {
  const TIMEOUT = { timeout: 60_000 };

  it('builds the worker input from the page data, so the reference row equals the page', TIMEOUT, async () => {
    const projection = toyProjection({ couple: false });
    const pageData = buildRothBETRPageData(projection);
    expect(pageData).not.toBeNull();
    if (pageData === null) return;
    const input = buildSuggestionWorkerInput({
      data: projection,
      pageData,
      selectedScenarioId: 'toy',
      targetRothAccountId: TOY_ROTH_ID,
      leftoverTaxPct: 20,
    });
    expect(input.projection.todayYear).toBe(projection.todayYear);
    expect(input.projection.todayMonthIndex).toBe(projection.todayMonthIndex);
    expect(input.leftoverTaxRate).toBe(0.2);

    const result = await searchRothSuggestions({ ...input, projection: { ...input.projection } });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.candidates[0].drawdownYears).toEqual(pageData.drawdownYears);
  });

  it('shows lifetime totals in today dollars, below the nominal sums of the projection rows', TIMEOUT, async () => {
    const projection = toyProjection({ couple: false });
    const pageData = buildRothBETRPageData(projection);
    if (pageData === null) throw new Error('no page data');
    const input = buildSuggestionWorkerInput({
      data: projection,
      pageData,
      selectedScenarioId: 'toy',
      targetRothAccountId: TOY_ROTH_ID,
      leftoverTaxPct: 20,
    });
    const result = await searchRothSuggestions(input);
    if (result.kind !== 'ok') throw new Error('expected ok');
    const slim: RothSuggestionWorkerResult = {
      ...result,
      candidates: result.candidates.map(({ drawdownYears: _rows, ...rest }) => {
        void _rows;
        return rest;
      }),
    };
    const rows = rowsOf(slim, 0.2);
    const filled = result.candidates.find((c) => !c.isReference && c.totals.totalConvertedTodayDollars > 0);
    if (filled === undefined) throw new Error('no converting candidate');
    const nominal = filled.drawdownYears.reduce((sum, y) => sum + (y.rothConvertedCents ?? 0) / 100, 0);
    const shown = filled.totals.totalConvertedTodayDollars;
    // The toy scenario inflates at 2 % a year, 2028 through 2040 for the window.
    expect(shown).toBeLessThan(nominal);
    expect(shown / nominal).toBeGreaterThan(Math.pow(1.02, -15));
    expect(shown / nominal).toBeLessThan(Math.pow(1.02, -1));
    expect(rows.find((r) => r.id === filled.id)?.totalConverted).toBe(formatCurrency(shown));
  });
});
