/**
 * Always-on byte-identity assert test for the Monte Carlo hot path: rebuilds
 * the two fixture inputs (own copy of the capture test's builders — see
 * `apps/web/src/test/capture-mc-perf-identity-fixture.test.ts` for the
 * unskip → capture → re-skip procedure), runs `runMonteCarlo`, and
 * deep-equals `summaryToComparable(summary)` against the committed fixture.
 * MUST stay green through every hot-path memoization/hoisting
 * change — a red result means the last change moved a number;
 * fix the code, never re-capture the fixture.
 *
 * Also carries the memo-equivalence tests for each memoized site (resolution,
 * federal config, ages, survivors, tiers): memoized === direct for a
 * published year, a sparse-clamped year, and an extrapolated year, with a
 * cache-bypass mechanism (a `structuredClone`d snapshot forces a
 * guaranteed WeakMap-key miss).
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * byte-identity assert test plus the memo-equivalence suite for every hot-path
 * memoization site (resolution memo, federal-config memo, birthdate memos ×2,
 * survivor precompute + tri-state consumer, tier prebuild) — splitting would
 * fragment one cohesive byte-identity contract across files with no natural
 * seam. The fixture deep-equal assert pins the numbers, so a refactor here is
 * checked against a frozen baseline, not by eye.
 * Trigger: a change adding 5 or more lines here must either refactor the file
 * back under 800 lines or re-justify this exception in this note.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import fixtureJson from './__fixtures__/mc-perf-identity.json';
import {
  buildRunContext,
  fillYearBalancesAndTax,
  newTaxPathState,
  runMonteCarlo,
} from './monte-carlo';
import type {
  McQcdContext,
  MonteCarloAccountLedger,
  MonteCarloInput,
  McTaxContext,
  TaxPathContext,
} from './monte-carlo';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import { makeMonthlyExpenseBase, summaryToComparable } from './monte-carlo.test-helpers';
import type { MagiCapOverride } from '../db/types';
import {
  resolveSnapshotYear,
  TaxIntegrationInvalidInputError,
} from './tax-integration-helpers';
import { resolveFederalTaxSnapshotForYear } from './federal-tax-extrapolation';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import type { TaxConfig } from './federal-tax';
import type { CalibrationSnapshot } from './calibration';
import {
  ageInTaxYear,
  computeRmd,
  UnsupportedTaxYearError as RmdUnsupportedTaxYearError,
} from './rmd';
import { RMD_DIVISORS } from './rmd-divisors';
import {
  computeSsTaxation,
  UnsupportedTaxYearError as SsUnsupportedTaxYearError,
} from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { hasAttainedAgeByYearEnd } from './balance-projection-runner-tax-helpers';
import {
  applyPerYearTaxForPathWithConversion,
  buildSurvivorStatesByYear,
  deriveMcSurvivors,
  type McSurvivorState,
} from './monte-carlo-tax';
// Namespace import (alongside the named imports above) so the survivor spy
// test can `vi.spyOn` the live `deriveMcSurvivors` binding that
// `monte-carlo.ts` calls internally.
import * as monteCarloTaxModule from './monte-carlo-tax';
import { buildStrategyTiers, type AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import type { StepOutcome } from './projection-engine/kernel';

const FIRST_YEAR = 2026;
const RETIREMENT_YEAR = 2046;
const HORIZON_YEAR = 2086;
const SEED = 12345;
/** 0-indexed (July) — a non-January as-of month. */
const TODAY_MONTH_INDEX = 6;
/** Non-zero scenario inflation rate. */
const SCENARIO_INFLATION_PCT = 3;

const STEP_COUNT = (HORIZON_YEAR - FIRST_YEAR + 1) * 12;
const RETIREMENT_STEP = (RETIREMENT_YEAR - FIRST_YEAR) * 12;

/** Two-account ledger mirroring `monte-carlo.bench.ts`'s `buildLedger` —
 *  equities-heavy brokerage (post-tax) + bonds-heavy IRA (pre-tax), both
 *  owned by the single tax-context member so RMD/QCD owner-matching engages.
 *  Own copy of `capture-mc-perf-identity-fixture.test.ts`'s builder (copy, do
 *  not share, so this file has zero import-time dependency on the capture
 *  test). */
