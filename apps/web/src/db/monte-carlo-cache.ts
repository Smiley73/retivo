/**
 * IndexedDB-backed LRU cache for Monte Carlo summaries. Local-only —
 * not synced. TWO independently capped budgets — 20 primary entries plus
 * one per named market-stress case — with the oldest by `lastAccessedAt`
 * WITHIN the over-budget budget evicted on insert, so neither class can
 * push the other out. Entries whose `engineVersion` doesn't match the
 * current `ENGINE_VERSION` are silently re-computed on next access
 * (caller checks via `getCached`'s return shape).
 *
 * Cache key = SHA-256 of the projection-relevant aggregate snapshot,
 * truncated to 16 hex chars. Coarse invalidation: any aggregate-level
 * change produces a new key, hence a cache miss. Cosmetic edits inside
 * an aggregate (rename, notes) also invalidate.
 *
 * `computeCacheKey` hashes the WHOLE `JSON.stringify(input)`, so every plain
 * field is canonical by construction — including the market-stress levers
 * (`annualInvestmentCostPct`, `returnShock`, `inflationShockPct`) and the
 * longevity-extended `horizonYear` + series. They MUST stay plain (no `Map` /
 * `Set` — `JSON.stringify(new Set)` is `{}`, which would collide a stressed run
 * with its base and serve a stale summary). `returnShock` is a plain nested
 * object of numbers, so it serialises fully.
 */
import { db, type MonteCarloCacheEntry } from './store.js';
import { STRESS_CASE_IDS } from '../lib/market-stress.js';
import {
  ENGINE_VERSION,
  type MonteCarloInput,
  type MonteCarloSummary,
} from '../lib/monte-carlo.js';

/**
 * Which of the two LRU budgets a written entry is charged to.
 *
 * A cap alone is NOT a reserve: with one shared budget and one global LRU walk,
 * whichever class wrote least recently loses its entries regardless of how the
 * headroom was labelled — a second market-stress comparison would still evict
 * four primary scenario entries. The class is therefore STORED on the entry and
 * eviction only ever deletes within the class that went over.
 *
 * `'primary'` covers every ordinary run: the page auto-run / Recalculate, the
 * Scenarios bulk recompute and card metrics, and the guardrail forced-off
 * sibling (one entry per settled run, written at the same rate as the primary
 * it pairs with).
 */
export type McCacheEntryClass = 'primary' | 'marketStress';

/** Primary budget. Bumped 5 → 20 so the Scenarios "recalculate all" can keep
 *  more than a handful of scenarios' MC results warm in the local cache. */
export const MC_PRIMARY_MAX_ENTRIES = 20;

/** How many whole comparisons the market-stress budget keeps.
 *
 *  Was ONE. That was sized for an opt-in comparison, where a second one only
 *  existed because the user pressed a button for it, so evicting the first was
 *  a fair trade. The comparison now starts by itself, which turns the same cap
 *  into guaranteed repeated work: moving from scenario A to scenario B evicts
 *  all four of A's entries, so moving back re-runs 40,000 paths, and back again
 *  re-runs B's — indefinitely, with no button left to decline it. Holding a
 *  handful makes the cache-first premise the automatic behaviour rests on
 *  actually true across the way scenarios are used. */
export const MC_STRESS_MAX_COMPARISONS = 4;

/**
 * Market-stress budget: one slot per named stress case, for each of the last
 * few comparisons (`MC_STRESS_MAX_COMPARISONS`).
 *
 * A single comparison writes one SEED-INCLUSIVE entry per case. Unlike the
 * seed-stripped primary entries those are pinned to one exact displayed sample
 * and become unreachable after any edit or Recalculate, so charging them to the
 * primary budget let one comparison evict a fifth of it — including the
 * per-scenario entries the Scenarios page's cached metrics read, forcing full
 * recomputes there. They keep their own budget instead of being dropped,
 * because they are what makes a return visit to the page on an unchanged plan
 * instant rather than four more 10,000-path runs — the comparison starts by
 * itself now, so those reads are the whole cost of it. Eviction stays confined
 * to this budget: an overflowing comparison drops the least recently used
 * STRESS entry, never a primary one.
 */
