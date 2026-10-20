/**
 * The Plan Stress Test's content signature and the seed derived from it. The
 * Balance Projection page and the AI assistant's stress-test tool both import
 * this module, so a tool run and the page's auto-run draw one seed from one
 * function and sample the same paths. Moved here unchanged from
 * `components/PlanStressTestSection.tsx`; the pinned vector in
 * `monte-carlo-input-signature.test.ts` proves the signature string and the
 * seed did not move.
 *
 * See docs/math-projections.md, "Reading the result" ("What seeds a run").
 */
import type { AssetMix } from '../db/types';
import type { MonteCarloInput } from './monte-carlo';
import { MC_PATH_COUNT } from './monte-carlo-scenario-input';
import { seedFromString } from './sfc32';

const PATH_COUNT = MC_PATH_COUNT;

/**
 * Fingerprint the whole `McTaxContext` so ANY tax-assumption edit
 * (withdrawal strategy, calibration bundle, cost-basis fraction, filing-status
 * override, projected death years, inflation rate, the health-coverage keys,
 * the Roth-basis profile, the MAGI bootstrap, …) changes the signature and fires
 * the debounced auto-rerun. Identity of every field matters: any one shifts the
 * per-year tax-band output even when projection-relevant inputs are otherwise
 * identical.
 *
 * Enumerating the fields by hand would silently leave the panel showing
 * pre-edit numbers for every field added to `McTaxContext` later — including
 * the three health-coverage keys the Health coverage modal writes. Spreading
 * the context covers present AND future fields.
 * Two members are pulled out of the spread:
 *  - `taxBundle` is replaced by an `asOfDate` triple, so a calibration refresh
 *    still invalidates the key without serialising every bracket table;
 *  - `members` is reduced to the four identity-bearing fields (the per-year
 *    Medicare / Marketplace months are DERIVED per projection year inside the
 *    engine from `healthCoverageMonths`, which the spread already covers).
 * `JSON.stringify` drops `undefined`-valued keys, so an unset optional
 * contributes nothing — a scenario that sets none keeps its previous key shape.
 */
export function taxContextFingerprint(taxCtx: MonteCarloInput['taxContext']): unknown {
  if (!taxCtx) return null;
  const { taxBundle, members, ...rest } = taxCtx;
  return {
    ...rest,
    members: members.map((m) => ({
      memberId: m.memberId,
      isoBirthdate: m.isoBirthdate,
      onMedicare: m.onMedicare,
      hasAcaCoverage: m.hasAcaCoverage,
    })),
    bundleVersion: {
      federalTaxAsOf: taxBundle.federalTax.metadata.asOfDate,
      irmaaAsOf: taxBundle.irmaa.metadata.asOfDate,
      acaPtcAsOf: taxBundle.acaPtc.metadata.asOfDate,
    },
  };
}

/**
 * Cache key. Includes every field the MC kernel reads
 * from the input — collapsing on `scenarioId` alone misses balance /
 * expense / income / anchor / claim-age edits within the same
 * scenario.
 *
 * Hashes a deterministic fingerprint of each ledger entry's
 * `contribPre`/`contribPost`/`deposit` arrays. Two scenarios with the
 * same `annualContribution` + events but different per-account
 * routing now produce different signatures so the auto-rerun effect
 * fires when the per-account split changes. The fingerprint is a
 * `(length, sum, head, mid, tail)` quintuple over the Float64Array —
 * cheap to compute, defeats every realistic same-sum-different-shape
 * collision (contributions only land in `[0, retirementStepIdx)` and
 * deposits only in `[retirementStepIdx, …)`).
 *
 * Callers: the page's `currentSignature` memo and `autoRunSeed` below. The
 * signature string is pinned by `monte-carlo-input-signature.test.ts`.
 */
