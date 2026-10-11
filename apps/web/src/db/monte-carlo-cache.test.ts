import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMonteCarloCache,
  computeCacheKey,
  getCached,
  mcCacheKey,
  monteCarloCacheCount,
  putCached,
  MC_CACHE_MAX_ENTRIES,
  MC_PRIMARY_MAX_ENTRIES,
  MC_STRESS_MAX_COMPARISONS,
  MC_STRESS_MAX_ENTRIES,
} from './monte-carlo-cache.js';
import { STRESS_CASE_IDS } from '../lib/market-stress.js';
import {
  ENGINE_VERSION,
  type McQcdContext,
  type MonteCarloInput,
  type MonteCarloSummary,
} from '../lib/monte-carlo.js';
import {
  canonicalAcaBenchmark,
  canonicalOptOutSet,
} from '../lib/balance-projection-runner-mc.js';
import { canonicalMcRothBasisByOwner } from '../lib/monte-carlo-tax.js';

function fakeSummary(seed = 1): MonteCarloSummary {
  return {
    engineVersion: ENGINE_VERSION,
    seed,
    pathCount: 100,
    computedAt: Date.now(),
    firstYear: 2026,
    horizonYears: 60,
    percentilesNominal: { p10: [], p25: [], p50: [] },
    percentilesReal: { p10: [], p25: [], p50: [] },
    successProbability: 0.9,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 1_000_000,
    medianEndingBalanceReal: 800_000,
    p10EndingBalanceNominal: 500_000,
    p10EndingBalanceReal: 400_000,
    p25EndingBalanceNominal: 650_000,
    p25EndingBalanceReal: 520_000,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  };
}