export const MC_STRESS_MAX_ENTRIES =
  STRESS_CASE_IDS.length * MC_STRESS_MAX_COMPARISONS;

/** Per-class LRU capacity. */
const MAX_ENTRIES_BY_CLASS: Readonly<Record<McCacheEntryClass, number>> = {
  primary: MC_PRIMARY_MAX_ENTRIES,
  marketStress: MC_STRESS_MAX_ENTRIES,
};

/** Combined ceiling across both budgets — the most entries the store can hold.
 *  Exported so tests assert against the real budget rather than re-hard-coding
 *  it; it is NOT a cap the eviction path enforces (each class is capped on its
 *  own, which is what makes the reserve real). */
export const MC_CACHE_MAX_ENTRIES = MC_PRIMARY_MAX_ENTRIES + MC_STRESS_MAX_ENTRIES;

/**
 * Compute the SHA-256-derived cache key for arbitrary inputs.
 * Truncates to 16 hex chars (64 bits) — collision probability is
 * negligible at N=24 entries.
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
 * Canonical MC cache key for a `MonteCarloInput`: the SHA-256-derived
 * `computeCacheKey` with the seed AND the (non-serialisable) progress
 * callback excluded. The single owner of this derivation — the
 * `MonteCarloProvider` (both run paths), the Scenarios bulk recompute hook,
 * and the Scenarios card metrics read all call it, so the write key can
 * never drift from the read key. The seed is excluded because the auto-run
 * seed is deterministic per content signature, so excluding it leaves
 * non-forced hit/miss behavior unchanged AND lets a forced run (fresh seed)
 * overwrite the SAME canonical entry rather than spawning a sibling key.
 *
 * TWO deliberate NON-callers write seed-INCLUSIVE entries through
 * `computeCacheKey` directly instead: the guardrail forced-off sibling run and
 * the market-stress comparison. Both exist only to be differenced against
 * one specific DISPLAYED run, so a hit has to be guaranteed seed-paired with
 * it — the seed-stripped key would serve them a differently-sampled entry, and
 * a manual Recalculate must miss rather than reuse. Their keys cannot collide
 * with a primary run's; they are not "the same entry computed differently".
 */
export function mcCacheKey(input: MonteCarloInput): Promise<string> {
  return computeCacheKey({
    ...input,
    onProgress: undefined,
    seed: undefined,
    ...canonicalKeyTaxContext(input.taxContext),
  });
}

/**
 * Canonicalize the tax context's NESTED health inputs before hashing.
 *
 * `JSON.stringify` preserves an object's own-property INSERTION order, so two
 * semantically identical inputs that were built in a different order hash to
 * different keys. Every flat MC field is canonical by construction (sorted
 * arrays built once, in `buildMcTaxContext`), but `healthCoverageMonths` is a
 * nested `memberId → taxYear → months` map assembled by the Health coverage
 * modal in whatever order the user happened to add rows, and re-assembled in
 * import/sync order after a round-trip. Two households with the SAME coverage
 * would then miss each other's cache entry — a wasted multi-second re-run at
 * best, and a needless divergence in a value AGENTS.md requires to be
 * order-independent.
 *
 * Returns `{}` (adding NO key) when the context is absent, and leaves an absent
 * `healthCoverageMonths` / `retirementYearByMember` absent, so a household that
 * states none keeps EXACTLY its pre-feature key.
 */
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
            // Sorted by member id: the same household must hash the same way
            // whichever member the builder happened to emit first.
            retirementYearByMember: [...retirementYearByMember].sort((a, b) =>
              a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
            ),
          }
        : {}),
    },
  };
}