export function hashMcInput(input: MonteCarloInput, cbpFailed: boolean): string {
  const events = input.events
    ? [...input.events].sort((a, b) => a.month - b.month)
    : [];
  const ledger = input.accountMcLedger.map((entry) => ({
    id: entry.id,
    initialPre: entry.initialPre,
    initialPost: entry.initialPost,
    assetMix: entry.assetMix,
    assetMixSeriesFingerprint: arrayOfMixesFingerprint(entry.assetMixSeries),
    cbpPlanningReturnPct: entry.cbpPlanningReturnPct,
    contribPreFingerprint: arrayFingerprint(entry.contribPre),
    contribPostFingerprint: arrayFingerprint(entry.contribPost),
    depositFingerprint: arrayFingerprint(entry.deposit),
  }));
  // Guardrails: the guardrail config + its per-year baseline series
  // (net-need / total / essential real) + the effective-tax proxy all feed the
  // MC kernel, so a same-scenario guardrail-only edit MUST change the signature
  // (else the debounced auto-rerun never fires → the panel shows stale pre-edit
  // results). Fingerprint the baseline arrays with the same `(length, sum, head,
  // mid, tail)` quintuple the ledger arrays use. Absent guardrails → `null`, so
  // a no-guardrail scenario's signature stays byte-identical to the pre-feature
  // key (disabled guardrails must stay byte-identical).
  const guardrailFingerprint = input.downturnGuardrails
    ? {
        config: input.downturnGuardrails,
        effectiveTaxRate: input.guardrailEffectiveTaxRate ?? null,
        baselineNetNeed: numberArrayFingerprint(input.guardrailBaselineRealNetNeedByYear),
        baselineTotal: numberArrayFingerprint(input.guardrailBaselineTotalRealByYear),
        essential: numberArrayFingerprint(input.guardrailEssentialRealByYear),
      }
    : null;
  const taxFingerprint = taxContextFingerprint(input.taxContext);
  return JSON.stringify({
    cbpFailed,
    pathCount: PATH_COUNT,
    portfolioToday: input.portfolioToday,
    accountMcLedger: ledger,
    annualContribution: input.annualContribution,
    firstYear: input.firstYear,
    retirementYear: input.retirementYear,
    horizonYear: input.horizonYear,
    // The windowed per-month base (+ buckets)
    // replaces the flat annual scalar in the cache key.
    monthlyExpenseBase: input.monthlyExpenseBase,
    monthlyExpenseBucketsBase: input.monthlyExpenseBucketsBase ?? null,
    ssByYear: input.ssByYear,
    incomeByYear: input.incomeByYear,
    scenarioInflationPct: input.scenarioInflationPct ?? null,
    primaryRetirementMonth0: input.primaryRetirementMonth0 ?? null,
    strategyKind: input.strategyKind ?? null,
    customTiers: input.customTiers ?? null,
    excludedIndices: Array.from(input.excludedIndices ?? new Set<number>()).sort((a, b) => a - b),
    tracksInflationIncomeByYear: input.tracksInflationIncomeByYear ?? null,
    events,
    taxFingerprint,
    guardrailFingerprint,
  });
}

/**
 * Order-sensitive rolling hash over every step's `{stocksPct, bondsPct,
 * cashPct}` triplet — used by `hashMcInput` so the cache key detects any
 * pointwise change in an `assetMixSeries` glide path.
 *
 * Why rolling hash over samples/sums: the series is piecewise-constant +
 * linear-segment shaped, so two distinct glide configs (different
 * `endYear` / `glideStartYear`) can produce the same `(sum, head, mid,
 * tail)` triplet on at least one axis while yielding a different yearly
 * series → stale stress-test results would survive a real
 * `retirementAllocation` edit. The rolling hash folds every element in
 * index order, so any pointwise difference flips the key.
 *
 * Hash mechanic: djb2-style 32-bit accumulator — for each triplet,
 * fold `Math.round(v * 100)` (= value in hundredths, lossless for the
 * 0–100 % range) for stocks, bonds, cash in that order:
 *   `h = (h * 31 + roundedValue) | 0`
 * The `| 0` keeps arithmetic inside the signed 32-bit integer range.
 * Return shape: `{ length, seriesHash }` — `length` preserves the
 * distinct-length case; `seriesHash` is the folded integer. `null` input
 * returns `null` (distinct from an empty series).
 */
function arrayOfMixesFingerprint(
  series: ReadonlyArray<AssetMix> | null,
): { length: number; seriesHash: number } | null {
  if (series === null) return null;
  const n = series.length;
  // djb2-style seed; chosen to avoid all-zero collapse on empty series.
  let h = 5381;
  for (let i = 0; i < n; i += 1) {
    const m = series[i];
    h = (h * 31 + Math.round(m.stocksPct * 100)) | 0;
    h = (h * 31 + Math.round(m.bondsPct * 100)) | 0;
    h = (h * 31 + Math.round(m.cashPct * 100)) | 0;
  }
  return { length: n, seriesHash: h };
}

/** Compact, deterministic fingerprint of a Float64Array. */
function arrayFingerprint(arr: Float64Array): {
  length: number;
  sum: number;
  head: number;
  mid: number;
  tail: number;
} {
  if (arr.length === 0) return { length: 0, sum: 0, head: 0, mid: 0, tail: 0 };
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) sum += arr[i];
  return {
    length: arr.length,
    sum,
    head: arr[0],
    mid: arr[Math.floor(arr.length / 2)],
    tail: arr[arr.length - 1],
  };
}

/** Plain-`number[]` variant of `arrayFingerprint` (guardrails) — the
 *  guardrail baseline series are structured-clone-safe plain arrays, not
 *  Float64Arrays. `undefined` → `null` (distinct from an empty series). */
function numberArrayFingerprint(arr: readonly number[] | undefined): {
  length: number;
  sum: number;
  head: number;
  mid: number;
  tail: number;
} | null {
  if (arr === undefined) return null;
  if (arr.length === 0) return { length: 0, sum: 0, head: 0, mid: 0, tail: 0 };
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) sum += arr[i];
  return {
    length: arr.length,
    sum,
    head: arr[0],
    mid: arr[Math.floor(arr.length / 2)],
    tail: arr[arr.length - 1],
  };
}

/**
 * The seed the page's auto-run stamps on `input`: `seedFromString` of its
 * signature. A manual Recalculate folds a counter into this seed and an
 * error-retry reroll uses the clock; neither is an auto-run, so neither has
 * a function here.
 */
export function autoRunSeed(input: MonteCarloInput, cbpFailed: boolean): number {
  return seedFromString(hashMcInput(input, cbpFailed));
}
