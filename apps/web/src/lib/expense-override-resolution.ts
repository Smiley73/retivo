/**
 * Per-id sparse override resolver for the household's canonical
 * expense list. Replaces the section-level
 * `resolveExpensesForScenario` flow for the planning engines.
 *
 * Resolution rules:
 * - Walk the scenario chain leaf → base. For each canonical id (and
 *   each scenario-only `_localId`), the **first ancestor that defines
 *   a state for the id wins**. The previous section-level resolver
 *   ignored deeper-ancestor overrides entirely once a closer scenario
 *   set its `expenses` section.
 * - **Disable state**: within a single scenario, an id listed in both
 *   `disabledIds` and `reEnabledIds` is treated as disabled (disable
 *   wins same-scenario conflict). Across scenarios, the
 *   closer-to-leaf occurrence wins.
 * - **Patches**: a **per-key chain merge**. Walk leaf →
 *   base; for each top-level `ExpensePayload` key, the closest scenario
 *   that sets it wins; the merged sparse patch is then applied onto the
 *   canonical payload (`{ ...canonical, ...mergedPatch }`). A scenario
 *   that patches only `{amount}` no longer hides a deeper ancestor's
 *   `{discretionaryGlide}` patch — each key inherits independently.
 *   Single-ancestor-patch resolution is byte-identical to the former
 *   first-ancestor-wins-wholesale behaviour. Top-level replace per key
 *   — no deep merge within a key. A patch value of `null` clears the
 *   inherited optional key (the merged payload omits it → engine
 *   default); `null` is just a value in the chain merge, so a closer
 *   clear wins over a deeper set and a deeper clear loses to a closer
 *   set. The final `applyPatchWithClears` strips `null`-valued keys
 *   after the chain merge.
 * - **`added[]` entries**: every scenario in the chain contributes its
 *   `added` entries (parent + child both supply their additions).
 *   Their stable handle is `_localId`; references from disabledIds /
 *   patches / reEnabledIds use the prefixed form `local:<uuid>`.
 * - **Prefixes**: ids in the three sparse sections are stored as
 *   `aggregate:<uuid>` (referring to a canonical expense aggregate) or
 *   `local:<uuid>` (referring to a scenario-only `_localId`). The
 *   resolver normalizes any unprefixed raw id to `aggregate:<raw>` at
 *   read time so legacy / forward-compatibility writes still resolve.
 *   The two namespaces never collide — `aggregate:abc` and
 *   `local:abc` are different ids.
 */
import { scenarioChain, type ScenarioAggregate } from './scenario-resolution';
import type {
  Aggregate,
  ExpensePayload,
  PatchWithClears,
} from '../db/types';

type ResolvedExpenseSource = 'canonical' | 'patched' | 'added';

export interface ResolvedExpense {
  /** Prefixed id: `aggregate:<canonical-id>` for canonical / patched
   *  rows, `local:<_localId>` for scenario-only added rows. */
  id: string;
  source: ResolvedExpenseSource;
  payload: ExpensePayload;
}

const AGGREGATE_PREFIX = 'aggregate:';
const LOCAL_PREFIX = 'local:';

/**
 * Normalize an override-section id to its prefixed form. Raw ids
 * (legacy data written before the prefix rolled out, or forward-
 * compatibility writes) resolve as `aggregate:<raw>`. Already-prefixed
 * ids pass through unchanged.
 */
export function normalizeOverrideId(id: string): string {
  if (id.startsWith(AGGREGATE_PREFIX) || id.startsWith(LOCAL_PREFIX)) return id;
  return `${AGGREGATE_PREFIX}${id}`;
}

/**
 * Apply a sparse `PatchWithClears` onto a base payload, then strip every
 * key whose patch value is `null`. A `null` is the clear-marker:
 * the inherited optional field is intentionally empty in this
 * scenario, so the merged key is deleted rather than kept at the
 * canonical value. Pure — never mutates `base` or `patch`. A patch with
 * no `null` values resolves byte-identically to `{ ...base, ...patch }`.
 *
 * Shared by both resolvers (income + expense) so the clear semantics are
 * one implementation.
 */
export function applyPatchWithClears<TPayload>(
  base: TPayload,
  patch: PatchWithClears<TPayload>,
): TPayload {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
  }
  return merged as TPayload;
}

