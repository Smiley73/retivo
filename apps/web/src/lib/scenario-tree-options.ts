/**
 * Depth-tagged, DFS-ordered scenario list for indented `<Select>` options; every input scenario is emitted exactly once.
 * Natural roots (no parent, or parent outside the set) come first, primary then alpha; scenarios reachable only through a rootless cycle are flattened at depth 0.
 */
import type { ScenarioAggregate } from './scenario-resolution';

/** The label scenario pickers show: the name, with " (Base)" on the primary one. */
export function scenarioOptionLabel(scenario: ScenarioAggregate): string {
  return `${scenario.payload.name}${scenario.payload.isPrimary ? ' (Base)' : ''}`;
}

export interface ScenarioTreeEntry {
  scenario: ScenarioAggregate;
  depth: number;
}

type Alpha = (a: ScenarioAggregate, b: ScenarioAggregate) => number;

const alpha: Alpha = (a, b) =>
  a.payload.name.localeCompare(b.payload.name, undefined, { sensitivity: 'base' });

function buildChildrenIndex(
  scenarios: ScenarioAggregate[],
  idSet: Set<string>,
): Map<string, ScenarioAggregate[]> {
  const index = new Map<string, ScenarioAggregate[]>();
  for (const s of scenarios) {
    const pid = s.payload.parentScenarioId;
    if (pid === null || !idSet.has(pid)) continue;
    const list = index.get(pid) ?? [];
    list.push(s);
    index.set(pid, list);
  }
  for (const [pid, children] of index) {
    index.set(pid, children.slice().sort(alpha));
  }
  return index;
}

function orderNaturalRoots(
  scenarios: ScenarioAggregate[],
  idSet: Set<string>,
): ScenarioAggregate[] {
  const roots = scenarios.filter((s) => {
    const pid = s.payload.parentScenarioId;
    return pid === null || !idSet.has(pid);
  });
  const primary = roots.filter((s) => s.payload.isPrimary).sort(alpha);
  const other = roots.filter((s) => !s.payload.isPrimary).sort(alpha);
  return [...primary, ...other];
}

function dfs(
  root: ScenarioAggregate,
  depth: number,
  childrenIndex: Map<string, ScenarioAggregate[]>,
  visited: Set<string>,
  result: ScenarioTreeEntry[],
): void {
  if (visited.has(root.id)) return;
  visited.add(root.id);
  result.push({ scenario: root, depth });
  for (const child of childrenIndex.get(root.id) ?? []) {
    dfs(child, depth + 1, childrenIndex, visited, result);
  }
}

function flattenUnvisited(
  scenarios: ScenarioAggregate[],
  visited: Set<string>,
  result: ScenarioTreeEntry[],
): void {
  const cycleNodes = scenarios.filter((s) => !visited.has(s.id)).sort(alpha);
  for (const s of cycleNodes) {
    visited.add(s.id);
    result.push({ scenario: s, depth: 0 });
  }
}

/**
 * Return `scenarios` in indented-tree order with a depth per entry; the length always equals the
 * input's.
 */
export function buildScenarioTreeOptions(
  scenarios: ScenarioAggregate[],
): ScenarioTreeEntry[] {
  if (scenarios.length === 0) return [];

  const idSet = new Set(scenarios.map((s) => s.id));
  const childrenIndex = buildChildrenIndex(scenarios, idSet);
  const roots = orderNaturalRoots(scenarios, idSet);

  const visited = new Set<string>();
  const result: ScenarioTreeEntry[] = [];

  for (const root of roots) {
    dfs(root, 0, childrenIndex, visited, result);
  }

  flattenUnvisited(scenarios, visited, result);

  return result;
}
