/**
 * Per-id sparse override resolver for the household's canonical
 * IncomeStream list. Mirror of [expense-override-resolution.ts] — same
 * rules apply.
 */
import { scenarioChain, type ScenarioAggregate } from './scenario-resolution';
import {
  applyPatchWithClears,
  normalizeOverrideId,
  resolveItemState,
} from './expense-override-resolution';
import type { Aggregate, IncomeStreamPayload } from '../db/types';

type ResolvedIncomeSource = 'canonical' | 'patched' | 'added';

export interface ResolvedIncomeStream {
  /** Prefixed id: `aggregate:<canonical-id>` for canonical / patched
   *  rows, `local:<_localId>` for scenario-only added rows. */
  id: string;
  source: ResolvedIncomeSource;
  payload: IncomeStreamPayload;
}

const AGGREGATE_PREFIX = 'aggregate:';
const LOCAL_PREFIX = 'local:';

export function resolveIncomeForScenarioSparse(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>,
): ResolvedIncomeStream[] {
  const chain = scenarioChain(scenarioId, allScenarios);
  const sections = chain.map((sc) => sc.payload.overrides.income);

  const out: ResolvedIncomeStream[] = [];

  for (const c of canonicalIncome) {
    const aggregateId = `${AGGREGATE_PREFIX}${c.id}`;
    const { disabled, patch } = resolveItemState<IncomeStreamPayload>(
      aggregateId,
      sections,
    );
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
    const added = sc.payload.overrides.income?.added;
    if (!added?.length) continue;
    for (const a of added) {
      const localId = `${LOCAL_PREFIX}${a._localId}`;
      const { disabled, patch } = resolveItemState<IncomeStreamPayload>(
        localId,
        sections,
      );
      if (disabled) continue;
      const { _localId: _drop, ...rest } = a;
      void _drop;
      const payload = patch
        ? applyPatchWithClears(rest as IncomeStreamPayload, patch)
        : (rest as IncomeStreamPayload);
      out.push({ id: localId, source: 'added', payload });
    }
  }

  return out;
}

// Re-export the shared normalizer for callers that need to write
// prefixed ids without re-implementing the prefix rule.
export { normalizeOverrideId };