function buildBaseLedger(): MonteCarloAccountLedger[] {
  const monthlyContribPost = (20_000 * 0.6) / 12;
  const monthlyContribPre = (20_000 * 0.4) / 12;
  const contribPostPrimary = new Float64Array(STEP_COUNT);
  const contribPreSecondary = new Float64Array(STEP_COUNT);
  for (let i = 0; i < Math.min(RETIREMENT_STEP, STEP_COUNT); i += 1) {
    contribPostPrimary[i] = monthlyContribPost;
    contribPreSecondary[i] = monthlyContribPre;
  }
  return [
    {
      id: 'primary',
      ownerId: 'member-1',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: new Float64Array(STEP_COUNT),
      contribPost: contribPostPrimary,
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'secondary',
      ownerId: 'member-1',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: new Float64Array(STEP_COUNT),
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

/** Nominal SS/other-income year arrays (SS starts at retirement). */
function buildYearArrays(): { ssByYear: number[]; incomeByYear: number[] } {
  const years = HORIZON_YEAR - FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    FIRST_YEAR + i >= RETIREMENT_YEAR ? 30_000 : 0,
  );
  const incomeByYear = Array.from({ length: years }, () => 0);
  return { ssByYear, incomeByYear };
}

/** Single-filer tax context (member id unified to `member-1`). */
function buildTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      {
        memberId: 'member-1',
        isoBirthdate: '1971-06-15',
        onMedicare: false,
        hasAcaCoverage: false,
      },
    ],
    householdSize: 1,
  };
}

/** Fixture case (a): bench-shaped `taxEfficient` two-account household with a tax
 *  context, `pathCount: 500, seed: 12345`. */
function buildCaseAInput(): MonteCarloInput {
  return {
    portfolioToday: 500_000,
    accountMcLedger: buildBaseLedger(),
    annualContribution: 20_000,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(80_000, STEP_COUNT),
    ...buildYearArrays(),
    pathCount: 500,
    seed: SEED,
    strategyKind: 'taxEfficient',
    taxContext: buildTaxContext(),
    scenarioInflationPct: SCENARIO_INFLATION_PCT,
    todayMonthIndex: TODAY_MONTH_INDEX,
  };
}

/** Fixture case (b): case (a)'s household plus a single-window `magiCapOverride`
 *  (Fill mode targeting a Roth IRA added to the ledger) and a `qcdContext`
 *  entry, `pathCount: 200`. */
function buildCaseBInput(): MonteCarloInput {
  const caseA = buildCaseAInput();
  const rothLedgerEntry: MonteCarloAccountLedger = {
    id: 'roth',
    ownerId: 'member-1',
    initialPre: 0,
    initialPost: 10_000,
    contribPre: new Float64Array(STEP_COUNT),
    contribPost: new Float64Array(STEP_COUNT),
    deposit: new Float64Array(STEP_COUNT),
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
  };
  const magiCapOverride: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'retirementStart' },
        end: { kind: 'year', year: HORIZON_YEAR + 1 },
        magiCeilingAnnualDollars: 150_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth',
      },
    ],
  };
  const magiCapWindowBounds = [
    { startYear: RETIREMENT_YEAR, endYear: HORIZON_YEAR + 1, brokenAnchor: false },
  ];
  const qcdContext: McQcdContext = {
    entries: [
      {
        memberId: 'member-1',
        sourceAccountId: 'secondary',
        annualAmountDollars: 10_000,
        startYear: RETIREMENT_YEAR,
        endYear: HORIZON_YEAR + 1,
      },
    ],
    firstEligibleYearByOwner: { 'member-1': RETIREMENT_YEAR },
    inflationPct: SCENARIO_INFLATION_PCT,
  };
  return {
    ...caseA,
    accountMcLedger: [...caseA.accountMcLedger, rothLedgerEntry],
    pathCount: 200,
    magiCapOverride,
    magiCapWindowBounds,
    qcdContext,
  };
}

interface McPerfIdentityFixture {
  readonly caseA: unknown;
  readonly caseB: unknown;
}

const fixture = fixtureJson as McPerfIdentityFixture;

// Case (a) runs once; the fixture comparison and the comparator self-tests all
// read the same summary (none of them mutates it).
let caseASummary: ReturnType<typeof runMonteCarlo>;
beforeAll(() => {
  caseASummary = runMonteCarlo(buildCaseAInput());
});

describe('MC perf-identity fixture — byte-identity through every hot-path change', () => {
  it('case (a) — taxEfficient two-account household reproduces the captured fixture', () => {
    expect(summaryToComparable(caseASummary)).toEqual(fixture.caseA);
  });

  it('case (b) — Fill-mode magiCapOverride + qcdContext reproduces the captured fixture', () => {
    const summary = runMonteCarlo(buildCaseBInput());
    expect(summaryToComparable(summary)).toEqual(fixture.caseB);
  });
});

