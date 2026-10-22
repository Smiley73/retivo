/** Monte Carlo post-loop reducer and representative-run selection: percentiles, histograms, reroll bands and `assembleMonteCarloSummary`.
 * See docs/math-projections.md ("The Monte Carlo stress test"). */
import {
  ENGINE_VERSION,
  buildRunContext,
  runOnePath,
  seedForPathIndex,
  type RunContext,
  type PathLoopAccumulation,
} from './monte-carlo.js';
import { applyMcRmdToRepresentativeYears } from './monte-carlo-rmd.js';
import { applyMcTaxToRepresentativeYears } from './monte-carlo-tax-burden.js';
import type {
  HistogramBin,
  McBasis,
  MonteCarloInput,
  MonteCarloSummary,
  PercentileSeries,
  RepresentativeRun,
} from './monte-carlo-types.js';

function percentile(sortedAsc: ArrayLike<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(p * (sortedAsc.length - 1) + 0.5)),
  );
  return sortedAsc[idx];
}

function percentileSeries(byYear: number[][]): PercentileSeries {
  const horizon = byYear.length;
  const p10 = new Array(horizon).fill(0);
  const p25 = new Array(horizon).fill(0);
  const p50 = new Array(horizon).fill(0);
  for (let y = 0; y < horizon; y++) {
    // Typed-array numeric sort (no comparator) is bit-identical to `(a,b)=>a-b` for these finite values and skips the JS callback.
    const sorted = Float64Array.from(byYear[y]).sort();
    p10[y] = percentile(sorted, 0.1);
    p25[y] = percentile(sorted, 0.25);
    p50[y] = percentile(sorted, 0.5);
  }
  return { p10, p25, p50 };
}

// Hand-rounded quasi-log ladder so chart axis labels read as clean dollar figures; $0 gets its own bin to separate depleted paths from small endings.
const ENDING_HIST_BIN_LOWERS = [
  0,
  1_000,
  2_500,
  5_000,
  10_000,
  20_000,
  35_000,
  50_000,
  75_000,
  100_000,
  150_000,
  200_000,
  300_000,
  400_000,
  500_000,
  700_000,
  1_000_000,
  1_300_000,
  1_700_000,
  2_200_000,
  3_000_000,
  4_000_000,
  5_500_000,
  7_500_000,
  10_000_000,
  13_000_000,
  17_000_000,
  22_000_000,
  30_000_000,
  40_000_000,
  50_000_000,
];

function endingBalanceHistogram(values: number[]): HistogramBin[] {
  const bins: HistogramBin[] = ENDING_HIST_BIN_LOWERS.map((lower) => ({
    lower,
    count: 0,
  }));
  for (const v of values) {
    let idx = 0;
    if (v <= 0) {
      idx = 0;
    } else {
      for (let i = ENDING_HIST_BIN_LOWERS.length - 1; i > 0; i--) {
        if (v >= ENDING_HIST_BIN_LOWERS[i]) {
          idx = i;
          break;
        }
        idx = 1;
      }
    }
    (bins[idx] as { lower: number; count: number }).count += 1;
  }
  return bins;
}

function runPlannedOverlay(input: MonteCarloInput, ctx: RunContext): number[] {
  return runOnePath(input, 1, ctx).balanceByYearNominal;
}

function depletionYearPercentile(
  sortedDepletion: number[],
  pathCount: number,
  p: number,
): number | null {
  const idx = Math.floor(p * pathCount);
  return sortedDepletion.length > idx ? sortedDepletion[idx] : null;
}

// De-minimis real-dollar threshold for a depleted path: the kernel's accept-loss fp residual leaves a tiny positive balance, so the gate is `endingReal < EPS_REAL`, not `=== 0`.
const EPS_REAL = 1;

interface CardTargets {
  0.5: number | null;
  0.25: number | null;
  0.1: number | null;
}

// Reroll band tolerances. `DEPLETION_BUCKET`: years a depleted alternative's `depletionYear` may differ from the card stat (hard ceiling 2, so rerolled lines visibly differ while the default pick stays card-exact).
// `SURVIVING_BAND_FRAC`: ±2.5 % of the tier's real ending balance. `REROLL_BAND_CAP`: seeds stored per tier, spread across the outcome range.
const DEPLETION_BUCKET = 2;
const SURVIVING_BAND_FRAC = 0.025;
const REROLL_BAND_CAP = 25;

