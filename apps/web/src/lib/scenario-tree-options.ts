/**
 * Build a depth-tagged, DFS-ordered list of scenarios for use in
 * indented `<Select>` option lists.
 *
 * Two-phase algorithm:
 *   Phase 1 — DFS from every "natural root" (parentScenarioId === null
 *             OR parent not in the input set). Roots ordered: isPrimary
 *             roots first (alpha), then other natural roots (alpha).
 *             Children within each parent sorted case-insensitively alpha.
 *             visited-set guard skips already-seen children (cycle guard).
 *   Phase 2 — Any scenario still unvisited after Phase 1 can only be
 *             reached via a cycle with no natural root (self-loop,
 *             rootless pair, longer rootless cycle). Flatten all at depth 0
 *             in case-insensitive alpha order — no DFS, every node gets
 *             depth 0 unambiguously.
 *
 * Guarantees every input scenario emits exactly once.
 * Pure function — no IDB / React deps; callers filter the result themselves.
 */
import type { ScenarioAggregate } from './scenario-resolution';

export interface ScenarioTreeEntry {
  scenario: ScenarioAggregate;
  depth: number;
}

type Alpha = (a: ScenarioAggregate, b: ScenarioAggregate) => number;

const alpha: Alpha = (a, b) =>
  a.payload.name.localeCompare(b.payload.name, undefined, { sensitivity: 'base' });

/**
 * Build a map from parent-id → sorted children.
 * Only scenarios whose parent is in `idSet` appear as children.
 */
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

/**
 * Split natural roots (parent null or outside idSet) into two sorted tiers:
 * isPrimary roots first, then the rest — both tiers sorted alpha.
 */
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

/**
 * DFS walk from `root`, pushing `{ scenario, depth }` entries into `result`.
 * The `visited` set guards against cycles.
 */
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

/**
 * Phase 2: emit every unvisited scenario (rootless cycles) at depth 0, alpha.
 */
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
 * Return `scenarios` in indented-tree order with depth annotations.
 * The returned array length always equals `scenarios.length`.
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