describe('summaryToComparable — self-test', () => {
  it('is discriminating: a summary differing in one representative balance is NOT equal', () => {
    const summary = caseASummary;
    const comparable = summaryToComparable(summary);
    const perturbed = {
      ...summary,
      percentilesReal: {
        ...summary.percentilesReal,
        p50: summary.percentilesReal.p50.map((v, i) => (i === 0 ? v + 1 : v)),
      },
    };
    expect(summaryToComparable(perturbed)).not.toEqual(comparable);
  });

  it('ignores computedAt: a summary differing only in computedAt IS equal', () => {
    const summary = caseASummary;
    const comparable = summaryToComparable(summary);
    const restamped = { ...summary, computedAt: summary.computedAt + 1_000 };
    expect(summaryToComparable(restamped)).toEqual(comparable);
  });
});

// ---------------------------------------------------------------------------
// Memo-equivalence tests — memoized === direct. Cache-bypass mechanism: a
// `structuredClone`d
// snapshot object is a guaranteed WeakMap-key miss (identity-keyed), so it
// forces an independent recompute to compare against the original's cached
// result; a second call with the SAME clone reference then asserts a cache
// hit (returns the identical object reference).
// ---------------------------------------------------------------------------

/** Sparse two-year `CalibrationSnapshot<unknown>` (keys 2020, 2025 — a gap in
 *  between) for `resolveSnapshotYear`'s generic published/sparse/extrapolated
 *  coverage. */
function buildSparseSnapshot(): CalibrationSnapshot<unknown> {
  return {
    values: { 2020: { marker: 'a' }, 2025: { marker: 'b' } },
    metadata: { source: 'test', asOfDate: '2020-01-01' },
  };
}

describe('resolveSnapshotYear memo', () => {
  it('published year: memoized === direct (structuredClone bypass) and is a cache hit by reference on 2nd call', () => {
    const snap = buildSparseSnapshot();
    const cached = resolveSnapshotYear(snap, 2025, 3);
    const clone = structuredClone(snap);
    const direct = resolveSnapshotYear(clone, 2025, 3);
    expect(direct).toEqual(cached);
    expect(resolveSnapshotYear(snap, 2025, 3)).toBe(cached);
  });

  it('sparse-clamped year: 2022 clamps down to key 2020 (below the 2025 entry)', () => {
    const snap = buildSparseSnapshot();
    const result = resolveSnapshotYear(snap, 2022);
    expect(result.effectiveYear).toBe(2020);
    expect(result.taxYearExtrapolated).toBe(false);
    // structuredClone bypass reproduces the same result independently.
    expect(resolveSnapshotYear(structuredClone(snap), 2022)).toEqual(result);
  });

  it('extrapolated year: 2030 clamps to the latest key (2025) and scales', () => {
    const snap = buildSparseSnapshot();
    const result = resolveSnapshotYear(snap, 2030, 4);
    expect(result.effectiveYear).toBe(2025);
    expect(result.taxYearExtrapolated).toBe(true);
    expect(result.thresholdScalingFactor).toBeCloseTo(Math.pow(1.04, 5), 10);
    expect(resolveSnapshotYear(structuredClone(snap), 2030, 4)).toEqual(result);
  });

  it('memo-key: undefined-vs-0 inflationRatePct are distinct cache entries, each resolving correctly', () => {
    const snap = buildSparseSnapshot();
    const undefinedRate = resolveSnapshotYear(snap, 2030);
    const zeroRate = resolveSnapshotYear(snap, 2030, 0);
    expect(undefinedRate.thresholdScalingFactor).toBe(1);
    expect(zeroRate.thresholdScalingFactor).toBe(1);
    // A second run against the already-warmed memo with a DIFFERENT
    // (non-zero) rate must resolve the NEW key, not stale-hit the old one.
    const warmedThenNewRate = resolveSnapshotYear(snap, 2030, 5);
    expect(warmedThenNewRate.thresholdScalingFactor).toBeCloseTo(Math.pow(1.05, 5), 10);
    // The original undefined/0 entries are still independently correct.
    expect(resolveSnapshotYear(snap, 2030)).toBe(undefinedRate);
    expect(resolveSnapshotYear(snap, 2030, 0)).toBe(zeroRate);
  });

  it('empty snapshot still throws TaxIntegrationInvalidInputError on the 1st AND 2nd call', () => {
    const empty: CalibrationSnapshot<unknown> = {
      values: {},
      metadata: { source: 'test', asOfDate: '2020-01-01' },
    };
    expect(() => resolveSnapshotYear(empty, 2025)).toThrow(TaxIntegrationInvalidInputError);
    expect(() => resolveSnapshotYear(empty, 2025)).toThrow(TaxIntegrationInvalidInputError);
  });

  it('immutability: mutating a field on the cached resolution throws', () => {
    const snap = buildSparseSnapshot();
    const result = resolveSnapshotYear(snap, 2025);
    expect(() => {
      (result as { effectiveYear: number }).effectiveYear = 999;
    }).toThrow();
  });

  it('128-entry FIFO eviction: the oldest key is evicted (recomputes to an equal, non-identical result) while a recent key stays a cache hit', () => {
    const snap = buildSparseSnapshot();
    const taxYear = 2030;
    let firstResult: ReturnType<typeof resolveSnapshotYear> | undefined;
    let lastResult: ReturnType<typeof resolveSnapshotYear> | undefined;
    // >128 distinct (taxYear, inflationRatePct) keys against the SAME snapshot
    // object forces the 128-entry FIFO to evict the oldest (inflationRatePct 0).
    for (let rate = 0; rate <= 130; rate += 1) {
      const result = resolveSnapshotYear(snap, taxYear, rate);
      if (rate === 0) firstResult = result;
      if (rate === 130) lastResult = result;
    }
    // Recently-inserted key: still a cache hit (same object by reference).
    expect(resolveSnapshotYear(snap, taxYear, 130)).toBe(lastResult);
    // Oldest key: evicted, so it recomputes — a NEW object, but value-equal —
    // proving eviction-then-correct-recompute, not a broken cache.
    const recomputedFirst = resolveSnapshotYear(snap, taxYear, 0);
    expect(recomputedFirst).toEqual(firstResult);
    expect(recomputedFirst).not.toBe(firstResult);
  });
});