/** Rebuild the stored coverage-month map with every level's keys sorted:
 *  member id ascending, then tax year ascending, then the month fields
 *  themselves (a `{ partDMonths, partBMonths }` row must hash like a
 *  `{ partBMonths, partDMonths }` one).
 *
 *  Shape-checked exactly like the engines' own reader: the map arrives from an
 *  IMPORTED aggregate whose validation covers the envelope only, so a non-object
 *  at any level is passed through untouched rather than throwing out of the
 *  cache lookup — a malformed override must not be able to break MC entirely.
 *  Every rebuild goes through `Object.fromEntries`, which DEFINES own properties
 *  instead of assigning, so an imported `"__proto__"` member id cannot reach
 *  `Object.prototype` (CWE-1321). */
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

/** Own enumerable entries, ascending by key. Numeric-looking keys (the tax
 *  years) already enumerate in ascending numeric order per the language spec;
 *  sorting is what makes the STRING keys (member ids, month field names)
 *  order-independent too. */
function sortedEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Read the cache entry for a key. Returns `null` on miss or
 *  engine-version mismatch. Updates `lastAccessedAt` on hit. */
export async function getCached(key: string): Promise<MonteCarloSummary | null> {
  const handle = await db();
  const tx = handle.transaction('monteCarloResults', 'readwrite');
  const entry = (await tx.store.get(key)) as MonteCarloCacheEntry | undefined;
  if (!entry) {
    await tx.done;
    return null;
  }
  if (entry.engineVersion !== ENGINE_VERSION) {
    // Stale across engine bump — drop the entry, return miss.
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
 * Read the cache entry for a key without touching it. `getCached` is a
 * read-modify-write: it bumps `lastAccessedAt` (the LRU index `putCached`
 * evicts by) and deletes an entry stamped with another engine version. A
 * caller that must leave the cache exactly as it found it (the AI assistant's
 * tools, which only report what the page already computed) reads through this
 * instead: a `readonly` transaction, `null` on a miss, and `null` on a stale
 * entry that is left in place for the page's own `getCached` to drop.
 */
export async function peekCached(key: string): Promise<MonteCarloSummary | null> {
  const handle = await db();
  const tx = handle.transaction('monteCarloResults', 'readonly');
  const entry = (await tx.store.get(key)) as MonteCarloCacheEntry | undefined;
  await tx.done;
  if (!entry || entry.engineVersion !== ENGINE_VERSION) return null;
  return entry.summary as MonteCarloSummary;
}

/** The budget an entry is charged to. A stored entry with no `entryClass` is a
 *  primary one — that is what makes every earlier entry keep its budget without
 *  a migration. */
function classOf(entry: MonteCarloCacheEntry): McCacheEntryClass {
  return entry.entryClass === 'marketStress' ? 'marketStress' : 'primary';
}

/**
 * Write (or replace) a cache entry, charged to `entryClass` (default
 * `'primary'`).
 *
 * Eviction is PER CLASS: only entries of the class that just went over its own
 * budget are considered, oldest `lastAccessedAt` first. A shared cap plus a
 * single global LRU walk would not reserve anything — the least-recently-written
 * class would simply lose its entries — so a second market-stress comparison
 * would evict five primary scenario results and force full recomputes on the
 * Scenarios page. Here it evicts the FIRST comparison's entries instead.
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
    // Omit the key entirely for a primary write, so an ordinary entry keeps the
    // exact earlier record shape.
    ...(entryClass === 'marketStress' ? { entryClass } : {}),
  });
  // Only the written class can have grown, so only it needs re-checking. Walk
  // the LRU index ascending and count/delete WITHIN that class.
  const idx = tx.store.index('lastAccessedAt');
  const sameClass: string[] = [];
  let cursor = await idx.openCursor();
  while (cursor) {
    if (classOf(cursor.value) === entryClass) sameClass.push(cursor.value.id);
    cursor = await cursor.continue();
  }
  const overBy = sameClass.length - MAX_ENTRIES_BY_CLASS[entryClass];
  if (overBy > 0) {
    // Oldest first, never the entry just inserted (its `lastAccessedAt` is the
    // newest, so it sorts last, but a same-millisecond tie must not drop it).
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