/**
 * Resolves the active expense list for `scenarioId` under sparse
 * per-id override inheritance. See module docstring for rules.
 */
export function resolveExpensesForScenarioSparse(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>,
): ResolvedExpense[] {
  const chain = scenarioChain(scenarioId, allScenarios);
  const sections = chain.map((sc) => sc.payload.overrides.expenses);

  const out: ResolvedExpense[] = [];

  for (const c of canonicalExpenses) {
    const aggregateId = `${AGGREGATE_PREFIX}${c.id}`;
    const { disabled, patch } = resolveItemState<ExpensePayload>(aggregateId, sections);
    if (disabled) continue;
    if (patch) {
      out.push({
        id: aggregateId,
        source: 'patched',
        payload: applyPatchWithClears(c.payload, patch),
      });
    } else {
      out.push({ id: aggregateId, source: 'canonical', payload: c.payload });
    }
  }

  for (const sc of chain) {
    const added = sc.payload.overrides.expenses?.added;
    if (!added?.length) continue;
    for (const a of added) {
      const localId = `${LOCAL_PREFIX}${a._localId}`;
      const { disabled, patch } = resolveItemState<ExpensePayload>(localId, sections);
      if (disabled) continue;
      const { _localId: _drop, ...rest } = a;
      void _drop;
      const payload = patch
        ? applyPatchWithClears(rest as ExpensePayload, patch)
        : (rest as ExpensePayload);
      out.push({ id: localId, source: 'added', payload });
    }
  }

  return out;
}

/**
 * Per-id state walker: scans `sections` leaf → base. Disable/re-enable
 * is **first-ancestor-wins** (the closest scenario that sets a state
 * for the id decides — unchanged). Patches are a **per-key chain
 * merge**: for each top-level payload key the closest
 * scenario that sets it wins, accumulated across the whole chain, so
 * sparse multi-level patches inherit + reset per key instead of the
 * closest patch winning wholesale. Generic over the payload type so the
 * mirror `income-override-resolution.ts` shares it.
 *
 * Single-ancestor-patch resolution is byte-identical to the former
 * first-ancestor-wins-wholesale behaviour (the merged patch is just
 * that one ancestor's patch).
 */
export function resolveItemState<TPayload>(
  prefixedId: string,
  sections: ReadonlyArray<
    | {
        disabledIds?: string[];
        reEnabledIds?: string[];
        patches?: Record<string, PatchWithClears<TPayload>>;
      }
    | undefined
  >,
): { disabled: boolean; patch?: PatchWithClears<TPayload> } {
  let disabled: boolean | undefined;
  let merged: PatchWithClears<TPayload> | undefined;
  for (const ov of sections) {
    if (!ov) continue;
    if (disabled === undefined) {
      const inDisabled = idMatches(ov.disabledIds, prefixedId);
      const inReEnabled = idMatches(ov.reEnabledIds, prefixedId);
      if (inDisabled) disabled = true;
      else if (inReEnabled) disabled = false;
    }
    if (ov.patches) {
      const p = lookupPatch<TPayload>(ov.patches, prefixedId);
      if (p !== undefined) {
        // Closest-scenario-wins per key: iterate leaf → base, so keys
        // already set by a nearer scenario (`merged`) win over this
        // deeper ancestor's (`p`). `{ ...p, ...merged }` keeps the
        // nearer values. Never mutates a stored patch object.
        merged = merged === undefined ? { ...p } : { ...p, ...merged };
      }
    }
  }
  return { disabled: disabled === true, patch: merged };
}

function idMatches(
  list: ReadonlyArray<string> | undefined,
  prefixedId: string,
): boolean {
  if (!list?.length) return false;
  for (const raw of list) {
    if (normalizeOverrideId(raw) === prefixedId) return true;
  }
  return false;
}

function lookupPatch<TPayload>(
  patches: Record<string, PatchWithClears<TPayload>>,
  prefixedId: string,
): PatchWithClears<TPayload> | undefined {
  const direct = patches[prefixedId];
  if (direct !== undefined) return direct;
  for (const [key, val] of Object.entries(patches)) {
    if (normalizeOverrideId(key) === prefixedId) return val;
  }
  return undefined;
}