/** Sparse two-year `CalibrationSnapshot<TaxConfig>` (keys 2020, 2025 — a gap
 *  in between) built from real published `TaxConfig` values so
 *  `resolveFederalTaxSnapshotForYear`'s extrapolation math runs against a
 *  realistic shape. */
function buildSparseFederalSnapshot(): CalibrationSnapshot<TaxConfig> {
  return {
    values: {
      2020: FEDERAL_TAX_CONFIG.values[2024],
      2025: FEDERAL_TAX_CONFIG.values[2026],
    },
    metadata: FEDERAL_TAX_CONFIG.metadata,
  };
}

describe('resolveFederalTaxSnapshotForYear memo', () => {
  it('published year: memoized === direct (structuredClone bypass) and is a cache hit by reference on 2nd call', () => {
    const snap = buildSparseFederalSnapshot();
    const cached = resolveFederalTaxSnapshotForYear(snap, 2025, 3);
    const direct = resolveFederalTaxSnapshotForYear(structuredClone(snap), 2025, 3);
    expect(direct).toEqual(cached);
    expect(resolveFederalTaxSnapshotForYear(snap, 2025, 3)).toBe(cached);
  });

  it('sparse-clamped year: 2022 clamps down to key 2020, returning the shared original snapshot instance', () => {
    const snap = buildSparseFederalSnapshot();
    const result = resolveFederalTaxSnapshotForYear(snap, 2022);
    expect(result.lookupYear).toBe(2020);
    expect(result.taxYearExtrapolated).toBe(false);
    expect(result.snapshot).toBe(snap);
    expect(resolveFederalTaxSnapshotForYear(structuredClone(snap), 2022)).toEqual(result);
  });

  it('extrapolated year: 2030 synthesizes a scaled config keyed by the future year', () => {
    const snap = buildSparseFederalSnapshot();
    const result = resolveFederalTaxSnapshotForYear(snap, 2030, 3);
    expect(result.lookupYear).toBe(2030);
    expect(result.taxYearExtrapolated).toBe(true);
    expect(result.snapshot.values[2030]).toBeDefined();
    expect(resolveFederalTaxSnapshotForYear(structuredClone(snap), 2030, 3)).toEqual(result);
  });

  it('memo-key: undefined-vs-0 inflationRatePct are distinct cache entries, each resolving correctly', () => {
    const snap = buildSparseFederalSnapshot();
    const undefinedRate = resolveFederalTaxSnapshotForYear(snap, 2030);
    const zeroRate = resolveFederalTaxSnapshotForYear(snap, 2030, 0);
    expect(undefinedRate.snapshot.values[2030]).toEqual(zeroRate.snapshot.values[2030]);
    const warmedThenNewRate = resolveFederalTaxSnapshotForYear(snap, 2030, 5);
    expect(warmedThenNewRate.snapshot.values[2030]).not.toEqual(undefinedRate.snapshot.values[2030]);
    expect(resolveFederalTaxSnapshotForYear(snap, 2030)).toBe(undefinedRate);
  });

  it('non-extrapolated years cache too (uniform code path)', () => {
    const snap = buildSparseFederalSnapshot();
    const first = resolveFederalTaxSnapshotForYear(snap, 2025);
    const second = resolveFederalTaxSnapshotForYear(snap, 2025);
    expect(second).toBe(first);
  });

  it('immutability: mutating a field on the cached federal config (extrapolated) throws', () => {
    const snap = buildSparseFederalSnapshot();
    const result = resolveFederalTaxSnapshotForYear(snap, 2030, 3);
    const scaledConfig = result.snapshot.values[2030];
    expect(() => {
      (scaledConfig as { standardDeduction: unknown }).standardDeduction = {};
    }).toThrow();
    expect(() => {
      (result as { lookupYear: number }).lookupYear = 999;
    }).toThrow();
  });

  it('128-entry FIFO eviction: the oldest key is evicted (recomputes to an equal, non-identical result) while a recent key stays a cache hit', () => {
    const snap = buildSparseFederalSnapshot();
    const taxYear = 2030;
    let firstResult: ReturnType<typeof resolveFederalTaxSnapshotForYear> | undefined;
    let lastResult: ReturnType<typeof resolveFederalTaxSnapshotForYear> | undefined;
    // >128 distinct (taxYear, inflationRatePct) keys against the SAME snapshot
    // object forces the 128-entry FIFO to evict the oldest (inflationRatePct 0).
    for (let rate = 0; rate <= 130; rate += 1) {
      const result = resolveFederalTaxSnapshotForYear(snap, taxYear, rate);
      if (rate === 0) firstResult = result;
      if (rate === 130) lastResult = result;
    }
    // Recently-inserted key: still a cache hit (same object by reference).
    expect(resolveFederalTaxSnapshotForYear(snap, taxYear, 130)).toBe(lastResult);
    // Oldest key: evicted, so it recomputes — a NEW object, but value-equal —
    // proving eviction-then-correct-recompute, not a broken cache.
    const recomputedFirst = resolveFederalTaxSnapshotForYear(snap, taxYear, 0);
    expect(recomputedFirst).toEqual(firstResult);
    expect(recomputedFirst).not.toBe(firstResult);
  });
});

