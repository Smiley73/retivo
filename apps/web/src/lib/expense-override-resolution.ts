// Per-id sparse override resolver for the household's canonical expense list. Rules are on
// `resolveExpensesForScenarioSparse`, `resolveItemState` and `applyPatchWithClears`.

import { scenarioChain, type ScenarioAggregate } from './scenario-resolution';
import type {
  Aggregate,
  ExpensePayload,
  PatchWithClears,
} from '../db/types';

type ResolvedExpenseSource = 'canonical' | 'patched' | 'added';

export interface ResolvedExpense {
  /** `aggregate:<canonical-id>` for canonical and patched rows, `local:<_localId>` for scenario-only adds. */
  id: string;
  source: ResolvedExpenseSource;
  payload: ExpensePayload;
}

const AGGREGATE_PREFIX = 'aggregate:';
const LOCAL_PREFIX = 'local:';

/** Raw ids (legacy or forward-compatible writes) resolve as `aggregate:<raw>`; prefixed ids pass through. */
export function normalizeOverrideId(id: string): string {
  if (id.startsWith(AGGREGATE_PREFIX) || id.startsWith(LOCAL_PREFIX)) return id;
  return `${AGGREGATE_PREFIX}${id}`;
}

/**
 * Applies a sparse patch onto `base`, then strips every key whose patch value is
 * `null`, the clear-marker for an inherited optional field. Pure. Shared by the
 * income and expense resolvers.
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
 * The active expense list for `scenarioId`. Walking the chain leaf to base, the
 * first ancestor that states an id's disabled or re-enabled state wins (disabled
 * wins a same-scenario conflict). Patches merge per top-level key, the closest
 * scenario winning each key, with no deep merge. Every scenario in the chain
 * contributes its `added` entries, referenced as `local:<uuid>`. The `aggregate:`
 * and `local:` namespaces never collide.
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

/** Per-id state walker over `sections` leaf to base; generic so `income-override-resolution.ts` shares it. */
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
        // Leaf to base: keys a nearer scenario already set win over this ancestor's. Never mutates a stored patch.
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
