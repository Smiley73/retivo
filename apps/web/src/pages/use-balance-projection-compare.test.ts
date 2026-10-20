/**
 * The Compare tab's comparison-id resolution order: a valid `?with=`, then the
 * remembered choice for the viewed scenario, then the viewed scenario's parent,
 * then none. "Valid" means it names a live scenario other than the viewed one.
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { resolveComparisonId } from './use-balance-projection-compare';

function scenario(id: string, parentScenarioId: string | null): ScenarioAggregate {
  return {
    id,
    payload: { name: id, parentScenarioId, isPrimary: parentScenarioId === null, overrides: {} },
  } as unknown as ScenarioAggregate;
}

const SCENARIOS = [scenario('base', null), scenario('early', 'base'), scenario('delay', 'base')];

function resolve(
  viewedId: string,
  withParam: string | null,
  remembered: Record<string, string> = {},
  scenarios: ReadonlyArray<ScenarioAggregate> = SCENARIOS,
): string | null {
  return resolveComparisonId({
    viewedId,
    scenarios,
    withParam,
    remembered: new Map(Object.entries(remembered)),
  });
}

describe('resolveComparisonId', () => {
  it('prefers ?with= over the remembered choice and the parent', () => {
    expect(resolve('early', 'delay', { early: 'base' })).toBe('delay');
  });

  it('uses the remembered choice for the viewed scenario when there is no valid ?with=', () => {
    expect(resolve('early', null, { early: 'delay' })).toBe('delay');
    expect(resolve('early', 'early', { early: 'delay' })).toBe('delay');
    expect(resolve('early', 'gone', { early: 'delay' })).toBe('delay');
  });

  it('keeps one remembered choice per viewed scenario', () => {
    const remembered = { early: 'delay', delay: 'early' };
    expect(resolve('early', null, remembered)).toBe('delay');
    expect(resolve('delay', null, remembered)).toBe('early');
  });

  it('falls back to the parent when the remembered choice is the viewed scenario or gone', () => {
    expect(resolve('early', null, { early: 'early' })).toBe('base');
    expect(resolve('early', null, { early: 'gone' })).toBe('base');
    expect(resolve('early', 'gone')).toBe('base');
  });

  it('is none for Base with nothing chosen, and when the parent no longer exists', () => {
    expect(resolve('base', null)).toBeNull();
    expect(resolve('early', null, {}, [scenario('early', 'missing')])).toBeNull();
  });
});
