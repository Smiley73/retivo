// IndexedDB LRU cache for Monte Carlo summaries, local-only, in two independently capped budgets (primary, market-stress);
// a stale `engineVersion` is recomputed (AGENTS.md "ENGINE_VERSION bump — required companion edits").
import { db, type MonteCarloCacheEntry } from './store.js';
import { STRESS_CASE_IDS } from '../lib/market-stress.js';
import {
  ENGINE_VERSION,
  type MonteCarloInput,
  type MonteCarloSummary,
} from '../lib/monte-carlo.js';

/**
 * Which LRU budget a written entry is charged to. A cap alone reserves nothing: with one shared budget and one global
 * LRU walk, whichever class wrote least recently loses its entries (a second stress comparison would evict four primary
 * entries). So the class is stored on the entry and eviction only deletes within the class that went over. `'primary'`
 * covers every ordinary run (page auto-run/Recalculate, Scenarios bulk recompute and card metrics, the guardrail
 * forced-off sibling).
 */
export type McCacheEntryClass = 'primary' | 'marketStress';

/** Primary budget, sized so the Scenarios "recalculate all" keeps more than a handful of scenarios warm. */
export const MC_PRIMARY_MAX_ENTRIES = 20;

/**
 * Whole comparisons the stress budget keeps. The comparison starts by itself, so a cap of one would evict all of
 * scenario A's entries when moving to B and re-run 40,000 paths on every move back and forth; holding a handful makes
 * the cache-first premise true across normal use.
 */
export const MC_STRESS_MAX_COMPARISONS = 4;

/**
 * Market-stress budget: one slot per named stress case for each of the last few comparisons
 * (`MC_STRESS_MAX_COMPARISONS`). A comparison writes seed-inclusive entries pinned to one displayed sample, unreachable
 * after any edit or Recalculate; charging them to the primary budget let one comparison evict a fifth of it, including
 * the entries the Scenarios page's cached metrics read. They keep their own budget because they make a return visit on
 * an unchanged plan instant, and eviction stays confined to it.
 */
export const MC_STRESS_MAX_ENTRIES =
  STRESS_CASE_IDS.length * MC_STRESS_MAX_COMPARISONS;

const MAX_ENTRIES_BY_CLASS: Readonly<Record<McCacheEntryClass, number>> = {
  primary: MC_PRIMARY_MAX_ENTRIES,
  marketStress: MC_STRESS_MAX_ENTRIES,
};

/**
 * Combined ceiling across both budgets, for tests to assert against; eviction does not enforce it (each class is capped
 * on its own).
 */
export const MC_CACHE_MAX_ENTRIES = MC_PRIMARY_MAX_ENTRIES + MC_STRESS_MAX_ENTRIES;

/**
 * SHA-256 of the whole `JSON.stringify(input)`, truncated to 16 hex chars (64 bits; collisions are negligible at ~24
 * entries), so any aggregate-level change misses. Inputs must stay plain (no `Map`/`Set`: `JSON.stringify(new Set)` is
 * `{}`, which would collide a stressed run with its base and serve a stale summary).
 */