describe('rmd.ts resolveSnapshot + ageInTaxYear memo', () => {
  it('throws UnsupportedTaxYearError for a taxYear below the snapshot minimum on the 1st AND 2nd call', () => {
    const belowMin = { isoBirthdate: '1950-01-01', taxYear: 2020, accounts: [] };
    expect(() => computeRmd(belowMin, RMD_DIVISORS)).toThrow(RmdUnsupportedTaxYearError);
    expect(() => computeRmd(belowMin, RMD_DIVISORS)).toThrow(RmdUnsupportedTaxYearError);
  });

  it('a valid taxYear still resolves correctly across repeated calls', () => {
    const validInput = { isoBirthdate: '1950-01-01', taxYear: 2024, accounts: [] };
    const first = computeRmd(validInput, RMD_DIVISORS);
    const second = computeRmd(validInput, RMD_DIVISORS);
    expect(second).toEqual(first);
    expect(first.applicable).toBe(true);
  });

  it('ageInTaxYear: memoized birth year matches the direct computation across repeated calls', () => {
    const first = ageInTaxYear('1960-03-15', 2030);
    const second = ageInTaxYear('1960-03-15', 2030);
    expect(second).toBe(first);
    expect(first).toBe(70);
    // A different taxYear against the SAME (now-cached) birthdate resolves
    // correctly too — the memo caches the birth year, not the age.
    expect(ageInTaxYear('1960-03-15', 2031)).toBe(71);
  });

  it('an invalid birthdate still throws on the 1st AND 2nd call (never cached as a success)', () => {
    expect(() => ageInTaxYear('not-a-date', 2030)).toThrow();
    expect(() => ageInTaxYear('not-a-date', 2030)).toThrow();
  });
});

describe('ss-taxation.ts resolveSnapshot memo', () => {
  it('throws UnsupportedTaxYearError for a taxYear below the snapshot minimum on the 1st AND 2nd call', () => {
    const belowMin = {
      grossSsCents: 0,
      otherAgiCents: 0,
      taxExemptInterestCents: 0,
      filingStatus: 'Single' as const,
      taxYear: 2020,
    };
    expect(() => computeSsTaxation(belowMin, SS_TAX_THRESHOLDS)).toThrow(SsUnsupportedTaxYearError);
    expect(() => computeSsTaxation(belowMin, SS_TAX_THRESHOLDS)).toThrow(SsUnsupportedTaxYearError);
  });

  it('a valid taxYear still resolves correctly across repeated calls', () => {
    const validInput = {
      grossSsCents: 2_000_000,
      otherAgiCents: 3_000_000,
      taxExemptInterestCents: 0,
      filingStatus: 'Single' as const,
      taxYear: 2024,
    };
    const first = computeSsTaxation(validInput, SS_TAX_THRESHOLDS);
    const second = computeSsTaxation(validInput, SS_TAX_THRESHOLDS);
    expect(second).toEqual(first);
  });
});

