import { describe, expect, it } from 'vitest';
import {
  buildPerAccountKernelInputs,
  routeHouseholdLevelEvents,
  type MonteCarloAccountLedger,
  type MonteCarloPortfolioEvent,
} from './monte-carlo-per-account.js';
import { monthlyEquivalent } from './projection-engine/monthly-conversion.js';
import type { HistoricalColumns, HistoricalMonth } from './projection-engine/historical.js';
import type { KernelAccount } from './projection-engine/kernel-shared.js';
import type { AssetMix } from '../db/types.js';

// ---------------------------------------------------------------------------
// Fixtures. Mirror the builder style in monte-carlo.test.ts — one ledger
// factory whose only load-bearing fields are the ones the per-account return
// series + event routing read.
// ---------------------------------------------------------------------------

const STEPS = 6;

/** Single ledger entry; defaults to a non-CBP, flat-mix accumulation account.
 *  Override any field to exercise the CBP / glide-series / event branches. */
function ledgerEntry(
  overrides: Partial<MonteCarloAccountLedger> = {},
): MonteCarloAccountLedger {
  return {
    id: 'acc',
    initialPre: 0,
    initialPost: 100_000,
    contribPre: new Float64Array(STEPS),
    contribPost: new Float64Array(STEPS),
    deposit: new Float64Array(STEPS),
    assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    ...overrides,
  };
}

/** Distinct per-step sampled tuple so a glide-series mismatch with a flat mix
 *  would surface (each month carries different stock/bond/cash returns). */
