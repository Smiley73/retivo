/**
 * Unit tests for buildScenarioTreeOptions — indented-tree ordering helper.
 * Covers the enumerated cases including cycle and orphan edge cases.
 */
import { describe, expect, it } from 'vitest';
import { buildScenarioTreeOptions } from './scenario-tree-options';
import type { ScenarioAggregate } from './scenario-resolution';

function makeScenario(
  id: string,
  name: string,
  isPrimary: boolean,
  parentScenarioId: string | null = null,
): ScenarioAggregate {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId,
      isPrimary,
      notes: '',
      overrides: {},
    },
  };
}

describe('buildScenarioTreeOptions', () => {
  it('single base → one row at depth 0', () => {
    const scenarios = [makeScenario('base', 'Base', true)];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(1);
    expect(result[0].scenario.id).toBe('base');
    expect(result[0].depth).toBe(0);
  });

  it('deep chain Base→A→B→C → depths 0/1/2/3', () => {
    const scenarios = [
      makeScenario('base', 'Base', true),
      makeScenario('a', 'A', false, 'base'),
      makeScenario('b', 'B', false, 'a'),
      makeScenario('c', 'C', false, 'b'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
    expect(result.map((r) => r.scenario.id)).toEqual(['base', 'a', 'b', 'c']);
  });

  it('siblings under base sorted alphabetically', () => {
    const scenarios = [
      makeScenario('base', 'Base', true),
      makeScenario('z', 'Zebra', false, 'base'),
      makeScenario('a', 'Apple', false, 'base'),
      makeScenario('m', 'Mango', false, 'base'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(4);
    expect(result[0].scenario.id).toBe('base');
    expect(result.slice(1).map((r) => r.scenario.payload.name)).toEqual([
      'Apple',
      'Mango',
      'Zebra',
    ]);
    expect(result.slice(1).map((r) => r.depth)).toEqual([1, 1, 1]);
  });

  it('siblings deeper in tree sorted alphabetically', () => {
    const scenarios = [
      makeScenario('base', 'Base', true),
      makeScenario('a', 'A', false, 'base'),
      makeScenario('z', 'Zeta', false, 'a'),
      makeScenario('b', 'Beta', false, 'a'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(4);
    const ids = result.map((r) => r.scenario.id);
    expect(ids).toEqual(['base', 'a', 'b', 'z']);
    expect(result.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  });

  it('orphan with unknown parentScenarioId rendered at depth 0 AFTER base (ordering pin)', () => {
    const scenarios = [
      makeScenario('base', 'Base', true),
      makeScenario('orphan', 'Orphan', false, 'unknown-parent-id'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(2);
    // Base (isPrimary) renders first; orphan is a non-primary natural root — after.
    expect(result[0].scenario.id).toBe('base');
    expect(result[0].depth).toBe(0);
    expect(result[1].scenario.id).toBe('orphan');
    expect(result[1].depth).toBe(0);
  });

  it('two isPrimary:true scenarios → both at depth 0, alphabetically earlier name first', () => {
    const scenarios = [
      makeScenario('b', 'Zeta Base', true),
      makeScenario('a', 'Alpha Base', true),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(2);
    expect(result[0].scenario.id).toBe('a'); // Alpha Base sorts first
    expect(result[1].scenario.id).toBe('b');
    expect(result.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('pure cycle A↔B → Phase 2 flatten emits both at depth 0 (alpha: A first)', () => {
    const scenarios = [
      makeScenario('a', 'A', false, 'b'),
      makeScenario('b', 'B', false, 'a'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(2);
    // Both cycle nodes — no natural root → Phase 2 flat emit, alpha order.
    expect(result[0].scenario.id).toBe('a');
    expect(result[1].scenario.id).toBe('b');
    expect(result.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('self-loop alone X.parent=X → Phase 2 flatten emits X at depth 0 once', () => {
    const scenarios = [makeScenario('x', 'X', false, 'x')];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(1);
    expect(result[0].scenario.id).toBe('x');
    expect(result[0].depth).toBe(0);
  });

  it('self-loop on a child: Base+A where A.parent=A → Base at depth 0 (Phase 1), A at depth 0 (Phase 2)', () => {
    const scenarios = [
      makeScenario('base', 'Base', true),
      makeScenario('a', 'A', false, 'a'), // self-loop: not a child of Base
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(2);
    // Phase 1 emits Base only (A is not a child of Base — its parent is itself).
    expect(result[0].scenario.id).toBe('base');
    expect(result[0].depth).toBe(0);
    // Phase 2 emits A as unvisited cycle node.
    expect(result[1].scenario.id).toBe('a');
    expect(result[1].depth).toBe(0);
  });

  it('three-node rootless cycle A→B→C→A → Phase 2 flatten emits all at depth 0 alpha', () => {
    const scenarios = [
      makeScenario('c', 'C', false, 'b'),
      makeScenario('a', 'A', false, 'c'),
      makeScenario('b', 'B', false, 'a'),
    ];
    const result = buildScenarioTreeOptions(scenarios);
    expect(result).toHaveLength(3);
    // All in cycle, no natural root → Phase 2 flat, alpha.
    expect(result.map((r) => r.scenario.id)).toEqual(['a', 'b', 'c']);
    expect(result.map((r) => r.depth)).toEqual([0, 0, 0]);
  });

  it('empty array returns empty array', () => {
    expect(buildScenarioTreeOptions([])).toEqual([]);
  });
});
