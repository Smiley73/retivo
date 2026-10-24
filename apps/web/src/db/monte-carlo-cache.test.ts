import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMonteCarloCache,
  computeCacheKey,
  getCached,
  mcCacheKey,
  monteCarloCacheCount,
  peekCached,
  putCached,
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

const PRIMARY_LIMIT = 20;
const STRESS_COMPARISONS = 4;
const COMBINED_LIMIT = PRIMARY_LIMIT + STRESS_CASE_IDS.length * STRESS_COMPARISONS;

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

  async function writeStressComparison(round: string): Promise<void> {
    for (const caseId of STRESS_CASE_IDS) {
      await putCached(`stress-${round}-${caseId}`, fakeSummary(1), 'marketStress');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  async function fillPrimaryBudget(): Promise<void> {
    for (let i = 1; i <= PRIMARY_LIMIT; i++) {
      await putCached(`p${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('overflowing the stress budget evicts a stress entry, never a primary one', async () => {
    // A cap raise with one global LRU walk is not a reserve: the overflowing comparison would evict primary entries the Scenarios page reads, so budgets are per class.
    await fillPrimaryBudget();
    const rounds = ['a', 'b', 'c', 'd', 'e'];
    expect(rounds).toHaveLength(STRESS_COMPARISONS + 1);
    for (const round of rounds) await writeStressComparison(round);

    for (let i = 1; i <= PRIMARY_LIMIT; i++) {
      expect(await getCached(`p${i}`)).not.toBeNull();
    }
    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).toBeNull();
      for (const round of ['b', 'c', 'd', 'e']) {
        expect(await getCached(`stress-${round}-${caseId}`)).not.toBeNull();
      }
    }
    expect(await monteCarloCacheCount()).toBe(COMBINED_LIMIT);
  });

  it('keeps a second comparison alongside the first, so alternating scenarios stays free', async () => {
    // With a one-comparison budget, writing B evicted A and every move between scenarios re-ran four 10,000-path simulations.
    await writeStressComparison('a');
    await writeStressComparison('b');
    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).not.toBeNull();
      expect(await getCached(`stress-b-${caseId}`)).not.toBeNull();
    }
  });

  it('a primary write over budget evicts a primary entry, never a stress one', async () => {
    // The reserve holds both ways: a primary overflow must not reclaim the comparison's slots.
    await writeStressComparison('a');
    await fillPrimaryBudget();
    await putCached('p-extra', fakeSummary(99));

    for (const caseId of STRESS_CASE_IDS) {
      expect(await getCached(`stress-a-${caseId}`)).not.toBeNull();
    }
    expect(await getCached('p1')).toBeNull();
    expect(await getCached('p-extra')).not.toBeNull();
    expect(await monteCarloCacheCount()).toBe(
      PRIMARY_LIMIT + STRESS_CASE_IDS.length,
    );
  });

  it('evicts the oldest entry when the cap is exceeded', async () => {
    const over = PRIMARY_LIMIT + 1;
    for (let i = 1; i <= over; i++) {
      // Wait a tick between writes so lastAccessedAt is strictly increasing.
      await putCached(`k${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await monteCarloCacheCount()).toBe(PRIMARY_LIMIT);
    expect(await getCached('k1')).toBeNull();
    expect(await getCached(`k${over}`)).not.toBeNull();
  });

  it('refreshes lastAccessedAt on read so LRU evicts the truly oldest', async () => {
    for (let i = 1; i <= PRIMARY_LIMIT; i++) {
      await putCached(`k${i}`, fakeSummary(i));
      await new Promise((r) => setTimeout(r, 2));
    }
    await getCached('k1');
    await new Promise((r) => setTimeout(r, 2));
    await putCached('k-extra', fakeSummary(PRIMARY_LIMIT + 1));
    expect(await getCached('k1')).not.toBeNull();
    expect(await getCached('k2')).toBeNull();
  });

  it('invalidates entries whose engineVersion mismatches', async () => {
    await putCached('stale', { ...fakeSummary(1), engineVersion: -1 });
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

  // An entry stamped with an older engine version is a cache miss.
  it('invalidates a v24-vintage named-strategy entry after the v25 tax aware bump', async () => {
    await putCached('v24', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v24');
    if (e) {
      e.engineVersion = 24;
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
      e.engineVersion = 25;
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
      e.engineVersion = 27;
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
      e.engineVersion = 28;
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
      e.engineVersion = 32;
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
      e.engineVersion = 34;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v34')).toBeNull();
  });

  it('invalidates a v34-vintage entry after the v35 per category inflation bump', async () => {
    await putCached('v34', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v34');
    if (e) {
      e.engineVersion = 34;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v34')).toBeNull();
  });

  it('invalidates a v35-vintage entry after the v37 RMD-floor / deposit-routing bump', async () => {
    await putCached('v35', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v35');
    if (e) {
      e.engineVersion = 35;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v35')).toBeNull();
  });

  it('invalidates a v37-vintage entry after the v38 post-primary split-routing bump', async () => {
    await putCached('v37', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v37');
    if (e) {
      e.engineVersion = 37;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v37')).toBeNull();
  });

  it('invalidates a v41-vintage entry after the v42 deterministic per-account allocation bump', async () => {
    await putCached('v41', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v41');
    if (e) {
      e.engineVersion = 41;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v41')).toBeNull();
  });

  it('invalidates a v43-vintage entry after the v44 classification-agnostic + 0–200 glide bump', async () => {
    await putCached('v43', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v43');
    if (e) {
      e.engineVersion = 43;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v43')).toBeNull();
  });

  it('invalidates a v44-vintage entry after the v45 HSA withdrawal-reserve bump', async () => {
    await putCached('v44', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v44');
    if (e) {
      e.engineVersion = 44;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v44')).toBeNull();
  });

  it('invalidates a v45-vintage entry after the v46 MIXED Roth-designated engine bump', async () => {
    await putCached('v45', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v45');
    if (e) {
      e.engineVersion = 45;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v45')).toBeNull();
  });

  it('invalidates a v46-vintage entry after the v47 hsa qualified expense flag bump', async () => {
    await putCached('v46', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v46');
    if (e) {
      e.engineVersion = 46;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v46')).toBeNull();
  });

  it('invalidates a v47-vintage entry after the v48 rmd shortfall mixed roth overcount bump', async () => {
    await putCached('v47', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const tx = handle.transaction('monteCarloResults', 'readwrite');
    const e = await tx.store.get('v47');
    if (e) {
      e.engineVersion = 47;
      await tx.store.put(e);
    }
    await tx.done;
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v47')).toBeNull();
  });

  it('invalidates a v49-vintage entry after the v50 remove combined pot bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v49')).toBeNull();
  });

  it('invalidates a v50-vintage entry after the v51 absorbing-depletion + per-owner RMD-floor bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v50')).toBeNull();
  });

  it('invalidates a v51-vintage entry after the v52 QCD per-path wiring bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v51')).toBeNull();
  });

  it('invalidates a v52-vintage entry after the v53 downturn guardrails bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v52')).toBeNull();
  });

  it('invalidates a v52-vintage entry after the v56 QCD net-taxable IRA-scoping bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v52')).toBeNull();
  });

  it('invalidates a v53-vintage entry after the v54 guardrail discretionary floor bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v53')).toBeNull();
  });

  it('invalidates a v56-vintage entry after the v57 projection floor reserve depletion bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v56')).toBeNull();
  });

  it('invalidates a v57-vintage entry after the v58 conversion tax funding floor respect bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v57')).toBeNull();
  });

  it('invalidates a v58-vintage entry after the v59 hoh senior deduction phaseout base bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v58')).toBeNull();
  });

  it('invalidates a v59-vintage entry after the v60 ltcg and ordinary extrapolation rounding down bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v59')).toBeNull();
  });

  it('invalidates a v60-vintage entry after the v61 social security statutory corrections bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v60')).toBeNull();
  });

  it('invalidates a v62-vintage entry after the v63 market stress core bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v62')).toBeNull();
  });

  it('invalidates a v63-vintage entry after the v64 filing-plan activation bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v63')).toBeNull();
  });

  it('invalidates a v66-vintage entry after the v67 Roth conversion cutover bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v66')).toBeNull();
  });

  it('invalidates a v67-vintage entry after the v68 Roth clock inference bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v67')).toBeNull();
  });

  it('invalidates a v68-vintage entry after the v69 inherited-Roth pass-through bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v68')).toBeNull();
  });

  it('invalidates a v69-vintage entry after the v70 derived-Roth-basis bump', async () => {
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
    expect(ENGINE_VERSION).toBe(73);
    expect(await getCached('v69')).toBeNull();
  });

  it('invalidates v70, v71 and v72 entries after the health-cost bumps (71 benchmark growth, 72 credit applied to premiums, 73 credit pricing)', async () => {
    expect(ENGINE_VERSION).toBe(73);
    const { db } = await import('./store.js');
    const handle = await db();
    for (const stale of [70, 71, 72]) {
      const key = `v${stale}`;
      await putCached(key, fakeSummary(1));
      const tx = handle.transaction('monteCarloResults', 'readwrite');
      const entry = await tx.store.get(key);
      if (entry) {
        entry.engineVersion = stale;
        await tx.store.put(entry);
      }
      await tx.done;
      expect(await getCached(key)).toBeNull();
    }
  });
});