// Depletion-aware tie-break: when the rank-`p` path is effectively depleted (ran out and ended below `EPS_REAL`) and the tier has a card target, picks the effectively-depleted path closest to it (ties: lowest pathIndex) so the basis line's run-out age matches its card.
function reconcileEffectivelyDepletedPick(
  rankIdx: number,
  endingReal: number[],
  depletionYearByPath: (number | null)[],
  cardTarget: number | null,
  eps: number,
): number {
  const rankDepletion = depletionYearByPath[rankIdx];
  if (rankDepletion === null || endingReal[rankIdx] >= eps || cardTarget === null) {
    return rankIdx;
  }
  let bestIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < depletionYearByPath.length; i += 1) {
    const dep = depletionYearByPath[i];
    if (dep === null || endingReal[i] >= eps) continue;
    const dist = Math.abs(dep - cardTarget);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx === -1 ? rankIdx : bestIdx;
}

// Ties break by pathIndex so a field of depleted $0 paths resolves to one reproducible seed; the rank is `floor(p * (n - 1) + 0.5)`, matching `percentile`.
function pathIndexAtRealEndingRank(endingReal: number[], p: number): number {
  const n = endingReal.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => endingReal[a] - endingReal[b] || a - b);
  const rank = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1) + 0.5)));
  return order[rank];
}

/**
 * Replays one path's seed under full per-year capture plus the RMD / tax display post-passes. Shared by the engine and the main-thread
 * reroll, so the page swaps the basis line without a worker round-trip and the run is bit-identical for that seed. Returns `null` only when capture is absent.
 */
export function replayRepresentativePath(
  input: MonteCarloInput,
  seed: number,
  runCtx: RunContext = buildRunContext(input),
): RepresentativeRun | null {
  const captured = runOnePath(input, seed, runCtx, true).representative ?? null;
  if (!captured) return null;
  // RMD facts live only on `mcRmdContext`, so they are merged with `taxContext` (which wins for members, snapshot and death years); either/or would revert fact-based rules to the Uniform-Lifetime path.
  const rmdCtx = input.taxContext
    ? {
        members: input.taxContext.members,
        rmdSnapshot: input.taxContext.taxBundle.rmd,
        primaryDeathYear: input.taxContext.primaryDeathYear,
        secondaryDeathYear: input.taxContext.secondaryDeathYear,
        rmdFactsByAccountId: input.mcRmdContext?.rmdFactsByAccountId,
        retirementYearByOwner: input.mcRmdContext?.retirementYearByOwner,
      }
    : (input.mcRmdContext ?? null);
  if (rmdCtx) {
    applyMcRmdToRepresentativeYears({
      years: captured.years,
      ledger: input.accountMcLedger,
      members: rmdCtx.members,
      rmdSnapshot: rmdCtx.rmdSnapshot,
      // Skip strictly-post-depletion rows (stale `preEnd` gives a phantom floor).
      depletionYear: captured.depletionYear,
      ...(rmdCtx.primaryDeathYear !== undefined
        ? { primaryDeathYear: rmdCtx.primaryDeathYear }
        : {}),
      ...(rmdCtx.secondaryDeathYear !== undefined
        ? { secondaryDeathYear: rmdCtx.secondaryDeathYear }
        : {}),
      ...(rmdCtx.rmdFactsByAccountId !== undefined
        ? { rmdFactsByAccountId: rmdCtx.rmdFactsByAccountId }
        : {}),
      ...(rmdCtx.retirementYearByOwner !== undefined
        ? { retirementYearByOwner: rmdCtx.retirementYearByOwner }
        : {}),
    });
  }
  if (input.taxContext) {
    applyMcTaxToRepresentativeYears({
      years: captured.years,
      ledger: input.accountMcLedger,
      taxCtx: input.taxContext,
      firstYear: input.firstYear,
      retirementYear: input.retirementYear,
      ssByYear: input.ssByYear,
      incomeByYear: input.incomeByYear,
      depletionYear: captured.depletionYear,
      ...(captured.accumulationAccountBalances !== undefined
        ? { accumulationAccountBalances: captured.accumulationAccountBalances }
        : {}),
      // Inherited accounts whose §72(t) leg the death exception waives, so the displayed penalty matches the funded per-path penalty.
      ...(input.mcRmdContext?.rmdFactsByAccountId !== undefined
        ? {
            deathExemptAccountIds: Object.entries(input.mcRmdContext.rmdFactsByAccountId)
              .filter(([, facts]) => facts.inheritedAccount === true)
              .map(([id]) => id),
          }
        : {}),
    });
  }
  return { ...captured, seed };
}