describe('hasAttainedAgeByYearEnd memo', () => {
  it('memoized effective birth year matches the direct computation across repeated calls', () => {
    // Born Jan 1 shifts the effective birth year back one.
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2024, 65)).toBe(true);
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2024, 65)).toBe(true);
    expect(hasAttainedAgeByYearEnd('1960-06-15', 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd('1960-06-15', 2025, 65)).toBe(true);
  });

  it('an unparseable birthdate caches as null and returns false on every call', () => {
    expect(hasAttainedAgeByYearEnd('garbage', 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd('garbage', 2024, 65)).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// Survivor precompute equivalence + tri-state consumer tests
// ---------------------------------------------------------------------------

/** Two-member household: primary survives the whole horizon, secondary dies
 *  mid-horizon — gives both-alive / primary-only-alive / (with a later
 *  primaryDeathYear override) both-dead coverage. */
function twoMemberTaxContext(filingStatusOverride?: McTaxContext['filingStatusOverride']): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: [
      { memberId: 'primary', isoBirthdate: '1960-01-01', onMedicare: true, hasAcaCoverage: false },
      { memberId: 'secondary', isoBirthdate: '1962-01-01', onMedicare: true, hasAcaCoverage: false },
    ],
    householdSize: 2,
    secondaryDeathYear: 2045,
    primaryDeathYear: 2050,
    ...(filingStatusOverride !== undefined ? { filingStatusOverride } : {}),
  };
}

describe('buildSurvivorStatesByYear equivalence', () => {
  it('matches per-call deriveMcSurvivors across both-alive / primary-only-alive / both-dead years', () => {
    const taxCtx = twoMemberTaxContext();
    const firstYear = 2040;
    const horizonYears = 20; // 2040..2059 — covers both-alive (2040), secondary-dead (2046), both-dead (2055).
    const retirementYear = 2040;
    const states = buildSurvivorStatesByYear(taxCtx, firstYear, horizonYears, retirementYear);
    expect(states.length).toBe(horizonYears);
    for (let i = 0; i < horizonYears; i += 1) {
      const direct = deriveMcSurvivors(taxCtx, firstYear + i, retirementYear);
      expect(states[i]).toEqual(direct);
    }
    // Sanity: the three phases are actually represented (not all-alive / all-null).
    expect(states[0]?.survivors.length).toBe(2); // 2040: both alive
    expect(states[6]?.survivors.length).toBe(1); // 2046: secondary dead
    expect(states[15]).toBeNull(); // 2055: both dead
  });

  it('matches per-call deriveMcSurvivors with a filingStatusOverride too', () => {
    const taxCtx = twoMemberTaxContext('MFJ');
    const firstYear = 2040;
    const horizonYears = 12;
    const retirementYear = 2040;
    const states = buildSurvivorStatesByYear(taxCtx, firstYear, horizonYears, retirementYear);
    for (let i = 0; i < horizonYears; i += 1) {
      expect(states[i]).toEqual(deriveMcSurvivors(taxCtx, firstYear + i, retirementYear));
    }
  });
});

describe('survivor tri-state CONSUMER — applyPerYearTaxForPathWithConversion', () => {
  const taxCtx = twoMemberTaxContext();
  const baseArgs = {
    taxCtx,
    taxYear: 2040, // both alive per twoMemberTaxContext
    retirementYear: 2040,
    grossSsDollars: 24_000,
    nominalExpense: 60_000,
    otherIncome: 0,
    priorBalance: 500_000,
    priorPreTaxByOwner: new Map<string, number>([['primary', 500_000_00]]),
    magiMinus2: undefined,
  };

  it('absent (undefined) derives in-function — identical to explicitly passing the derived state', () => {
    const derived = deriveMcSurvivors(taxCtx, baseArgs.taxYear, baseArgs.retirementYear);
    const omitted = applyPerYearTaxForPathWithConversion({ ...baseArgs });
    const explicit = applyPerYearTaxForPathWithConversion({ ...baseArgs, survivorState: derived });
    expect(omitted).toEqual(explicit);
  });

  it('present-null short-circuits to null EVEN when the real year has live survivors', () => {
    // 2040 actually has both members alive (deriveMcSurvivors would NOT
    // return null) — passing survivorState: null must still short-circuit.
    const result = applyPerYearTaxForPathWithConversion({ ...baseArgs, survivorState: null });
    expect(result).toBeNull();
  });

  it('present-object is used AS-IS, not re-derived (a supplied Single filer differs from the real MFJ derivation)', () => {
    const suppliedSingle: McSurvivorState = {
      survivors: [
        { memberId: 'primary', isoBirthdate: '1960-01-01', onMedicare: true, hasAcaCoverage: false },
      ],
      filingStatus: 'Single',
    };
    const withSupplied = applyPerYearTaxForPathWithConversion({
      ...baseArgs,
      survivorState: suppliedSingle,
    });
    const withDerived = applyPerYearTaxForPathWithConversion({ ...baseArgs }); // MFJ, both survivors
    expect(withSupplied).not.toBeNull();
    expect(withDerived).not.toBeNull();
    // Single vs MFJ brackets differ enough at this income to produce a
    // different federal tax — proving the supplied object drove the result.
    expect(withSupplied!.result.fedTax).not.toBeCloseTo(withDerived!.result.fedTax, 0);
  });
});

describe("applyTaxForYear's local survivor derivation — precompute present vs absent", () => {
  /** Flat pre-tax pool every step so an ALIVE year assesses non-zero tax
   *  (giving the equivalence check discriminating power); a DEAD year must
   *  stay at $0 regardless of which arm (precompute vs fallback) resolves it. */
  function flatPoolOut(stepCount: number, poolDollars: number): StepOutcome {
    return {
      preEnd: new Float64Array(stepCount).fill(poolDollars),
      postEnd: new Float64Array(stepCount),
      growth: new Float64Array(stepCount),
      contributions: new Float64Array(stepCount),
      withdrawal: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      expense: new Float64Array(stepCount),
      income: new Float64Array(stepCount),
      cumCpi: new Float64Array(stepCount).fill(1),
      depletionStepIdx: -1,
    } as unknown as StepOutcome;
  }

  function buildInput(): MonteCarloInput {
    const horizonYears = 4;
    const stepCount = horizonYears * 12;
    return {
      portfolioToday: 2_000_000,
      accountMcLedger: [],
      annualContribution: 0,
      firstYear: 2030,
      retirementYear: 2030,
      horizonYear: 2033,
      monthlyExpenseBase: makeMonthlyExpenseBase(80_000, stepCount),
      ssByYear: [0, 0, 0, 0],
      incomeByYear: [0, 0, 0, 0],
      pathCount: 1,
      seed: 1,
      strategyKind: 'taxEfficient',
      taxContext: {
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'Single',
        members: [
          { memberId: 'primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
        ],
        householdSize: 1,
        primaryDeathYear: 2031, // alive 2030-2031, dead 2032-2033
      },
    } as unknown as MonteCarloInput;
  }

  it('a both/all-dead year assesses $0 tax identically whether the precompute is present (null entry) or absent (falls back to deriveMcSurvivors)', () => {
    const input = buildInput();
    const horizonYears = 4;
    const stepCount = horizonYears * 12;
    const out = flatPoolOut(stepCount, 2_000_000);
    const nominalExpenseByYear = new Float64Array(horizonYears).fill(80_000);
    const ctx = buildRunContext(input);
    expect(ctx.survivorStateByYear).not.toBeNull();
    expect(ctx.survivorStateByYear?.[2]).toBeNull(); // 2032: dead

    // Arm A: precompute present (the normal, hoisted path).
    const stateWithPrecompute = newTaxPathState(
      input, out, stepCount, horizonYears, nominalExpenseByYear, ctx,
    )!;
    const balNA: number[] = new Array(horizonYears);
    const balRA: number[] = new Array(horizonYears);
    fillYearBalancesAndTax(out, balNA, balRA, stepCount, stateWithPrecompute);

    // Arm B: precompute absent (`survivorStateByYear: null`) — forces the
    // fallback `deriveMcSurvivors` call on every year, exactly like a
    // no-taxContext run.
    const stateNoPrecomputeBase = newTaxPathState(
      input, out, stepCount, horizonYears, nominalExpenseByYear, ctx,
    )!;
    const stateNoPrecompute: TaxPathContext = { ...stateNoPrecomputeBase, survivorStateByYear: null };
    const balNB: number[] = new Array(horizonYears);
    const balRB: number[] = new Array(horizonYears);
    expect(() =>
      fillYearBalancesAndTax(out, balNB, balRB, stepCount, stateNoPrecompute),
    ).not.toThrow();

    // Both arms: the dead years (index 2, 3) assess NO tax (accumulators stay
    // at their initial 0 — `applyPerYearTaxForPath` short-circuited to null).
    expect(stateWithPrecompute.acc.fedTax[2]).toBe(0);
    expect(stateWithPrecompute.acc.fedTax[3]).toBe(0);
    expect(stateNoPrecompute.acc.fedTax[2]).toBe(0);
    expect(stateNoPrecompute.acc.fedTax[3]).toBe(0);
    // Both arms: the alive years (index 0, 1) DID assess real tax (proving
    // the pool/expense fixture is discriminating, not a vacuous all-zero case).
    expect(stateWithPrecompute.acc.fedTax[0]).toBeGreaterThan(0);
    expect(stateNoPrecompute.acc.fedTax[0]).toBeGreaterThan(0);
    // The two arms agree exactly across the whole horizon.
    expect(stateNoPrecompute.acc).toEqual(stateWithPrecompute.acc);
    expect(stateNoPrecompute.taxDrawByYear).toEqual(stateWithPrecompute.taxDrawByYear);
  });

  it('the precompute is actually CONSUMED: deriveMcSurvivors is never called when ctx.survivorStateByYear is present, and is called once per year when absent', () => {
    const input = buildInput();
    const horizonYears = 4;
    const stepCount = horizonYears * 12;
    const out = flatPoolOut(stepCount, 2_000_000);
    const nominalExpenseByYear = new Float64Array(horizonYears).fill(80_000);
    // Build the run context (and its precompute) BEFORE the spy attaches —
    // `buildRunContext` legitimately calls `deriveMcSurvivors` once per year
    // to populate `survivorStateByYear`, which is not what this test measures.
    const ctx = buildRunContext(input);
    const spy = vi.spyOn(monteCarloTaxModule, 'deriveMcSurvivors');

    // Arm A: precompute present. If `applyTaxForYear` silently ignored
    // `ctx.survivorStateByYear` and always re-derived, this spy would catch
    // it even though the equivalence test above still passes (both arms derive
    // from the same taxCtx and land on the same numbers either way).
    const stateWithPrecompute = newTaxPathState(
      input, out, stepCount, horizonYears, nominalExpenseByYear, ctx,
    )!;
    const balNA: number[] = new Array(horizonYears);
    const balRA: number[] = new Array(horizonYears);
    fillYearBalancesAndTax(out, balNA, balRA, stepCount, stateWithPrecompute);
    expect(spy).not.toHaveBeenCalled();

    // Arm B: precompute absent — the SAME code path must fall back to
    // deriving via `deriveMcSurvivors`, exactly once per year (proving arm
    // A's silence above is real precompute consumption, not a fixture where
    // the function is simply never reached).
    const stateNoPrecomputeBase = newTaxPathState(
      input, out, stepCount, horizonYears, nominalExpenseByYear, ctx,
    )!;
    const stateNoPrecompute: TaxPathContext = { ...stateNoPrecomputeBase, survivorStateByYear: null };
    const balNB: number[] = new Array(horizonYears);
    const balRB: number[] = new Array(horizonYears);
    fillYearBalancesAndTax(out, balNB, balRB, stepCount, stateNoPrecompute);
    expect(spy).toHaveBeenCalledTimes(horizonYears);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tier prebuild equivalence
// ---------------------------------------------------------------------------

describe('tier prebuild equivalence', () => {
  function makeAccount(
    id: string,
    taxTreatment: AccountRunState['taxTreatment'],
    accountType: string,
    pre: number,
    post: number,
  ): AccountRunState {
    return {
      id,
      pre,
      post,
      annualRatePct: 5,
      monthlyRate: 0.004,
      taxTreatment,
      accountType,
      deposits: new Float64Array(1),
      depositsPost: new Float64Array(1),
    };
  }

  function representativeHousehold(): AccountRunState[] {
    return [
      makeAccount('brokerage', 'POST_TAX', 'BROKERAGE', 0, 300_000),
      makeAccount('ira', 'PRE_TAX', 'RETIREMENT_IRA', 200_000, 0),
      makeAccount('roth', 'ROTH', 'RETIREMENT_ROTH_IRA', 0, 50_000),
      makeAccount('hsa', 'HSA', 'HSA', 0, 10_000),
      // Synthetic RMD-overflow cash carrier — pushed LAST, matching
      // `runYearByYearStrategyAware`'s own ordering (edge: the carrier
      // must be pushed first so tiers include it — i.e. before tier build).
      makeAccount('__rmd-overflow-cash', 'POST_TAX', 'SAVINGS', 0, 0),
    ];
  }

  it('prebuiltTiers deep-equals a later per-month rebuild for taxEfficient / rothFirst / proportional', () => {
    for (const kind of ['taxEfficient', 'rothFirst', 'proportional'] as const) {
      const state = representativeHousehold();
      const prebuilt = buildStrategyTiers(state, kind);
      // Mutate balances in place (simulating months of growth/withdrawal) —
      // tier MEMBERSHIP depends only on account type/treatment, never balance.
      for (const acc of state) {
        acc.pre = acc.pre * 1.1 - 500;
        acc.post = acc.post * 0.95 + 250;
      }
      const rebuiltLater = buildStrategyTiers(state, kind);
      expect(rebuiltLater).toEqual(prebuilt);
    }
  });

  it('customOrder NEVER prebuilds (buildStrategyTiers throws on it)', () => {
    const state = representativeHousehold();
    expect(() => buildStrategyTiers(state, 'customOrder')).toThrow();
  });
});