describe('ACA opt-out cache-key canonicalization (a)', () => {
  // A minimal input slice: mcCacheKey only JSON.stringifies, so absent fields do not affect the assertions.
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
  // An active QCD must serialize into the key, and `firstEligibleYearByOwner` must be a plain Record: a Map stringifies to `{}` and would silently collide keys.
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
  // Every market-stress lever and the longevity-extended `horizonYear` must change the key, or a stressed run would be served its base summary.
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
  // Every newly activated Roth and RMD fact must serialize as plain data: `JSON.stringify(new Map())` is `{}`, which would silently collide keys.
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
    expect(JSON.parse(JSON.stringify(canonical))).toEqual(canonical);
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
    const stillWorking = await mcCacheKey(
      withRmdContext({
        members: [],
        rmdFactsByAccountId: { 'acc-1': { currentEmployerPlan: true } },
      }),
    );
    expect(stillWorking).not.toBe(noFacts);
  });

  it('a household with NO recorded Roth/RMD facts keeps the key it had before the Roth/RMD facts existed (fields absent)', async () => {
    // An untouched household must keep its pre-feature key.
    const withoutFields = await mcCacheKey(base);
    const withAbsentFields = await mcCacheKey({
      ...base,
      taxContext: undefined,
      mcRmdContext: undefined,
    } as unknown as MonteCarloInput);
    expect(withAbsentFields).toBe(withoutFields);
  });
});