function sampledMonths(count: number): HistoricalMonth[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-${String(i + 1).padStart(2, '0')}`,
    stockPct: 1 + i * 0.1,
    bondPct: 0.4 + i * 0.05,
    cashPct: 0.1 + i * 0.01,
    cpiPct: 0.2,
  }));
}

/** SoA adapter: pack a `HistoricalMonth[]` into `{ sampledIdx, columns }`
 *  with an identity index (row `i` → dataset index `i`), so
 *  `columns.stockPct[sampledIdx[i]] === months[i].stockPct`. Lets each call site
 *  feed the struct-of-arrays signature while the assertions keep reading the
 *  original per-row `months` array. */
function sampledColumns(months: HistoricalMonth[]): {
  sampledIdx: Int32Array;
  columns: HistoricalColumns;
} {
  const n = months.length;
  const stockPct = new Float64Array(n);
  const bondPct = new Float64Array(n);
  const cashPct = new Float64Array(n);
  const cpiPct = new Float64Array(n);
  const sampledIdx = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    stockPct[i] = months[i].stockPct;
    bondPct[i] = months[i].bondPct;
    cashPct[i] = months[i].cashPct;
    cpiPct[i] = months[i].cpiPct;
    sampledIdx[i] = i;
  }
  return { sampledIdx, columns: { stockPct, bondPct, cashPct, cpiPct } };
}

const FLAT_MIX: AssetMix = { stocksPct: 60, bondsPct: 30, cashPct: 10 };

function blended(mix: AssetMix, m: HistoricalMonth): number {
  return (
    (mix.stocksPct / 100) * m.stockPct +
    (mix.bondsPct / 100) * m.bondPct +
    (mix.cashPct / 100) * m.cashPct
  );
}

describe('buildPerAccountKernelInputs — return series branches', () => {
  it('uses a constant monthly-equivalent series for a CBP-planning-rate entry and ignores the sampled tuple', () => {
    // Arrange: a CBP entry (cbpPlanningReturnPct set) plus a non-null sampled
    // tuple that should be entirely ignored.
    const ledger = [ledgerEntry({ cbpPlanningReturnPct: 6 })];

    // Act
    const [account] = buildPerAccountKernelInputs({
      ledger,
      stepCount: STEPS,
      ...sampledColumns(sampledMonths(STEPS)),
      injectedReturnPct: null,
    });

    // Assert: every step equals monthlyEquivalent(6); the sampled tuple is unused.
    const monthly = monthlyEquivalent(6);
    expect(account.returnPct).toHaveLength(STEPS);
    for (let i = 0; i < STEPS; i += 1) {
      expect(account.returnPct[i]).toBe(monthly);
    }
  });

  it('short-circuits to the injected series, ignoring the sampled tuple', () => {
    // Arrange: a non-CBP entry, an injected series, and a sampled tuple that
    // would produce different numbers if it leaked through.
    const injected = Float64Array.from([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    const ledger = [ledgerEntry()];

    // Act
    const [account] = buildPerAccountKernelInputs({
      ledger,
      stepCount: STEPS,
      ...sampledColumns(sampledMonths(STEPS)),
      injectedReturnPct: injected,
    });

    // Assert: the series is the injected one, copied verbatim.
    expect(Array.from(account.returnPct)).toEqual(Array.from(injected));
  });

  it('throws the length-mismatch error when assetMixSeries.length !== stepCount', () => {
    // Arrange: a glide series one step short of stepCount.
    const series: AssetMix[] = Array.from({ length: STEPS - 1 }, () => FLAT_MIX);
    const ledger = [ledgerEntry({ assetMix: null, assetMixSeries: series })];

    // Act + Assert
    expect(() =>
      buildPerAccountKernelInputs({
        ledger,
        stepCount: STEPS,
        ...sampledColumns(sampledMonths(STEPS)),
        injectedReturnPct: null,
      }),
    ).toThrow(`assetMixSeries length mismatch: expected ${STEPS}, got ${STEPS - 1}`);
  });

  it('applies the per-step glide mix as (stocks/100)*stock + (bonds/100)*bond + (cash/100)*cash', () => {
    // Arrange: a per-step series that varies the mix step to step.
    const series: AssetMix[] = Array.from({ length: STEPS }, (_, i) => ({
      stocksPct: 50 + i,
      bondsPct: 40 - i,
      cashPct: 10,
    }));
    const sampled = sampledMonths(STEPS);
    const ledger = [ledgerEntry({ assetMix: null, assetMixSeries: series })];

    // Act
    const [account] = buildPerAccountKernelInputs({
      ledger,
      stepCount: STEPS,
      ...sampledColumns(sampled),
      injectedReturnPct: null,
    });

    // Assert: each step matches the blended expression for that step's mix.
    for (let i = 0; i < STEPS; i += 1) {
      expect(account.returnPct[i]).toBe(blended(series[i], sampled[i]));
    }
  });

  it('throws when only sampledIdx is provided (columns null) — inconsistent SoA pairing', () => {
    const { sampledIdx } = sampledColumns(sampledMonths(STEPS));
    expect(() =>
      buildPerAccountKernelInputs({
        ledger: [ledgerEntry()],
        stepCount: STEPS,
        sampledIdx,
        columns: null,
        injectedReturnPct: null,
      }),
    ).toThrow('sampledIdx and columns must both be null or both be provided together');
  });

  it('throws when only columns is provided (sampledIdx null) — inconsistent SoA pairing', () => {
    const { columns } = sampledColumns(sampledMonths(STEPS));
    expect(() =>
      buildPerAccountKernelInputs({
        ledger: [ledgerEntry()],
        stepCount: STEPS,
        sampledIdx: null,
        columns,
        injectedReturnPct: null,
      }),
    ).toThrow('sampledIdx and columns must both be null or both be provided together');
  });

  it('does NOT throw for the valid both-null pairing (injected-returns mode)', () => {
    const injected = Float64Array.from([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    expect(() =>
      buildPerAccountKernelInputs({
        ledger: [ledgerEntry()],
        stepCount: STEPS,
        sampledIdx: null,
        columns: null,
        injectedReturnPct: injected,
      }),
    ).not.toThrow();
  });

  it('produces identical numbers from a flat assetMix and a constant assetMixSeries', () => {
    // Arrange: one entry with the flat mix, one with a constant series of the
    // same mix; both see the same sampled tuple.
    const soa = sampledColumns(sampledMonths(STEPS));
    const constantSeries: AssetMix[] = Array.from({ length: STEPS }, () => FLAT_MIX);
    const flat = buildPerAccountKernelInputs({
      ledger: [ledgerEntry({ assetMix: FLAT_MIX, assetMixSeries: null })],
      stepCount: STEPS,
      ...soa,
      injectedReturnPct: null,
    });
    const series = buildPerAccountKernelInputs({
      ledger: [ledgerEntry({ assetMix: null, assetMixSeries: constantSeries })],
      stepCount: STEPS,
      ...soa,
      injectedReturnPct: null,
    });

    // Assert: the two return series are element-wise identical.
    expect(Array.from(series[0].returnPct)).toEqual(Array.from(flat[0].returnPct));
  });
});

describe('buildPerAccountKernelInputs — no-clone identity contract', () => {
  it('references the bundle contribPre/contribPost/deposit arrays by identity', () => {
    // Arrange
    const entry = ledgerEntry();

    // Act
    const [account] = buildPerAccountKernelInputs({
      ledger: [entry],
      stepCount: STEPS,
      ...sampledColumns(sampledMonths(STEPS)),
      injectedReturnPct: null,
    });

    // Assert: the kernel input arrays are the SAME objects as the bundle's
    // (no defensive clone) — the documented per-account contract.
    expect(account.contribPre).toBe(entry.contribPre);
    expect(account.contribPost).toBe(entry.contribPost);
    expect(account.deposit).toBe(entry.deposit);
  });
});

describe('routeHouseholdLevelEvents', () => {
  /** Two-account ledger with non-zero initial balances so the pre-retirement
   *  proportional split is observable (200k vs 600k → 25% / 75%). */
  function twoAccountLedger(): MonteCarloAccountLedger[] {
    return [
      ledgerEntry({ id: 'a', initialPre: 0, initialPost: 200_000 }),
      ledgerEntry({ id: 'b', initialPre: 0, initialPost: 600_000 }),
    ];
  }

  function buildAccounts(ledger: MonteCarloAccountLedger[]): KernelAccount[] {
    return buildPerAccountKernelInputs({
      ledger,
      stepCount: STEPS,
      ...sampledColumns(sampledMonths(STEPS)),
      injectedReturnPct: null,
    });
  }

  it('lands a post-retirement household event in the household deposit series', () => {
    // Arrange: retirement at step 2; the event fires at step 4 (post-retirement),
    // carries no targetAccountId → household-level.
    const ledger = twoAccountLedger();
    const accounts = buildAccounts(ledger);
    const deposit = new Float64Array(STEPS);
    const events: MonteCarloPortfolioEvent[] = [
      { month: 4, amount: 9_000, source: 'targetedOneOff' },
    ];

    // Act
    routeHouseholdLevelEvents({
      events,
      ledger,
      accounts,
      stepCount: STEPS,
      retirementStepIdx: 2,
      deposit,
    });

    // Assert: the dollars land in the household deposit series at that step;
    // the per-account contribPost arrays are untouched.
    expect(deposit[4]).toBe(9_000);
    expect(Array.from(accounts[0].contribPost)).toEqual(new Array<number>(STEPS).fill(0));
    expect(Array.from(accounts[1].contribPost)).toEqual(new Array<number>(STEPS).fill(0));
  });

  it('splits a pre-retirement household event proportionally and clones-on-write, leaving the bundle pristine', () => {
    // Arrange: retirement at step 5; event at step 1 (pre-retirement), no target.
    const ledger = twoAccountLedger();
    const accounts = buildAccounts(ledger);
    // Pin the bundle's contribPost identities so we can prove clone-on-write.
    const bundlePostA = ledger[0].contribPost;
    const bundlePostB = ledger[1].contribPost;
    const deposit = new Float64Array(STEPS);
    const events: MonteCarloPortfolioEvent[] = [
      { month: 1, amount: 8_000, source: 'targetedOneOff' },
    ];

    // Act
    routeHouseholdLevelEvents({
      events,
      ledger,
      accounts,
      stepCount: STEPS,
      retirementStepIdx: 5,
      deposit,
    });

    // Assert: proportional split by initial balance (200k/800k = 25%,
    // 600k/800k = 75%) lands at the event month.
    expect(accounts[0].contribPost[1]).toBeCloseTo(2_000); // 8000 * 0.25
    expect(accounts[1].contribPost[1]).toBeCloseTo(6_000); // 8000 * 0.75
    // Clone-on-write swapped in private copies — the bundle arrays are a
    // different object and remain all-zero.
    expect(accounts[0].contribPost).not.toBe(bundlePostA);
    expect(accounts[1].contribPost).not.toBe(bundlePostB);
    expect(Array.from(bundlePostA)).toEqual(new Array<number>(STEPS).fill(0));
    expect(Array.from(bundlePostB)).toEqual(new Array<number>(STEPS).fill(0));
    // Household deposit series is untouched on the pre-retirement path.
    expect(Array.from(deposit)).toEqual(new Array<number>(STEPS).fill(0));
  });
});
