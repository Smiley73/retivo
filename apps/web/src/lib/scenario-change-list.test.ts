import { describe, expect, it } from 'vitest';
import type { ScenarioOverrides } from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import { buildScenarioChangeList } from './scenario-change-list';

function scenario(
  id: string,
  parentScenarioId: string | null,
  overrides: ScenarioOverrides,
): ScenarioAggregate {
  return { id, payload: { name: id, parentScenarioId, overrides } } as unknown as ScenarioAggregate;
}

const keysOf = (list: ReturnType<typeof buildScenarioChangeList>) =>
  list.groups.flatMap((g) => g.changes.flatMap((c) => c.keys));

describe('buildScenarioChangeList', () => {
  it('counts the sparse sections only when they carry something', () => {
    const scenarios = [
      scenario('base', null, {}),
      scenario('empty', 'base', {
        income: { disabledIds: [], patches: {}, added: [] },
        expenses: { reEnabledIds: [] },
        accountFloors: { perAccount: {} },
        accountAssetMix: { perAccount: {} },
      }),
      scenario('filled', 'base', {
        income: { disabledIds: ['aggregate:i1'] },
        accountFloors: { perAccount: { a: { floorDollars: 1 } } },
        qualifiedCharitableDistributions: [],
      }),
    ];
    expect(keysOf(buildScenarioChangeList('empty', 'base', scenarios))).toEqual([]);
    expect(keysOf(buildScenarioChangeList('filled', 'base', scenarios))).toEqual([
      'income',
      'qualifiedCharitableDistributions',
      'accountFloors',
    ]);
  });

  it('groups by the detail page titles in its order, without repeating a key', () => {
    const scenarios = [
      scenario('base', null, {}),
      scenario('mid', 'base', { acaFplRegion: 'alaska', retirementAge: { primary: { ageYears: 60, ageMonths: 0 } } }),
      scenario('leaf', 'mid', { retirementAge: { primary: { ageYears: 61, ageMonths: 0 } }, inflation: { ratePct: 4 } }),
    ];
    const list = buildScenarioChangeList('leaf', 'base', scenarios);
    expect(list.relation).toBe('descendant');
    expect(list.groups.map((g) => g.title)).toEqual([
      'Timing & longevity',
      'Income & expenses',
      'Withdrawals & taxes',
    ]);
    expect(keysOf(list)).toEqual(['retirementAge', 'inflation', 'acaFplRegion']);
  });

  it('lists a card once however many of its keys are set, and omits the working-years taxable income', () => {
    const scenarios = [
      scenario('base', null, {}),
      scenario('leaf', 'base', {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: { enabled: false } as never,
        taxFilingPlan: undefined,
        preRetirementTaxableIncomeDollars: 50_000,
      }),
    ];
    const { groups } = buildScenarioChangeList('leaf', 'base', scenarios);
    expect(groups).toEqual([
      {
        title: 'Withdrawals & taxes',
        changes: [{ card: 'Withdrawal strategy', keys: ['withdrawalStrategy', 'magiCap'] }],
      },
    ]);
  });
});