describe('modeled Medical expenses cache-key inclusion', () => {
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;
  const withMedical = (fields: Record<string, unknown>): MonteCarloInput =>
    ({ ...base, ...fields } as unknown as MonteCarloInput);

  it('two different medical expense bases produce DIFFERENT keys', async () => {
    const a = await mcCacheKey(withMedical({ monthlyMedicalExpenseBase: [600, 600], medicalExpenseRatePct: 5 }));
    const b = await mcCacheKey(withMedical({ monthlyMedicalExpenseBase: [600, 300], medicalExpenseRatePct: 5 }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(await mcCacheKey(base));
  });

  it('two different medical rates and two different bucket sets produce DIFFERENT keys', async () => {
    const monthlyMedicalExpenseBase = [600, 600];
    const five = await mcCacheKey(withMedical({ monthlyMedicalExpenseBase, medicalExpenseRatePct: 5 }));
    const six = await mcCacheKey(withMedical({ monthlyMedicalExpenseBase, medicalExpenseRatePct: 6 }));
    expect(five).not.toBe(six);
    const bucketed = (ratePct: number): MonteCarloInput =>
      withMedical({
        monthlyMedicalExpenseBase,
        medicalExpenseRatePct: 5,
        monthlyMedicalExpenseBucketsBase: [{ ratePct, amount: [600, 600] }],
      });
    expect(await mcCacheKey(bucketed(5))).not.toBe(await mcCacheKey(bucketed(7)));
    expect(await mcCacheKey(bucketed(5))).not.toBe(five);
  });

  it('absent fields reproduce the PRE-FEATURE key byte for byte', async () => {
    expect(
      await mcCacheKey(
        withMedical({
          monthlyMedicalExpenseBase: undefined,
          medicalExpenseRatePct: undefined,
          monthlyMedicalExpenseBucketsBase: undefined,
        }),
      ),
    ).toBe(await mcCacheKey(base));
  });
});

describe('health-coverage cache-key inclusion (a)', () => {
  // Every newly activated health input must serialize as plain data and move the key: a Map or Set stringifies to `{}` and would serve one household's summary to another.
  const base = { portfolioToday: 1_000_000, firstYear: 2026 } as unknown as MonteCarloInput;
  const withTaxContext = (taxContext: unknown): MonteCarloInput =>
    ({ ...base, taxContext } as unknown as MonteCarloInput);

  it('an absent health field reproduces the PRE-FEATURE key exactly', async () => {
    const before = await mcCacheKey(base);
    const after = await mcCacheKey(
      withTaxContext({ ...canonicalAcaBenchmark(undefined) }),
    );
    expect(after).toBe(await mcCacheKey(withTaxContext({})));
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
    const none = await mcCacheKey(withTaxContext({}));
    expect(sevenMonths).not.toBe(none);
    expect(twelveMonths).not.toBe(none);
  });

  it('the coverage-month map survives JSON (a Map/Set here would be invisible)', () => {
    const months = { perMember: { 'member-primary': { 2030: { partBMonths: 7 } } } };
    expect(JSON.parse(JSON.stringify(months))).toEqual(months);
    expect(JSON.stringify(new Map([['member-primary', 7]]))).toBe('{}');
  });

  it('two different FPL regions produce DIFFERENT keys', async () => {
    const contiguous = await mcCacheKey(withTaxContext({ acaFplRegion: 'contiguous' }));
    const alaska = await mcCacheKey(withTaxContext({ acaFplRegion: 'alaska' }));
    const hawaii = await mcCacheKey(withTaxContext({ acaFplRegion: 'hawaii' }));
    expect(new Set([contiguous, alaska, hawaii]).size).toBe(3);
    // An absent region is not the same input as an explicit 'contiguous', so a pre-feature household keeps its own key.
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

  it('two different medical inflation rates produce DIFFERENT keys', async () => {
    const six = await mcCacheKey(withTaxContext({ medicalInflationRatePct: 6 }));
    const seven = await mcCacheKey(withTaxContext({ medicalInflationRatePct: 7 }));
    expect(six).not.toBe(seven);
    expect(six).not.toBe(await mcCacheKey(withTaxContext({})));
  });

  it('an absent medical inflation rate reproduces the PRE-FEATURE key byte for byte', async () => {
    expect(await mcCacheKey(withTaxContext({ medicalInflationRatePct: undefined }))).toBe(
      await mcCacheKey(withTaxContext({})),
    );
  });

  // A new serialized MC field must also prove its ordering is canonicalized: JSON.stringify keeps insertion order.
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
    // Integer-like year keys already enumerate in ascending order; this pins that the canonicalizer keeps that.
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
    // Month fields inside one entry are string keys, so their order is insertion-dependent without canonicalization.
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

  // The per-member retirement year is a new serialized MC input, so it owes the key-change, ordering and absence proofs.
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
    expect(later).not.toBe(staggered);
    const reversed = await mcCacheKey(
      withTaxContext({
        retirementYearByMember: [
          { memberId: 'member-secondary', retirementYear: 2032 },
          { memberId: 'member-primary', retirementYear: 2026 },
        ],
      }),
    );
    expect(reversed).toBe(staggered);
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

describe('peekCached — a read that leaves the cache as it found it', () => {
  beforeEach(async () => {
    await clearMonteCarloCache();
  });
  afterEach(async () => {
    await clearMonteCarloCache();
  });

  async function rowOf(key: string) {
    const { db } = await import('./store.js');
    return (await db()).get('monteCarloResults', key);
  }

  it('returns the summary on a hit and changes neither lastAccessedAt nor the entry count', async () => {
    await putCached('hit', fakeSummary(7));
    await putCached('other', fakeSummary(8));
    const before = await rowOf('hit');
    await new Promise((r) => setTimeout(r, 5));
    const out = await peekCached('hit');
    expect(out?.seed).toBe(7);
    expect((await rowOf('hit'))?.lastAccessedAt).toBe(before?.lastAccessedAt);
    expect(await monteCarloCacheCount()).toBe(2);
    await getCached('hit');
    expect((await rowOf('hit'))?.lastAccessedAt).toBeGreaterThan(before!.lastAccessedAt);
  });

  it('is null on a miss', async () => {
    expect(await peekCached('nope')).toBeNull();
    expect(await monteCarloCacheCount()).toBe(0);
  });

  it('reads a stale-engine entry as a miss and leaves it in place, where getCached deletes it', async () => {
    await putCached('stale', fakeSummary(1));
    const { db } = await import('./store.js');
    const handle = await db();
    const row = await handle.get('monteCarloResults', 'stale');
    await handle.put('monteCarloResults', { ...row!, engineVersion: -1 });

    expect(await peekCached('stale')).toBeNull();
    expect(await monteCarloCacheCount()).toBe(1);
    expect((await rowOf('stale'))?.engineVersion).toBe(-1);

    expect(await getCached('stale')).toBeNull();
    expect(await monteCarloCacheCount()).toBe(0);
  });

  it('does not evict: peeking at a full cache keeps every entry', async () => {
    for (let i = 1; i <= PRIMARY_LIMIT; i++) await putCached(`k${i}`, fakeSummary(i));
    for (let i = 1; i <= PRIMARY_LIMIT; i++) expect(await peekCached(`k${i}`)).not.toBeNull();
    expect(await monteCarloCacheCount()).toBe(PRIMARY_LIMIT);
  });
});