function assembleRepresentativeByBasis(
  input: MonteCarloInput,
  runCtx: RunContext,
  endingReal: number[],
  depletionYearByPath: (number | null)[],
  cardTargets: CardTargets,
): {
  representativeByBasis: Record<McBasis, RepresentativeRun | null>;
  representativeTypicalSeed: number;
  representativePessimisticSeed: number;
  representativeBadLuckSeed: number;
} {
  const buildTier = (
    p: number,
    cardTarget: number | null,
  ): { run: RepresentativeRun | null; seed: number } => {
    const rankIdx = pathIndexAtRealEndingRank(endingReal, p);
    const pathIndex = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      cardTarget,
      EPS_REAL,
    );
    const seed = seedForPathIndex(input.seed, pathIndex);
    return { run: replayRepresentativePath(input, seed, runCtx), seed };
  };
  const typical = buildTier(0.5, cardTargets[0.5]);
  const pessimistic = buildTier(0.25, cardTargets[0.25]);
  const badLuck = buildTier(0.1, cardTargets[0.1]);
  return {
    representativeByBasis: {
      'mc-typical': typical.run,
      'mc-pessimistic': pessimistic.run,
      'mc-bad-luck': badLuck.run,
    },
    representativeTypicalSeed: typical.seed,
    representativePessimisticSeed: pessimistic.seed,
    representativeBadLuckSeed: badLuck.seed,
  };
}

function evenSpread(indices: number[], cap: number): number[] {
  if (indices.length <= cap) return indices;
  const out: number[] = [];
  for (let k = 0; k < cap; k += 1) {
    const rank = Math.round((k * (indices.length - 1)) / (cap - 1));
    out.push(indices[rank]);
  }
  return out;
}

// Per-tier card-consistent band of candidate seeds for the reroll control: candidates lie within tolerance of the tier outcome (depleted: `|depletionYear - cardTarget| <= DEPLETION_BUCKET`; surviving: within `SURVIVING_BAND_FRAC` of the percentile value); the default pick is element 0 and the rest are capped and spread evenly.
function assembleRepresentativeBands(
  baseSeed: number,
  endingReal: number[],
  depletionYearByPath: (number | null)[],
  cardTargets: CardTargets,
  eps: number,
): Record<McBasis, number[]> {
  const buildBandSeeds = (p: number, cardTarget: number | null): number[] => {
    const rankIdx = pathIndexAtRealEndingRank(endingReal, p);
    const defaultIdx = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      cardTarget,
      eps,
    );
    const rankDepletion = depletionYearByPath[rankIdx];
    const depletedTier =
      rankDepletion !== null && endingReal[rankIdx] < eps && cardTarget !== null;

    type Candidate = { idx: number; val: number };
    const candidates: Candidate[] = [];
    if (depletedTier) {
      const target = cardTarget as number;
      for (let i = 0; i < depletionYearByPath.length; i += 1) {
        const dep = depletionYearByPath[i];
        if (dep === null || endingReal[i] >= eps) continue;
        if (Math.abs(dep - target) <= DEPLETION_BUCKET) candidates.push({ idx: i, val: dep });
      }
    } else {
      const pct = endingReal[rankIdx];
      const width = SURVIVING_BAND_FRAC * Math.abs(pct);
      for (let i = 0; i < endingReal.length; i += 1) {
        if (Math.abs(endingReal[i] - pct) <= width) candidates.push({ idx: i, val: endingReal[i] });
      }
    }
    // Alternatives are sorted by outcome value (then pathIndex) and spread evenly across the outcome range, not clustered on the card value.
    const alts = candidates.filter((c) => c.idx !== defaultIdx);
    alts.sort((a, b) => a.val - b.val || a.idx - b.idx);
    const altIdx = evenSpread(
      alts.map((c) => c.idx),
      REROLL_BAND_CAP - 1,
    );
    return [defaultIdx, ...altIdx].map((idx) => seedForPathIndex(baseSeed, idx));
  };
  return {
    'mc-typical': buildBandSeeds(0.5, cardTargets[0.5]),
    'mc-pessimistic': buildBandSeeds(0.25, cardTargets[0.25]),
    'mc-bad-luck': buildBandSeeds(0.1, cardTargets[0.1]),
  };
}

/**
 * Deterministic reroll index in `[1, bandLen - 1]`, never 0 (the default pick). The alternatives are a hash-ordered permutation indexed by `nonce`,
 * so consecutive rerolls visit every alternative once before repeating. Callers must guard `bandLen >= 2`.
 */
