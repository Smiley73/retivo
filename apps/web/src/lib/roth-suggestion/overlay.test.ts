import { describe, expect, it } from 'vitest';
import type { MagiCapWindow } from '../../db/types';
import { resolveScenario, type ScenarioAggregate } from '../scenario-resolution';
import { overlayScenarios } from './overlay';
import { toyScenario } from './test-fixtures';

const PARENT_WINDOW: MagiCapWindow = {
  start: { kind: 'retirementStart' },
  end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  magiCeilingAnnualDollars: 90_000,
  capMode: 'minimize',
  capMagiLine: 'irmaa',
};

const LADDER: MagiCapWindow[] = [
  {
    start: { kind: 'year', year: 2030 },
    end: { kind: 'year', year: 2030 },
    magiCeilingAnnualDollars: 120_000,
    capMode: 'fill',
    capMagiLine: 'irmaa',
    targetRothAccountId: 'roth',
  },
];

function family(parentOverrides: Parameters<typeof toyScenario>[0]): ScenarioAggregate[] {
  const parent = { ...toyScenario(parentOverrides), id: 'parent' };
  const base = toyScenario();
  const child: ScenarioAggregate = {
    ...base,
    id: 'child',
    payload: { ...base.payload, parentScenarioId: 'parent', overrides: {} },
  };
  return [parent, child];
}

describe('overlayScenarios', () => {
  it('seeds the life expectancy from the resolved block so an inherited age survives', () => {
    const scenarios = family({ lifeExpectancy: { primary: 88, secondary: 91 } });
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 80 } });
    expect(resolveScenario('child', overlaid).lifeExpectancy).toEqual({ primary: 80, secondary: 91 });
  });

  it('sets both ages when both are given', () => {
    const scenarios = family({ lifeExpectancy: { primary: 88, secondary: 91 } });
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 80, secondary: 85 } });
    expect(resolveScenario('child', overlaid).lifeExpectancy).toEqual({ primary: 80, secondary: 85 });
  });

  it('places a ladder as a local block that shadows the parent cap entirely', () => {
    const scenarios = family({ magiCap: { windows: [PARENT_WINDOW] } });
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 90 }, ladder: LADDER });
    expect(resolveScenario('child', overlaid).magiCap).toEqual({ windows: LADDER });
  });

  it('writes no cap without a ladder, so the chain is inherited', () => {
    const scenarios = family({ magiCap: { windows: [PARENT_WINDOW] } });
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 90 } });
    expect(resolveScenario('child', overlaid).magiCap).toEqual({ windows: [PARENT_WINDOW] });
  });

  it('inherits a disable sentinel too', () => {
    const scenarios = family({ magiCap: { disabled: true } });
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 90 } });
    expect(resolveScenario('child', overlaid).magiCap).toEqual({ disabled: true });
  });

  it('leaves the other scenarios and the input untouched', () => {
    const scenarios = family({ lifeExpectancy: { primary: 88, secondary: 91 } });
    const before = JSON.stringify(scenarios);
    const overlaid = overlayScenarios({ scenarios, scenarioId: 'child', deathAges: { primary: 80 }, ladder: LADDER });
    expect(JSON.stringify(scenarios)).toBe(before);
    expect(overlaid[0]).toBe(scenarios[0]);
    expect(overlaid[1]).not.toBe(scenarios[1]);
  });
});