export async function computeCacheKey(input: unknown): Promise<string> {
  const json = JSON.stringify(input);
  const data = new TextEncoder().encode(json);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Canonical MC cache key for a `MonteCarloInput`: `computeCacheKey` without the seed and the non-serialisable progress
 * callback. The one owner of this derivation (MonteCarloProvider, the Scenarios bulk recompute and card metrics), so
 * write and read keys can't drift. The auto-run seed is deterministic per content signature, so excluding it leaves
 * hit/miss unchanged and lets a forced run (fresh seed) overwrite the same entry. The guardrail forced-off sibling and
 * the market-stress comparison deliberately call `computeCacheKey` with the seed: they are differenced against one
 * displayed run, so a hit must be seed-paired with it and a manual Recalculate must miss. Their keys cannot collide
 * with a primary run's.
 */
export function mcCacheKey(input: MonteCarloInput): Promise<string> {
  return computeCacheKey({
    ...input,
    onProgress: undefined,
    seed: undefined,
    ...canonicalKeyTaxContext(input.taxContext),
  });
}

// Canonicalizes the tax context's nested health inputs before hashing. `JSON.stringify` keeps insertion order, and
// `healthCoverageMonths` (memberId -> taxYear -> months) is assembled in whatever order rows were added or imported, so
// households with the same coverage would miss each other's entry. Adds no key when the context is absent and leaves
// absent fields absent, so a household stating none keeps its key.
function canonicalKeyTaxContext(
  taxContext: MonteCarloInput['taxContext'],
): { taxContext?: MonteCarloInput['taxContext'] } {
  if (taxContext === undefined) return {};
  const healthCoverageMonths = canonicalCoverageMonths(taxContext.healthCoverageMonths);
  const retirementYearByMember = taxContext.retirementYearByMember;
  return {
    taxContext: {
      ...taxContext,
      ...(healthCoverageMonths !== undefined ? { healthCoverageMonths } : {}),
      ...(retirementYearByMember !== undefined
        ? {
            // Sorted by member id so the same household hashes the same whichever member was emitted first.
            retirementYearByMember: [...retirementYearByMember].sort((a, b) =>
              a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
            ),
          }
        : {}),
    },
  };
}

// Rebuilds the coverage-month map with every level's keys sorted (member id, tax year, month fields). Shape-checked
// like the engines' reader: the map comes from an imported aggregate validated at the envelope only, so a non-object at
// any level passes through rather than throwing out of the cache lookup. `Object.fromEntries` defines own properties,
// so an imported `"__proto__"` member id cannot reach `Object.prototype` (CWE-1321).
function canonicalCoverageMonths(
  months: NonNullable<MonteCarloInput['taxContext']>['healthCoverageMonths'],
): NonNullable<MonteCarloInput['taxContext']>['healthCoverageMonths'] {
  if (months === undefined) return undefined;
  const perMember: unknown = months.perMember;
  if (typeof perMember !== 'object' || perMember === null) return months;
  return {
    perMember: Object.fromEntries(
      sortedEntries(perMember as Record<string, unknown>).map(([memberId, byYear]) => [
        memberId,
        typeof byYear === 'object' && byYear !== null
          ? Object.fromEntries(
              sortedEntries(byYear as Record<string, unknown>).map(([taxYear, entry]) => [
                taxYear,
                typeof entry === 'object' && entry !== null
                  ? Object.fromEntries(sortedEntries(entry as Record<string, unknown>))
                  : entry,
              ]),
            )
          : byYear,
      ]),
    ),
  } as NonNullable<MonteCarloInput['taxContext']>['healthCoverageMonths'];
}

// Own entries ascending by key: numeric-looking keys (tax years) already enumerate ascending, so sorting makes the
// string keys (member ids, month field names) order-independent.
function sortedEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Cached summary for a key, or `null` on a miss or engine-version mismatch (the stale entry is dropped); a hit updates
 * `lastAccessedAt`.
 */
export async function getCached(key: string): Promise<MonteCarloSummary | null> {
  const handle = await db();
  const tx = handle.transaction('monteCarloResults', 'readwrite');
  const entry = (await tx.store.get(key)) as MonteCarloCacheEntry | undefined;
  if (!entry) {
    await tx.done;
    return null;
  }
  if (entry.engineVersion !== ENGINE_VERSION) {
    await tx.store.delete(key);
    await tx.done;
    return null;
  }
  entry.lastAccessedAt = Date.now();
  await tx.store.put(entry);
  await tx.done;
  return entry.summary as MonteCarloSummary;
}

/**
 * Reads without touching: `getCached` bumps `lastAccessedAt` and drops stale-engine entries, but callers that must
 * leave the cache as found (the AI assistant's tools, which only report what the page computed) use a `readonly`
 * transaction. `null` on a miss or a stale entry, which is left for the page's own `getCached` to drop.
 */
export async function peekCached(key: string): Promise<MonteCarloSummary | null> {
  const handle = await db();
  const tx = handle.transaction('monteCarloResults', 'readonly');
  const entry = (await tx.store.get(key)) as MonteCarloCacheEntry | undefined;
  await tx.done;
  if (!entry || entry.engineVersion !== ENGINE_VERSION) return null;
  return entry.summary as MonteCarloSummary;
}

// An entry with no `entryClass` is primary, so earlier entries keep their budget without a migration.
function classOf(entry: MonteCarloCacheEntry): McCacheEntryClass {
  return entry.entryClass === 'marketStress' ? 'marketStress' : 'primary';
}

/**
 * Writes or replaces an entry, charged to `entryClass` (default `'primary'`). Eviction is per class: only the class
 * that went over its own budget is considered, oldest `lastAccessedAt` first (see {@link McCacheEntryClass}).
 */
export async function putCached(
  key: string,
  summary: MonteCarloSummary,
  entryClass: McCacheEntryClass = 'primary',
): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('monteCarloResults', 'readwrite');
  await tx.store.put({
    id: key,
    engineVersion: ENGINE_VERSION,
    summary,
    lastAccessedAt: Date.now(),
    // Omitted for a primary write, so an ordinary entry keeps the earlier record shape.
    ...(entryClass === 'marketStress' ? { entryClass } : {}),
  });
  // Only the written class can have grown: walk the LRU index ascending, counting and deleting within that class.
  const idx = tx.store.index('lastAccessedAt');
  const sameClass: string[] = [];
  let cursor = await idx.openCursor();
  while (cursor) {
    if (classOf(cursor.value) === entryClass) sameClass.push(cursor.value.id);
    cursor = await cursor.continue();
  }
  const overBy = sameClass.length - MAX_ENTRIES_BY_CLASS[entryClass];
  if (overBy > 0) {
    // Oldest first, never the entry just inserted (a same-millisecond tie must not drop it).
    let remaining = overBy;
    for (const id of sameClass) {
      if (remaining === 0) break;
      if (id === key) continue;
      await tx.store.delete(id);
      remaining -= 1;
    }
  }
  await tx.done;
}

/** Drop every cached entry. Used on logout / account-delete. */
export async function clearMonteCarloCache(): Promise<void> {
  const handle = await db();
  await handle.clear('monteCarloResults');
}

/** Count entries — for testing + debug. */
export async function monteCarloCacheCount(): Promise<number> {
  const handle = await db();
  return handle.count('monteCarloResults');
}