export function pickBandIndex(
  bandLen: number,
  baseSeed: number,
  basis: McBasis,
  nonce: number,
): number {
  const altCount = bandLen - 1;
  if (altCount <= 0) return 0; // no alternative — caller guards this off
  const basisSalt =
    basis === 'mc-typical' ? 0x1 : basis === 'mc-pessimistic' ? 0x2 : 0x3;
  const salt = seedForPathIndex(baseSeed, basisSalt);
  const order = Array.from({ length: altCount }, (_v, i) => i + 1);
  order.sort((a, b) => seedForPathIndex(salt, a) - seedForPathIndex(salt, b) || a - b);
  return order[(((nonce - 1) % altCount) + altCount) % altCount];
}

/** Post-loop summary assembly from the loop's accumulators: percentile fans, depletion and ending stats, histograms and the optional tax percentile series. Pure aggregation, no path math. */
export function assembleMonteCarloSummary(
  input: MonteCarloInput,
  runCtx: RunContext,
  acc: PathLoopAccumulation,
): MonteCarloSummary {
  const pathCount = input.pathCount;
  const horizon = input.horizonYear - input.firstYear + 1;
  const percentilesNominal = percentileSeries(acc.balancesByYearNominal);
  const percentilesReal = percentileSeries(acc.balancesByYearReal);

  const sortedEndingNominal = Float64Array.from(acc.endingNominal).sort();
  const sortedEndingReal = Float64Array.from(acc.endingReal).sort();
  const sortedDepletion = acc.depletionYears.slice().sort((a, b) => a - b);

  const successProbability = acc.successes / pathCount;
  const medianDepletionYear = depletionYearPercentile(sortedDepletion, pathCount, 0.5);
  const p10DepletionYear = depletionYearPercentile(sortedDepletion, pathCount, 0.1);
  const p25DepletionYear = depletionYearPercentile(sortedDepletion, pathCount, 0.25);

  return {
    engineVersion: ENGINE_VERSION,
    seed: input.seed,
    pathCount,
    computedAt: Date.now(),
    firstYear: input.firstYear,
    horizonYears: horizon,
    percentilesNominal,
    percentilesReal,
    successProbability,
    medianDepletionYear,
    p10DepletionYear,
    p25DepletionYear,
    medianEndingBalanceNominal: percentile(sortedEndingNominal, 0.5),
    medianEndingBalanceReal: percentile(sortedEndingReal, 0.5),
    p10EndingBalanceNominal: percentile(sortedEndingNominal, 0.1),
    p10EndingBalanceReal: percentile(sortedEndingReal, 0.1),
    p25EndingBalanceNominal: percentile(sortedEndingNominal, 0.25),
    p25EndingBalanceReal: percentile(sortedEndingReal, 0.25),
    failureYearHistogram: acc.failureYearHistogram,
    endingBalanceHistogramNominal: endingBalanceHistogram(acc.endingNominal),
    endingBalanceHistogramReal: endingBalanceHistogram(acc.endingReal),
    // `successOnly` (the optimizer fast path) skips the overlay, representative runs and bands below, the dominant per-pair cost; `successProbability` stays bit-identical.
    plannedOverlay: input.successOnly ? [] : runPlannedOverlay(input, runCtx),
    ...(input.successOnly
      ? {}
      : assembleRepresentativeByBasis(input, runCtx, acc.endingReal, acc.depletionYearByPath, {
          // The card depletion stats are the consts computed above; `MonteCarloSummary` fields don't exist yet at call time.
          0.5: medianDepletionYear,
          0.25: p25DepletionYear,
          0.1: p10DepletionYear,
        })),
    ...(input.successOnly
      ? {}
      : {
          representativeBandsByBasis: assembleRepresentativeBands(
            input.seed,
            acc.endingReal,
            acc.depletionYearByPath,
            { 0.5: medianDepletionYear, 0.25: p25DepletionYear, 0.1: p10DepletionYear },
            EPS_REAL,
          ),
        }),
    ...(acc.taxAcc
      ? {
          federalTaxPercentilesByYear: percentileSeries(acc.taxAcc.fedTaxByYear),
          irmaaSurchargePercentilesByYear: percentileSeries(acc.taxAcc.irmaaSurchargeByYear),
          acaPtcSubsidyPercentilesByYear: percentileSeries(acc.taxAcc.acaPtcSubsidyByYear),
          acaCreditAppliedToPremiumsPercentilesByYear: percentileSeries(
            acc.taxAcc.acaCreditAppliedToPremiumsByYear,
          ),
          effectiveTaxRatePercentilesByYear: percentileSeries(acc.taxAcc.effectiveTaxRateByYear),
          netAfterTaxPercentilesByYear: percentileSeries(acc.taxAcc.netAfterTaxByYear),
        }
      : {}),
  };
}
