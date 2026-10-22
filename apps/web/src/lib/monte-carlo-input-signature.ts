/** Plan Stress Test content signature and the seed derived from it, shared by the page and the assistant's stress-test tool so both sample the same paths.
 * See docs/math-projections.md, "Reading the result" ("What seeds a run"). */
import type { AssetMix } from '../db/types';
import type { MonteCarloInput } from './monte-carlo';
import { MC_PATH_COUNT } from './monte-carlo-scenario-input';
import { seedFromString } from './sfc32';

const PATH_COUNT = MC_PATH_COUNT;

// The context is spread so a field added later is covered; `taxBundle` folds to its `asOfDate`s and `members` to four identity fields.
function taxContextFingerprint(taxCtx: MonteCarloInput['taxContext']): unknown {
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
 * Cache key over every field the kernel reads, so a balance, expense, income, anchor, claim-age or per-account
 * routing edit changes it. Ledger arrays are fingerprinted as `(length, sum, head, mid, tail)`.
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
  // Guardrail baseline arrays feed the kernel, so a guardrail-only edit must change the signature; absent guardrails give `null`, keeping a no-guardrail key byte-identical.
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

// Rolling hash over every `{stocksPct, bondsPct, cashPct}` triplet: two distinct glide configs can share `(sum, head, mid, tail)`,
// so a sampled fingerprint would miss a real `retirementAllocation` edit. `h = (h * 31 + round(v * 100)) | 0`
// (hundredths are lossless for 0-100 %); `null` stays distinct from an empty series.
function arrayOfMixesFingerprint(
  series: ReadonlyArray<AssetMix> | null,
): { length: number; seriesHash: number } | null {
  if (series === null) return null;
  const n = series.length;
  let h = 5381;
  for (let i = 0; i < n; i += 1) {
    const m = series[i];
    h = (h * 31 + Math.round(m.stocksPct * 100)) | 0;
    h = (h * 31 + Math.round(m.bondsPct * 100)) | 0;
    h = (h * 31 + Math.round(m.cashPct * 100)) | 0;
  }
  return { length: n, seriesHash: h };
}

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

/** The seed the page's auto-run stamps on `input`: `seedFromString` of its signature. Manual Recalculate and error-retry derive their own seeds. */
export function autoRunSeed(input: MonteCarloInput, cbpFailed: boolean): number {
  return seedFromString(hashMcInput(input, cbpFailed));
}