describe('monte-carlo-cache', () => {
  beforeEach(async () => {
    await clearMonteCarloCache();
  });
  afterEach(async () => {
    await clearMonteCarloCache();
  });

  it('computeCacheKey is deterministic for the same input', async () => {
    const a = await computeCacheKey({ a: 1, b: 'x' });
    const b = await computeCacheKey({ a: 1, b: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('computeCacheKey differs for different inputs', async () => {
    const a = await computeCacheKey({ a: 1 });
    const b = await computeCacheKey({ a: 2 });
    expect(a).not.toBe(b);
  });

  it('getCached returns null on miss', async () => {
    const out = await getCached('nope');
    expect(out).toBeNull();
  });

  it('putCached + getCached round-trip', async () => {
    await putCached('k1', fakeSummary(7));
    const out = await getCached('k1');
    expect(out?.seed).toBe(7);
  });

  it('budgets market-stress entries separately from the primary ones', () => {
    expect(MC_PRIMARY_MAX_ENTRIES).toBe(20);
    // Four whole comparisons, not one: the comparison starts on its own now,
    // so a one-comparison budget guaranteed a re-run every time the user moved
    // between two scenarios.
    expect(MC_STRESS_MAX_COMPARISONS).toBe(4);
    expect(MC_STRESS_MAX_ENTRIES).toBe(
      STRESS_CASE_IDS.length * MC_STRESS_MAX_COMPARISONS,
    );
    expect(MC_CACHE_MAX_ENTRIES).toBe(MC_PRIMARY_MAX_ENTRIES + MC_STRESS_MAX_ENTRIES);
  });

  /** Write one full market-stress comparison (one entry per named case),
   *  tagged `round` so two runs of it produce distinct keys. */
  async function writeStressComparison(round: string): Promise<void> {
    for (const caseId of STRESS_CASE_IDS) {
      await putCached(`stress-${round}-${caseId}`, fakeSummary(1), 'marketStress');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /** Fill the primary budget exactly, oldest first. */
  async function fillPrimaryBudget(): Promise<void> {
    for (let i = 1; i <= MC_PRIMARY_MAX_ENTRIES; i++) {
      await putCached(`p${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('overflowing the stress budget evicts a stress entry, never a primary one', async () => {
    // The defect this pins: a mere cap RAISE (20 → 25) with one global LRU walk
    // is not a reserve. The first comparison fits in the raised headroom, but
    // the overflowing one finds the cache full and evicts the oldest entries —
    // which are primary scenario results the Scenarios page's cached metrics
    // read, forcing full recomputes there. Only a per-class budget survives it.
    await fillPrimaryBudget();
    // One more comparison than the budget holds, so the oldest must go.
    const rounds = ['a', 'b', 'c', 'd', 'e'];
    expect(rounds).toHaveLength(MC_STRESS_MAX_COMPARISONS + 1);
    for (const round of rounds) await writeStressComparison(round);

    // Every primary entry is still warm.
    for (let i = 1; i <= MC_PRIMARY_MAX_ENTRIES; i++) {
      expect(await getCached(`p${i}`)).not.toBeNull();
    }
    // The oldest comparison went; every later one is still readable — which is
    // what stops a user moving between scenarios paying for the same four
    // 10,000-path runs over and over.
    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).toBeNull();
      for (const round of ['b', 'c', 'd', 'e']) {
        expect(await getCached(`stress-${round}-${caseId}`)).not.toBeNull();
      }
    }
    expect(await monteCarloCacheCount()).toBe(MC_CACHE_MAX_ENTRIES);
  });

  it('keeps a second comparison alongside the first, so alternating scenarios stays free', async () => {
    // The behaviour the budget was raised FOR. With a one-comparison budget,
    // writing B evicted A outright: going back to scenario A re-ran four
    // 10,000-path simulations, and returning to B re-ran four more, forever.
    await writeStressComparison('a');
    await writeStressComparison('b');
    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).not.toBeNull();
      expect(await getCached(`stress-b-${caseId}`)).not.toBeNull();
    }
  });

  it('a primary write over budget evicts a primary entry, never a stress one', async () => {
    // The reserve has to hold in BOTH directions: an ordinary run that pushes
    // the primary budget over must not reclaim the comparison's slots either,
    // or a return visit to an unchanged plan re-runs four 10,000-path passes.
    await writeStressComparison('a');
    await fillPrimaryBudget();
    await putCached('p-extra', fakeSummary(99));

    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).not.toBeNull();
    }
    // p1 was the oldest PRIMARY entry, so it is the one that went.
    expect(await getCached('p1')).toBeNull();
    expect(await getCached('p-extra')).not.toBeNull();
    // One comparison written, not the whole stress budget — so the total is
    // the primary budget plus that one comparison, not the combined ceiling.
    expect(await monteCarloCacheCount()).toBe(
      MC_PRIMARY_MAX_ENTRIES + STRESS_CASE_IDS.length,
    );
  });

  it('evicts the oldest entry when the cap is exceeded', async () => {
    const over = MC_PRIMARY_MAX_ENTRIES + 1;
    // Fill to capacity + 1: the last insert evicts the oldest (k1).
    for (let i = 1; i <= over; i++) {
      // Insert with monotonically increasing lastAccessedAt by waiting
      // a tick; fake-indexeddb's Date.now() advance is real.
      await putCached(`k${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await monteCarloCacheCount()).toBe(MC_PRIMARY_MAX_ENTRIES);
    // k1 should have been evicted (oldest).
    expect(await getCached('k1')).toBeNull();
    expect(await getCached(`k${over}`)).not.toBeNull();
  });

  it('refreshes lastAccessedAt on read so LRU evicts the truly oldest', async () => {
    // Fill the cache to capacity, then touch the oldest so it is no longer the
    // eviction victim when the next entry is inserted.
    for (let i = 1; i <= MC_PRIMARY_MAX_ENTRIES; i++) {
      await putCached(`k${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
    // Touch 'k1' so it becomes the most-recently-accessed.
    await getCached('k1');
    await new Promise((r) => setTimeout(r, 2));
    // The next insert should now evict 'k2' (oldest), not 'k1'.
    await putCached('k-extra', fakeSummary(MC_PRIMARY_MAX_ENTRIES + 1));
    expect(await getCached('k1')).not.toBeNull();
    expect(await getCached('k2')).toBeNull();
  });

  it('invalidates entries whose engineVersion mismatches', async () => {
    // Manually plant an entry with a bogus engineVersion via the
    // internal put — easiest is to monkey-patch one via the same DB.
    await putCached('stale', { ...fakeSummary(1), engineVersion: -1 });
    // Internal entry has correct engineVersion (putCached overwrites
    // engineVersion to ENGINE_VERSION). To test mismatch we have to
    // write directly. Simpler: putCached then mutate the row.
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('stale');
    if (e) {
      e.engineVersion = -1;
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('stale')).toBeNull();
  });

  // An entry stamped with an older engine version is a cache miss. Each test
  // below pins one version bump by stamping an entry with the prior version.
  it('invalidates a v24-vintage named-strategy entry after the v25 tax aware bump', async () => {
    await putCached('v24', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v24');
    if (e) {
      e.engineVersion = 24; // simulate a result written by the prior (tax-free) engine.
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('v24')).toBeNull();
  });

  it('invalidates a v25-vintage entry after the v26 representative tie-break bump', async () => {
    await putCached('v25', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v25');
    if (e) {
      e.engineVersion = 25; // simulate a result written by the prior (pre-tie-break) engine.
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('v25')).toBeNull();
  });

  it('invalidates a v27-vintage entry after the v28 reroll variety bump', async () => {
    await putCached('v27', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v27');
    if (e) {
      e.engineVersion = 27; // simulate a result written by the prior (narrow-band) engine.
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('v27')).toBeNull();
  });

  it('invalidates a v28-vintage entry after the v29 RMD-surplus bump', async () => {
    await putCached('v28', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v28');
    if (e) {
      e.engineVersion = 28; // simulate a result written by the prior (pre-inline-RMD) engine.
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('v28')).toBeNull();
  });

  it('invalidates a v32-vintage entry after the v33 MC display-deflation bump', async () => {
    await putCached('v32', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v32');
    if (e) {
      e.engineVersion = 32; // simulate a result written by the prior engine (no realFactorByYear).
      await tx.store.put(e);
    }
    await tx.done;
    expect(await getCached('v32')).toBeNull();
  });

  it('invalidates a v34-vintage entry after the v37 contribution growth bump', async () => {
    await putCached('v34', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v34');
    if (e) {
      // simulate a result written by the prior engine (flat-nominal
      // accumulation contributions, pre per-path growth).
      e.engineVersion = 34;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v34')).toBeNull();
  });

  it('invalidates a v34-vintage entry after the v35 per category inflation bump', async () => {
    await putCached('v34', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v34');
    if (e) {
      // simulate a result written by the prior engine (pre per-category buckets):
      // pure recompute-on-miss, no entry migration.
      e.engineVersion = 34;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v34')).toBeNull();
  });

  it('invalidates a v35-vintage entry after the v37 RMD-floor / deposit-routing bump', async () => {
    await putCached('v35', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v35');
    if (e) {
      // simulate a result written by the prior engine (pre RMD-floor / deposit-
      // routing fix): pure recompute-on-miss, no entry migration.
      e.engineVersion = 35;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v35')).toBeNull();
  });

  it('invalidates a v37-vintage entry after the v38 post-primary split-routing bump', async () => {
    await putCached('v37', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v37');
    if (e) {
      // simulate a result written by the prior engine (pre per-account
      // post-primary split routing): pure recompute-on-miss, no entry migration.
      e.engineVersion = 37;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v37')).toBeNull();
  });

  it('invalidates a v41-vintage entry after the v42 deterministic per-account allocation bump', async () => {
    await putCached('v41', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v41');
    if (e) {
      // simulate a result written by the prior engine (pre per-account asset
      // allocation): the bump is fixture/cache discipline (deterministic-side
      // math change; MC byte-identical) — pure recompute-on-miss, no migration.
      e.engineVersion = 41;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v41')).toBeNull();
  });

  it('invalidates a v43-vintage entry after the v44 classification-agnostic + 0–200 glide bump', async () => {
    await putCached('v43', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v43');
    if (e) {
      // A pre-existing essential / out-of-range glide now activates → the
      // same serialized input yields different output, so a v43-vintage
      // cache entry must recompute on next read (pure recompute-on-miss).
      e.engineVersion = 43;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v43')).toBeNull();
  });

  it('invalidates a v44-vintage entry after the v45 HSA withdrawal-reserve bump', async () => {
    await putCached('v44', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v44');
    if (e) {
      // HSA is now held out of the ordinary tiers + routed medical/emergency, so
      // the same serialized HSA scenario yields different per-path output — a
      // v44-vintage cache entry must recompute on next read.
      e.engineVersion = 44;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v44')).toBeNull();
  });

  it('invalidates a v45-vintage entry after the v46 MIXED Roth-designated engine bump', async () => {
    await putCached('v45', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v45');
    if (e) {
      // MIXED 401k/403b/457b/TSP post sub-bucket is now Roth-designated in the
      // MC tax classifier — a scenario with such an account yields different
      // per-path output, so a v45-vintage cache entry must recompute on next read.
      e.engineVersion = 45;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v45')).toBeNull();
  });

  it('invalidates a v46-vintage entry after the v47 hsa qualified expense flag bump', async () => {
    await putCached('v46', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v46');
    if (e) {
      // buildMedicalDemandByMonth and computeMedicalDemandBase now pre-filter to
      // hsaQualified === true rows only. A scenario with medical expenses lacking
      // the flag (absent ⇒ not qualified) produces lower HSA medical demand than
      // before, yielding different per-path output. Recompute on next read.
      e.engineVersion = 46;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v46')).toBeNull();
  });

  it('invalidates a v47-vintage entry after the v48 rmd shortfall mixed roth overcount bump', async () => {
    await putCached('v47', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v47');
    if (e) {
      // The kernel now threads per-step pre/post split through to representative-run
      // rows (display-value-only; MC percentiles/success/depletion are bit-identical).
      // A cached v47 entry must recompute so representative rows carry the corrected
      // RMD split for MIXED accounts. Pure recompute-on-miss, no entry migration.
      e.engineVersion = 47;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v47')).toBeNull();
  });

  it('invalidates a v49-vintage entry after the v50 remove combined pot bump', async () => {
    // ENGINE_VERSION 49 → 50: the Combined Pot MC kernel path is retired; every
    // run funds tax on the strategy-aware path. A summary cached at v49 (a
    // previously-Combined-Pot scenario) must be a MISS so it recomputes.
    await putCached('v49', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v49');
    if (e) {
      e.engineVersion = 49;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v49')).toBeNull();
  });

  it('invalidates a v50-vintage entry after the v51 absorbing-depletion + per-owner RMD-floor bump', async () => {
    // ENGINE_VERSION 50 → 51: two
    // per-path MATH fixes (absorbing-depletion zero-clamp + per-owner RMD floor)
    // shift balances / depletion / percentiles, so a summary cached at v50 must be
    // a MISS so it recomputes under the corrected engine.
    await putCached('v50', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v50');
    if (e) {
      e.engineVersion = 50;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v50')).toBeNull();
  });

  it('invalidates a v51-vintage entry after the v52 QCD per-path wiring bump', async () => {
    // ENGINE_VERSION 51 → 52: each MC path now runs the
    // 70½-gated QCD forced-outflow pass — the gift is debited per path from the
    // source IRA (success/percentile/depletion change for a QCD household) — so a
    // summary cached at v51 must be a MISS so it recomputes its QCD-aware result.
    // A no-QCD scenario recomputes to the SAME numbers (parity), but the cached
    // entry still drops on the version mismatch.
    await putCached('v51', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v51');
    if (e) {
      e.engineVersion = 51;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v51')).toBeNull();
  });

  it('invalidates a v52-vintage entry after the v53 downturn guardrails bump', async () => {
    // ENGINE_VERSION 52 → 53: a scenario with guardrails ENABLED now
    // fires the funded-ratio spending rule per path (success/percentile/depletion
    // change) — so a summary cached at v52 must be a MISS so it recomputes its
    // guardrail-aware result. A disabled/absent config recomputes to the SAME
    // numbers (parity), but the cached entry still drops on the version mismatch.
    await putCached('v52', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v52');
    if (e) {
      e.engineVersion = 52;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v52')).toBeNull();
  });

  it('invalidates a v52-vintage entry after the v56 QCD net-taxable IRA-scoping bump', async () => {
    // ENGINE_VERSION 52 → 56: the display-only
    // representative `netTaxableRmdCents` is re-scoped to the IRA pool only. It is
    // NOT a per-path math change (never in `mcCacheKey` or the parity baseline), so
    // a v52 summary recomputes to the same success/percentile/depletion numbers —
    // but the cached entry still drops on the version mismatch so it re-stamps the
    // corrected IRA-only display value on next read.
    await putCached('v52', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v52');
    if (e) {
      e.engineVersion = 52;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v52')).toBeNull();
  });

  it('invalidates a v53-vintage entry after the v54 guardrail discretionary floor bump', async () => {
    // ENGINE_VERSION 53 → 54: an ENABLED guardrail's
    // per-year cut floor is now lifted into the discretionary band by
    // discretionaryFloorPct (default 50), so its deepest cut keeps more spending
    // (success/percentile/depletion change) — a summary cached at v53 must be a
    // MISS so it recomputes its floor-aware result. A disabled/absent config
    // recomputes to the SAME numbers (parity), but the cached entry still drops on
    // the version mismatch.
    await putCached('v53', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v53');
    if (e) {
      e.engineVersion = 53;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v53')).toBeNull();
  });

  it('invalidates a v56-vintage entry after the v57 projection floor reserve depletion bump', async () => {
    // ENGINE_VERSION 56 → 57: a per-account
    // floor is now a protected RESERVE drained as a last resort, a genuine per-path
    // math change for a floored scenario (below-floor draws move balances /
    // depletion / percentiles). A no-floor scenario recomputes to the SAME numbers
    // (draw-only scope), but the cached v56 entry still drops on the version
    // mismatch so a floored household recomputes its reserve-aware result.
    await putCached('v56', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v56');
    if (e) {
      e.engineVersion = 56;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v56')).toBeNull();
  });

  it('invalidates a v57-vintage entry after the v58 conversion tax funding floor respect bump', async () => {
    // ENGINE_VERSION 57 → 58: Fill-mode
    // Roth-conversion tax funding now stops at a floored HSA/cash-like account's
    // own post-only floor, a genuine per-path math change for a floored Fill-mode
    // scenario (the floored account's ending post + the year's funded-vs-owed tax
    // move). A no-floor / no-Fill-mode scenario recomputes to the SAME numbers,
    // but the cached v57 entry still drops on the version mismatch so a floored
    // Fill-mode household recomputes its floor-respecting result.
    await putCached('v57', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v57');
    if (e) {
      e.engineVersion = 57;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v57')).toBeNull();
  });

  it('invalidates a v58-vintage entry after the v59 hoh senior deduction phaseout base bump', async () => {
    // ENGINE_VERSION 58 → 59: the OBBBA
    // §70103 senior-deduction phaseout base for Head-of-household is corrected
    // from a wrong $112,500 to the enacted $75,000, a genuine tax-output change
    // for a 65+ HoH filer whose MAGI falls in the newly-lower phaseout band. A
    // non-HoH / sub-$75k scenario recomputes to the SAME numbers, but the cached
    // v58 entry still drops on the version mismatch so an affected HoH household
    // recomputes its corrected result.
    await putCached('v58', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v58');
    if (e) {
      e.engineVersion = 58;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v58')).toBeNull();
  });

  it('invalidates a v59-vintage entry after the v60 ltcg and ordinary extrapolation rounding down bump', async () => {
    // ENGINE_VERSION 59 → 60: the
    // inflation-scaled bracket floors for a projection year beyond the latest
    // published federal table now round DOWN to the statutory granularity —
    // LTCG/QDI floor-to-$50 (§1(j)(5)(C)) and ordinary status-aware ($25
    // Single/MFS, $50 MFJ/HoH/QSS; §1(f)(7)) — a genuine tax-output change on an
    // extrapolated year (2027+) with income straddling a moved breakpoint. A
    // within-table / unaffected scenario
    // recomputes to the SAME numbers, but the cached v59 entry still drops on the
    // version mismatch so an affected household recomputes its corrected result.
    await putCached('v59', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v59');
    if (e) {
      e.engineVersion = 59;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v59')).toBeNull();
  });

  it('invalidates a v60-vintage entry after the v61 social security statutory corrections bump', async () => {
    // ENGINE_VERSION 60 → 61: the
    // shared SS engine now anchors COLAs at the statement date, adds the
    // independently reduced dual-entitlement spousal excess (POMS RS
    // 00615.020), keys survivor benefits to the separate survivor claim age
    // with RIB-LIM withholding, and (deterministic path only) runs the
    // month-precise earnings test with FRA restoration — a genuine `ssByYear`
    // change for statement-dated / dually entitled / survivor-phase scenarios.
    // NOT for earnings-tested ones: MC's `ssByYear` input still omits earned
    // income entirely, so the earnings-test corrections don't reach MC output
    // (a known, disclosed gap). An unaffected scenario recomputes to the SAME
    // numbers, but the cached v60 entry still drops on the version mismatch
    // so an affected household recomputes its corrected result.
    await putCached('v60', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v60');
    if (e) {
      e.engineVersion = 60;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v60')).toBeNull();
  });

  it('invalidates a v62-vintage entry after the v63 market stress core bump', async () => {
    // ENGINE_VERSION 62 → 63: the engine gains the
    // annual investment-cost drag + the same-path fee/return/inflation stress
    // levers. A scenario with 0% cost and no stress recomputes to the SAME
    // numbers, but the cached v62 entry still drops on the version mismatch so a
    // cost-bearing or stressed household recomputes its corrected result.
    await putCached('v62', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v62');
    if (e) {
      e.engineVersion = 62;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v62')).toBeNull();
  });

  it('invalidates a v63-vintage entry after the v64 filing-plan activation bump', async () => {
    // ENGINE_VERSION 63 → 64: the scenario filing plan
    // becomes an active MC input — death-year transitions, separate (MFS) tax
    // units, and the look-back IRMAA filing status all move output. A
    // single-member household recomputes to the SAME numbers, but the cached
    // v63 entry still drops on the version mismatch so an affected couple
    // recomputes its corrected result.
    await putCached('v63', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v63');
    if (e) {
      e.engineVersion = 63;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v63')).toBeNull();
  });

  it('invalidates a v66-vintage entry after the v67 Roth conversion cutover bump', async () => {
    // ENGINE_VERSION 66 → 67 (Roth conversion / in-plan rollover cutover): both
    // dated Roth facts move from per-transfer arrays on the account payload to
    // the annual account-balance rows, making the tax year the lot KEY. A
    // household recording no conversion or rollover facts recomputes to the SAME
    // numbers, but the cached v66 entry still drops on the version mismatch so an
    // affected household recomputes against the facts the engine now reads.
    await putCached('v66', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v66');
    if (e) {
      e.engineVersion = 66;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v66')).toBeNull();
  });

  it('invalidates a v67-vintage entry after the v68 Roth clock inference bump', async () => {
    // ENGINE_VERSION 67 → 68: an absent explicit Roth year can now resolve from
    // qualifying annual balance history, so affected tax and penalty paths must
    // not reuse a summary computed while the clock was always treated as unmet.
    await putCached('v67', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const entry = await tx.store.get('v67');
    if (entry) {
      entry.engineVersion = 67;
      await tx.store.put(entry);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v67')).toBeNull();
  });

  it('invalidates a v68-vintage entry after the v69 inherited-Roth pass-through bump', async () => {
    // ENGINE_VERSION 68 → 69: an inherited Roth IRA's withdrawals are now fully
    // tax-free and carry no basis state, so a household holding one must not reuse
    // a summary computed while those dollars ran the §408A ordering.
    await putCached('v68', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const entry = await tx.store.get('v68');
    if (entry) {
      entry.engineVersion = 68;
      await tx.store.put(entry);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v68')).toBeNull();
  });

  it('invalidates a v69-vintage entry after the v70 derived-Roth-basis bump', async () => {
    // ENGINE_VERSION 69 → 70: Roth-IRA basis and remaining conversion lots are
    // now worked out from the recorded balance history rather than read from a
    // stored total, and an employer Roth plan's basis is its recorded in-plan
    // rollover alone — so a household that stored either figure must not reuse a
    // summary computed against it.
    await putCached('v69', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const entry = await tx.store.get('v69');
    if (entry) {
      entry.engineVersion = 69;
      await tx.store.put(entry);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(70);
    expect(await getCached('v69')).toBeNull();
  });
});

describe('ACA opt-out cache-key canonicalization (a)', () => {
  // A minimal MonteCarloInput slice — mcCacheKey only JSON.stringifies, so the
  // fields not present here do not affect the assertions.
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;

  it('omits the field entirely when the opt-out set is empty (no-opt-out input unchanged)', () => {
    expect(canonicalOptOutSet(undefined)).toEqual({});
    expect(canonicalOptOutSet([])).toEqual({});
  });

  it('sorts + dedupes so semantically-identical sets canonicalize to one shape', () => {
    expect(canonicalOptOutSet(['b', 'a', 'a'])).toEqual({
      acaMarketplaceOptOutMemberIds: ['a', 'b'],
    });
    expect(canonicalOptOutSet(['a', 'b'])).toEqual({
      acaMarketplaceOptOutMemberIds: ['a', 'b'],
    });
  });

  it('a no-opt-out input keeps the same mcCacheKey as before the feature (field absent)', async () => {
    const withoutField = await mcCacheKey(base);
    const withEmptyCanonical = await mcCacheKey({ ...base, ...canonicalOptOutSet([]) });
    expect(withEmptyCanonical).toBe(withoutField);
  });

  it('an opt-out scenario gets a DIFFERENT mcCacheKey than the same scenario without it', async () => {
    const noOptOut = await mcCacheKey(base);
    const optOut = await mcCacheKey({
      ...base,
      ...canonicalOptOutSet(['member-secondary']),
    } as MonteCarloInput);
    expect(optOut).not.toBe(noOptOut);
  });

  it("['b','a','a'] and ['a','b'] produce the SAME mcCacheKey (canonical order)", async () => {
    const unsorted = await mcCacheKey({
      ...base,
      ...canonicalOptOutSet(['b', 'a', 'a']),
    } as MonteCarloInput);
    const sorted = await mcCacheKey({
      ...base,
      ...canonicalOptOutSet(['a', 'b']),
    } as MonteCarloInput);
    expect(unsorted).toBe(sorted);
  });
});

describe('account floors cache-key inclusion', () => {
  // A minimal slice — mcCacheKey only JSON.stringifies, so a floor on an
  // accountMcLedger entry must change the serialized key.
  const ledgerBase = { id: 'a', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' };
  const inputNoFloor = {
    portfolioToday: 1_000_000,
    firstYear: 2026,
    accountMcLedger: [{ ...ledgerBase }],
  } as unknown as MonteCarloInput;

  it('a floored scenario gets a DIFFERENT mcCacheKey than the same scenario without floors', async () => {
    const noFloor = await mcCacheKey(inputNoFloor);
    const floored = await mcCacheKey({
      portfolioToday: 1_000_000,
      firstYear: 2026,
      accountMcLedger: [{ ...ledgerBase, floorDollars: 25_000, floorHsaMode: 'emergencyOnly' }],
    } as unknown as MonteCarloInput);
    expect(floored).not.toBe(noFloor);
  });

  it('an absent-floor ledger reproduces the pre-feature key (field absent ⇒ identical)', async () => {
    const a = await mcCacheKey(inputNoFloor);
    const b = await mcCacheKey({
      portfolioToday: 1_000_000,
      firstYear: 2026,
      accountMcLedger: [{ ...ledgerBase }],
    } as unknown as MonteCarloInput);
    expect(a).toBe(b);
  });
});

describe('QCD context cache-key inclusion (a)', () => {
  // `mcCacheKey` only JSON.stringifies, so an active QCD must serialize into the
  // key — and `firstEligibleYearByOwner` MUST be a plain Record (a Map would
  // JSON.stringify to `{}` and silently collide keys).
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;
  const qcd: McQcdContext = {
    entries: [
      {
        memberId: 'm1',
        sourceAccountId: 'ira',
        annualAmountDollars: 20_000,
        startYear: 2028,
        endYear: 2034,
      },
    ],
    firstEligibleYearByOwner: { m1: 2025 },
    inflationPct: 0,
  };

  it('a QCD scenario gets a DIFFERENT mcCacheKey than the same scenario without it', async () => {
    const noQcd = await mcCacheKey(base);
    const withQcd = await mcCacheKey({ ...base, qcdContext: qcd } as MonteCarloInput);
    expect(withQcd).not.toBe(noQcd);
  });

  it('two QCDs differing only in firstEligibleYearByOwner produce DISTINCT keys', async () => {
    // The Record-not-Map guard: a `Map` here would stringify to `{}` for BOTH and
    // collide. A plain Record serializes the differing eligible years → two keys.
    const a = await mcCacheKey({
      ...base,
      qcdContext: { ...qcd, firstEligibleYearByOwner: { m1: 2025 } },
    } as MonteCarloInput);
    const b = await mcCacheKey({
      ...base,
      qcdContext: { ...qcd, firstEligibleYearByOwner: { m1: 2026 } },
    } as MonteCarloInput);
    expect(a).not.toBe(b);
  });
});

describe('market-stress cost/stress cache-key inclusion', () => {
  // `mcCacheKey` JSON.stringifies the whole input, so every market-stress lever
  // (`annualInvestmentCostPct`, the plain `returnShock` object, `inflationShockPct`)
  // and the longevity-extended `horizonYear` must change the key — else a
  // stressed run would serve the base run's stale summary.
  const base = { portfolioToday: 1_000_000, firstYear: 2026, horizonYear: 2086 } as unknown as MonteCarloInput;

  it('a base (no cost, no stress) input keeps the key it had before the stress levers existed (all levers absent)', async () => {
    const a = await mcCacheKey(base);
    const b = await mcCacheKey({ ...base });
    expect(a).toBe(b);
  });

  it('a non-zero annualInvestmentCostPct changes the key', async () => {
    const noCost = await mcCacheKey(base);
    const withCost = await mcCacheKey({ ...base, annualInvestmentCostPct: 0.5 } as MonteCarloInput);
    expect(withCost).not.toBe(noCost);
    // Two distinct cost levels are two distinct keys.
    const higherCost = await mcCacheKey({ ...base, annualInvestmentCostPct: 1 } as MonteCarloInput);
    expect(higherCost).not.toBe(withCost);
  });

  it('a returnShock changes the key and is a fully-serialized plain object', async () => {
    const noShock = await mcCacheKey(base);
    const shocked = await mcCacheKey({
      ...base,
      returnShock: { stocksPct: 2, bondsPct: 1, cashPct: 1 },
    } as MonteCarloInput);
    expect(shocked).not.toBe(noShock);
    // A different shock magnitude → a different key (proves the nested object
    // serializes, unlike a Map/Set which would collapse to `{}`).
    const otherShock = await mcCacheKey({
      ...base,
      returnShock: { stocksPct: 3, bondsPct: 1, cashPct: 1 },
    } as MonteCarloInput);
    expect(otherShock).not.toBe(shocked);
  });

  it('an inflationShockPct changes the key', async () => {
    const noShock = await mcCacheKey(base);
    const shocked = await mcCacheKey({ ...base, inflationShockPct: 2 } as MonteCarloInput);
    expect(shocked).not.toBe(noShock);
  });

  it('a longevity-extended horizonYear changes the key', async () => {
    const baseKey = await mcCacheKey(base);
    const extended = await mcCacheKey({ ...base, horizonYear: 2091 } as MonteCarloInput);
    expect(extended).not.toBe(baseKey);
  });
});

describe('Roth / RMD tax-fact cache-key inclusion (a)', () => {
  // `mcCacheKey` hashes `JSON.stringify(input)`, so every newly activated Roth and
  // RMD fact has to serialise as PLAIN data. This is not a theoretical concern:
  // `JSON.stringify(new Map())` is `{}`, so a `Map` in the MC tax context (the
  // per-owner Roth basis was once one) would be invisible to the key — two households with
  // different recorded basis would share one cached summary. The assertions
  // below pin the plain shapes and prove each fact moves the key.
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;

  const withTaxContext = (taxContext: unknown): MonteCarloInput =>
    ({ ...base, taxContext } as unknown as MonteCarloInput);
  const withRmdContext = (mcRmdContext: unknown): MonteCarloInput =>
    ({ ...base, mcRmdContext } as unknown as MonteCarloInput);

  it('canonicalizes the per-owner Roth basis into a PLAIN sorted array (never a Map)', () => {
    const canonical = canonicalMcRothBasisByOwner(
      new Map([
        ['m2', 200],
        ['m1', 100],
      ]),
    );
    expect(canonical).toEqual([
      { ownerId: 'm1', cents: 100 },
      { ownerId: 'm2', cents: 200 },
    ]);
    // Plain enough to survive JSON — the property a `Map` fails.
    expect(JSON.parse(JSON.stringify(canonical))).toEqual(canonical);
    // Non-positive entries are omitted so "no recorded basis" is one shape.
    expect(canonicalMcRothBasisByOwner(new Map([['m1', 0]]))).toEqual([]);
  });

  it('two different recorded Roth-IRA basis amounts produce DIFFERENT keys', async () => {
    const low = await mcCacheKey(
      withTaxContext({ rothBasisCentsByOwner: [{ ownerId: 'm1', cents: 100 }] }),
    );
    const high = await mcCacheKey(
      withTaxContext({ rothBasisCentsByOwner: [{ ownerId: 'm1', cents: 200 }] }),
    );
    expect(high).not.toBe(low);
  });

  it('semantically-identical Roth basis maps canonicalize to the SAME key', async () => {
    const a = await mcCacheKey(
      withTaxContext({
        rothBasisCentsByOwner: canonicalMcRothBasisByOwner(
          new Map([
            ['m2', 200],
            ['m1', 100],
          ]),
        ),
      }),
    );
    const b = await mcCacheKey(
      withTaxContext({
        rothBasisCentsByOwner: canonicalMcRothBasisByOwner(
          new Map([
            ['m1', 100],
            ['m2', 200],
          ]),
        ),
      }),
    );
    expect(a).toBe(b);
  });

  it('each fact-based Roth profile field changes the key', async () => {
    const profile = {
      iraShareOfOrderedPool: 1,
      iraConversionLots: [],
      designatedBasisCents: 0,
      designatedBalanceCents: 0,
      designatedAllGovernmental457b: false,
    };
    const baseline = await mcCacheKey(withTaxContext({ rothOrderedProfile: profile }));
    const withClock = await mcCacheKey(
      withTaxContext({
        rothOrderedProfile: { ...profile, iraFirstContributionTaxYear: 2015 },
      }),
    );
    expect(withClock).not.toBe(baseline);
    const withLots = await mcCacheKey(
      withTaxContext({
        rothOrderedProfile: {
          ...profile,
          iraConversionLots: [{ taxYear: 2019, taxableCents: 2_000_000, nontaxableCents: 0 }],
        },
      }),
    );
    expect(withLots).not.toBe(baseline);
    const withDesignatedBasis = await mcCacheKey(
      withTaxContext({
        rothOrderedProfile: { ...profile, designatedBasisCents: 6_000_000 },
      }),
    );
    expect(withDesignatedBasis).not.toBe(baseline);
    const withShare = await mcCacheKey(
      withTaxContext({ rothOrderedProfile: { ...profile, iraShareOfOrderedPool: 0.5 } }),
    );
    expect(withShare).not.toBe(baseline);
    const with457b = await mcCacheKey(
      withTaxContext({
        rothOrderedProfile: { ...profile, designatedAllGovernmental457b: true },
      }),
    );
    expect(with457b).not.toBe(baseline);
  });

  it('an account-level RMD fact changes the key, and the facts serialize as a plain Record', async () => {
    const noFacts = await mcCacheKey(withRmdContext({ members: [] }));
    const inherited = await mcCacheKey(
      withRmdContext({
        members: [],
        rmdFactsByAccountId: { 'acc-1': { inheritedAccount: true } },
      }),
    );
    expect(inherited).not.toBe(noFacts);
    // A DIFFERENT beneficiary category is a different key (the whole point — the
    // rule, and therefore the projected withdrawal, differs).
    const spouse = await mcCacheKey(
      withRmdContext({
        members: [],
        rmdFactsByAccountId: {
          'acc-1': { inheritedAccount: true, beneficiaryType: 'SPOUSE' },
        },
      }),
    );
    const other = await mcCacheKey(
      withRmdContext({
        members: [],
        rmdFactsByAccountId: {
          'acc-1': { inheritedAccount: true, beneficiaryType: 'OTHER_DESIGNATED' },
        },
      }),
    );
    expect(other).not.toBe(spouse);
    // The still-working exception and the sole-spouse designation also move it.
    const stillWorking = await mcCacheKey(
      withRmdContext({
        members: [],
        rmdFactsByAccountId: { 'acc-1': { currentEmployerPlan: true } },
      }),
    );
    expect(stillWorking).not.toBe(noFacts);
  });

  it('a household with NO recorded Roth/RMD facts keeps the key it had before the Roth/RMD facts existed (fields absent)', async () => {
    // The absence contract: an untouched household must not be forced to recompute
    // just because the fields exist in the type.
    const withoutFields = await mcCacheKey(base);
    const withAbsentFields = await mcCacheKey({
      ...base,
      taxContext: undefined,
      mcRmdContext: undefined,
    } as unknown as MonteCarloInput);
    expect(withAbsentFields).toBe(withoutFields);
  });
});

describe('health-coverage cache-key inclusion (a)', () => {
  // `mcCacheKey` hashes `JSON.stringify(input)`, so every newly activated health
  // input has to serialise as PLAIN data AND actually move the key. This is the
  // repo's most-repeated MC data-integrity hazard: a field that serialises
  // to `{}` — a `Map`/`Set` — or one that is simply not on the serialized input
  // lets two households with DIFFERENT coverage months share one cached summary
  // at the same engine version, which no version bump fixes.
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;
  const withTaxContext = (taxContext: unknown): MonteCarloInput =>
    ({ ...base, taxContext } as unknown as MonteCarloInput);

  it('an absent health field reproduces the PRE-FEATURE key exactly', async () => {
    const before = await mcCacheKey(base);
    const after = await mcCacheKey(
      withTaxContext({ ...canonicalAcaBenchmark(undefined) }),
    );
    // An all-absent health context adds no keys at all, so the serialized input
    // is byte-identical to a plain `{ taxContext: {} }`.
    expect(after).toBe(await mcCacheKey(withTaxContext({})));
    // …and the pre-feature input (no taxContext at all) is a distinct key only
    // because `taxContext` itself is present, never because of a health field.
    expect(before).not.toBe(after);
  });

  it('two different coverage-month maps produce DIFFERENT keys', async () => {
    const sevenMonths = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: { perMember: { 'member-primary': { 2030: { partBMonths: 7 } } } },
      }),
    );
    const twelveMonths = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: { perMember: { 'member-primary': { 2030: { partBMonths: 12 } } } },
      }),
    );
    expect(sevenMonths).not.toBe(twelveMonths);
    // …and neither collides with the no-months household.
    const none = await mcCacheKey(withTaxContext({}));
    expect(sevenMonths).not.toBe(none);
    expect(twelveMonths).not.toBe(none);
  });

  it('the coverage-month map survives JSON (a Map/Set here would be invisible)', () => {
    const months = { perMember: { 'member-primary': { 2030: { partBMonths: 7 } } } };
    expect(JSON.parse(JSON.stringify(months))).toEqual(months);
    // The failure mode this guards: a Map serialises to `{}`.
    expect(JSON.stringify(new Map([['member-primary', 7]]))).toBe('{}');
  });

  it('two different FPL regions produce DIFFERENT keys', async () => {
    const contiguous = await mcCacheKey(withTaxContext({ acaFplRegion: 'contiguous' }));
    const alaska = await mcCacheKey(withTaxContext({ acaFplRegion: 'alaska' }));
    const hawaii = await mcCacheKey(withTaxContext({ acaFplRegion: 'hawaii' }));
    expect(new Set([contiguous, alaska, hawaii]).size).toBe(3);
    // An ABSENT region is NOT the same serialized input as an explicit
    // `'contiguous'` — the field is omitted entirely — so a pre-feature
    // household keeps its own key rather than adopting the default's.
    expect(await mcCacheKey(withTaxContext({}))).not.toBe(contiguous);
  });

  it('two different annual benchmark overrides produce DIFFERENT keys', async () => {
    const nineK = await mcCacheKey(
      withTaxContext(canonicalAcaBenchmark([{ taxYear: 2030, annualSlcspDollars: 9_000 }])),
    );
    const tenK = await mcCacheKey(
      withTaxContext(canonicalAcaBenchmark([{ taxYear: 2030, annualSlcspDollars: 10_000 }])),
    );
    expect(nineK).not.toBe(tenK);
    expect(nineK).not.toBe(await mcCacheKey(withTaxContext({})));
  });

  it('benchmark overrides canonicalize by tax year, so row order does not fork the key', async () => {
    const ascending = canonicalAcaBenchmark([
      { taxYear: 2030, annualSlcspDollars: 9_000 },
      { taxYear: 2031, annualSlcspDollars: 9_500 },
    ]);
    const descending = canonicalAcaBenchmark([
      { taxYear: 2031, annualSlcspDollars: 9_500 },
      { taxYear: 2030, annualSlcspDollars: 9_000 },
    ]);
    expect(ascending).toEqual(descending);
    expect(await mcCacheKey(withTaxContext(ascending))).toBe(
      await mcCacheKey(withTaxContext(descending)),
    );
  });

  it('an empty benchmark array is OMITTED, reproducing the no-override key', async () => {
    expect(canonicalAcaBenchmark([])).toEqual({});
    expect(canonicalAcaBenchmark(undefined)).toEqual({});
    expect(await mcCacheKey(withTaxContext(canonicalAcaBenchmark([])))).toBe(
      await mcCacheKey(withTaxContext({})),
    );
  });

  // AGENTS.md ENGINE_VERSION checklist — a new serialized MC
  // field must also prove its ORDERING is canonicalized. `JSON.stringify` keeps
  // an object's own-property insertion order, and the coverage-month map is
  // assembled in whatever order the user added rows (and re-assembled in
  // import/sync order after a round-trip), so without canonicalization two
  // households with the SAME coverage miss each other's cache entry.
  it('coverage months canonicalize by MEMBER id, so row insertion order does not fork the key', async () => {
    const primaryFirst = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: {
            'member-primary': { 2030: { partBMonths: 7 } },
            'member-secondary': { 2030: { partBMonths: 12 } },
          },
        },
      }),
    );
    const secondaryFirst = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: {
            'member-secondary': { 2030: { partBMonths: 12 } },
            'member-primary': { 2030: { partBMonths: 7 } },
          },
        },
      }),
    );
    expect(secondaryFirst).toBe(primaryFirst);
    // …and the canonicalization must not collapse genuinely DIFFERENT maps:
    // swapping the two members' months is a different household.
    const swapped = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: {
            'member-primary': { 2030: { partBMonths: 12 } },
            'member-secondary': { 2030: { partBMonths: 7 } },
          },
        },
      }),
    );
    expect(swapped).not.toBe(primaryFirst);
  });

  it('coverage months canonicalize by TAX YEAR and by month field', async () => {
    // Year keys are integer-like, which the language already enumerates in
    // ascending numeric order; the assertion pins that the canonicalizer keeps
    // it that way rather than re-introducing insertion order.
    const ascending = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: {
            'member-primary': { 2030: { partBMonths: 7 }, 2031: { partBMonths: 12 } },
          },
        },
      }),
    );
    const descending = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: {
            'member-primary': { 2031: { partBMonths: 12 }, 2030: { partBMonths: 7 } },
          },
        },
      }),
    );
    expect(descending).toBe(ascending);
    // The month FIELDS inside one entry are string keys, so their order is
    // genuinely insertion-dependent without canonicalization.
    const partBFirst = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: { 'member-primary': { 2030: { partBMonths: 7, partDMonths: 3 } } },
        },
      }),
    );
    const partDFirst = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: {
          perMember: { 'member-primary': { 2030: { partDMonths: 3, partBMonths: 7 } } },
        },
      }),
    );
    expect(partDFirst).toBe(partBFirst);
  });

  it('a malformed imported coverage map still produces a key instead of throwing', async () => {
    // Import validation covers the envelope only, so every level has to be
    // shape-checked here exactly as the engines' own reader checks it.
    await expect(
      mcCacheKey(withTaxContext({ healthCoverageMonths: { perMember: null } })),
    ).resolves.toEqual(expect.any(String));
    await expect(
      mcCacheKey(
        withTaxContext({ healthCoverageMonths: { perMember: { 'member-primary': null } } }),
      ),
    ).resolves.toEqual(expect.any(String));
    await expect(
      mcCacheKey(
        withTaxContext({
          healthCoverageMonths: { perMember: { 'member-primary': { 2030: null } } },
        }),
      ),
    ).resolves.toEqual(expect.any(String));
  });

  // The per-member retirement year is a NEW serialized MC
  // input field, so it owes the same three proofs: it moves the key, its order
  // is canonical, and its ABSENCE reproduces the pre-feature key.
  it('per-member retirement years move the key, canonicalize by member id, and are absent-safe', async () => {
    const staggered = await mcCacheKey(
      withTaxContext({
        retirementYearByMember: [
          { memberId: 'member-primary', retirementYear: 2026 },
          { memberId: 'member-secondary', retirementYear: 2032 },
        ],
      }),
    );
    const later = await mcCacheKey(
      withTaxContext({
        retirementYearByMember: [
          { memberId: 'member-primary', retirementYear: 2026 },
          { memberId: 'member-secondary', retirementYear: 2033 },
        ],
      }),
    );
    // A different retirement year is a different plan — different Marketplace
    // months, different PTC, different balances.
    expect(later).not.toBe(staggered);
    // Member order is canonicalized.
    const reversed = await mcCacheKey(
      withTaxContext({
        retirementYearByMember: [
          { memberId: 'member-secondary', retirementYear: 2032 },
          { memberId: 'member-primary', retirementYear: 2026 },
        ],
      }),
    );
    expect(reversed).toBe(staggered);
    // A same-date household emits no table at all and keeps its old key.
    expect(await mcCacheKey(withTaxContext({}))).not.toBe(staggered);
  });

  it('the three fields are independently keyed (no two collapse onto one key)', async () => {
    const months = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: { perMember: { 'member-primary': { 2030: { partBMonths: 7 } } } },
      }),
    );
    const region = await mcCacheKey(withTaxContext({ acaFplRegion: 'alaska' }));
    const benchmark = await mcCacheKey(
      withTaxContext(canonicalAcaBenchmark([{ taxYear: 2030, annualSlcspDollars: 9_000 }])),
    );
    const all = await mcCacheKey(
      withTaxContext({
        healthCoverageMonths: { perMember: { 'member-primary': { 2030: { partBMonths: 7 } } } },
        acaFplRegion: 'alaska',
        ...canonicalAcaBenchmark([{ taxYear: 2030, annualSlcspDollars: 9_000 }]),
      }),
    );
    expect(new Set([months, region, benchmark, all]).size).toBe(4);
  });
});
