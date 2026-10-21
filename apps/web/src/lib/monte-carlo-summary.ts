/**
 * Monte Carlo post-loop reducer + representative-run selection — split out of
 * `monte-carlo.ts` to keep the loop file smaller. Percentile /
 * histogram helpers, the depletion-aware representative-pick tie-break, the
 * reroll-band assembly, and the final `assembleMonteCarloSummary` reducer all
 * live here; `monte-carlo.ts` imports `assembleMonteCarloSummary` back for
 * `runMonteCarlo`, forming an inert 2-node import cycle (see
 * `.dependency-cruiser.cjs`) matching the existing `monte-carlo.ts` <->
 * `monte-carlo-shard.ts` cycle.
 *
 * `seedForPathIndex` deliberately STAYS in `monte-carlo.ts` (imported back
 * here) — `monte-carlo-shard.ts` already imports it directly from
 * `monte-carlo.ts` for the hot loop, and duplicating it here would risk the
 * hot-loop seed silently diverging from the representative-replay seed.
 *
 * The stress test is explained in docs/math-projections.md ("The Monte Carlo
 * stress test").
 */
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

/* ---------- internal: percentile + histogram helpers ---------- */

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
    // Typed-array numeric sort (no comparator) is bit-identical to
    // `(a,b)=>a-b` for the finite values here, and avoids the per-comparison
    // JS callback. `percentile` reads `[idx]` — works the same on a
    // Float64Array, still yielding a plain `number`.
    const sorted = Float64Array.from(byYear[y]).sort();
    p10[y] = percentile(sorted, 0.1);
    p25[y] = percentile(sorted, 0.25);
    p50[y] = percentile(sorted, 0.5);
  }
  return { p10, p25, p50 };
}

/**
 * Lower bounds for the ending-balance histogram's 31 bins
 * (`MonteCarloSummary.endingBalanceHistogramNominal` /
 * `endingBalanceHistogramReal`: log-scale
 * lower bounds with $0 isolated). Hand-rounded quasi-log
 * ladder (~1.3–2x steps) rather than exact powers so chart axis labels read
 * as clean dollar figures; $0 gets its own bin so fully-depleted paths are
 * distinguishable from merely-small endings. UX-facing display bucketing
 * only — no engine math reads these.
 */
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

/** Depletion year by which `p` of ALL paths (not just failed ones) have
 *  depleted — null when fewer than `p * pathCount` paths fail (the
 *  p-th-percentile path doesn't deplete). For p = 0.5 this is the median
 *  depletion year, defined only when > 50 % of paths fail. */
function depletionYearPercentile(
  sortedDepletion: number[],
  pathCount: number,
  p: number,
): number | null {
  const idx = Math.floor(p * pathCount);
  return sortedDepletion.length > idx ? sortedDepletion[idx] : null;
}

/** De-minimis real-dollar threshold treating a genuinely depleted path's
 *  ending balance as zero. A multi-account depleted path never ends at exact 0:
 *  the kernel's documented "accept-loss" floating-point residual leaves a tiny
 *  positive amount (see the clamp in `kernel.ts`), so the effectively-depleted
 *  gate uses `endingReal < EPS_REAL` (one real dollar), NOT `=== 0`. */
export const EPS_REAL = 1;

/** The three tiers' card depletion-year stats, keyed by the tier's
 *  ending-balance percentile rank (P50 Typical / P25 Pessimistic / P10
 *  Bad-luck). Each is `null` when fewer than that share of paths deplete. */
interface CardTargets {
  0.5: number | null;
  0.25: number | null;
  0.1: number | null;
}

/** Reroll band: the per-tier card-consistency window + cap that
 *  bound which alternative paths the "show another likely path" control may
 *  draw. A band member must satisfy the SAME invariant the default pick does
 *  (see `reconcileEffectivelyDepletedPick`), so a reroll never strays beyond the card's
 *  tolerance.
 *
 *  - `DEPLETION_BUCKET` (year): an effectively-depleted ALTERNATIVE's `depletionYear`
 *    must be within this many years of the tier's card depletion stat. Set to the
 *    hard ceiling 2 so the band spans a wider run-out range (±2 yr ≈ up to 5
 *    distinct run-out ages) and rerolled lines are visibly different — while the
 *    DEFAULT pick (band element 0) stays card-EXACT, so consistency is
 *    unchanged.
 *  - `SURVIVING_BAND_FRAC`: a surviving member's real ending balance must be
 *    within this fraction (±2.5 %) of the tier's percentile real ending balance.
 *  - `REROLL_BAND_CAP`: at most this many seeds are stored per tier; the
 *    alternatives are spread evenly across the OUTCOME range (distinct run-out
 *    years / ending balances), not clustered on the card value, so consecutive
 *    rerolls land on perceptibly different lines. */
export const DEPLETION_BUCKET = 2;
const SURVIVING_BAND_FRAC = 0.025;
export const REROLL_BAND_CAP = 25;

/** Depletion-aware tie-break for the representative pick. When
 *  the rank-`p` path is EFFECTIVELY DEPLETED (ran out AND ended below `EPS_REAL`)
 *  and the tier has a non-null card target, re-pick the effectively-depleted
 *  path whose `depletionYear` is closest to that card stat (secondary tie-break:
 *  lowest pathIndex) — so the basis line's run-out age matches its card.
 *  Otherwise (rank-`p` path survived / bounced back to a material balance, the
 *  card target is null, or the candidate set is empty) return `rankIdx`
 *  unchanged — surviving/material picks are never reordered. */
export function reconcileEffectivelyDepletedPick(
  rankIdx: number,
  endingReal: number[],
  depletionYearByPath: (number | null)[],
  cardTarget: number | null,
  eps: number,
): number {
  // Gate: the rank-p path must itself be effectively depleted, and the tier
  // must carry a card depletion year to reconcile toward.
  const rankDepletion = depletionYearByPath[rankIdx];
  if (rankDepletion === null || endingReal[rankIdx] >= eps || cardTarget === null) {
    return rankIdx;
  }
  let bestIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < depletionYearByPath.length; i += 1) {
    const dep = depletionYearByPath[i];
    // Candidate set: effectively-depleted paths only (ran out AND ended < eps).
    if (dep === null || endingReal[i] >= eps) continue;
    const dist = Math.abs(dep - cardTarget);
    // Closest to the card target; secondary tie-break = lowest pathIndex (the
    // ascending loop keeps the first-seen winner on a distance tie).
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  // Empty candidate set → unchanged pick.
  return bestIdx === -1 ? rankIdx : bestIdx;
}

/** Pick the pathIndex at percentile `p` of the `(realEndingBalance,
 *  pathIndex)` ranking. Sort ascending by ending balance, tie-break by
 *  pathIndex — so a field of depleted $0 paths resolves to a single
 *  reproducible seed rather than an arbitrary one. Returns the original path
 *  index whose rank equals `floor(p * (n − 1) + 0.5)` (matching `percentile`). */
function pathIndexAtRealEndingRank(endingReal: number[], p: number): number {
  const n = endingReal.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => endingReal[a] - endingReal[b] || a - b);
  const rank = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1) + 0.5)));
  return order[rank];
}

/** Replay ONE path's seed under full per-year capture + the RMD /
 *  tax DISPLAY-only post-passes, returning the `RepresentativeRun` stamped
 *  with `seed`. Shared by the engine's representative assembly
 *  (`assembleRepresentativeByBasis`) AND the main-thread reroll replay:
 *  the page calls this with a band seed to swap the basis line without a worker
 *  round-trip, so the replayed run is bit-identical to the engine's capture for
 *  that seed. `runCtx` is reused when supplied (the engine has it on the hot
 *  loop); a reroll caller passes only `(input, seed)` and the context is built
 *  fresh — identical, since `buildRunContext` is a pure function of `input`.
 *  Returns `null` only when the capture itself is absent. */
export function replayRepresentativePath(
  input: MonteCarloInput,
  seed: number,
  runCtx: RunContext = buildRunContext(input),
): RepresentativeRun | null {
  const captured = runOnePath(input, seed, runCtx, true).representative ?? null;
  if (!captured) return null;
  // The RMD facts live ONLY on `mcRmdContext`, so they must be MERGED with
  // the named-strategy `taxContext` rather than dropped when it is present (an
  // either/or choice would silently revert every fact-based rule to the legacy
  // Uniform-Lifetime path for exactly the runs users see). `taxContext` still wins
  // for members / snapshot / death years (it is the authoritative tax household).
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
    // RMD post-pass: populate `rmdFloorCents` / `rmdShortfallCents` on the
    // captured drawdown-phase rows from the per-account tax-deferred balances.
    // Runs for named strategies (taxContext present) and for injected-return /
    // unit-test runs (mcRmdContext fallback). Mutates the captured rows in
    // place; no-ops with no RMD-eligible accounts.
    applyMcRmdToRepresentativeYears({
      years: captured.years,
      ledger: input.accountMcLedger,
      members: rmdCtx.members,
      rmdSnapshot: rmdCtx.rmdSnapshot,
      // Skip strictly-post-depletion rows (stale `preEnd` → phantom floor).
      depletionYear: captured.depletionYear,
      ...(rmdCtx.primaryDeathYear !== undefined
        ? { primaryDeathYear: rmdCtx.primaryDeathYear }
        : {}),
      ...(rmdCtx.secondaryDeathYear !== undefined
        ? { secondaryDeathYear: rmdCtx.secondaryDeathYear }
        : {}),
      // The fact-based RMD state (per-account beneficiary / employment /
      // deferral facts + per-owner separation years). Routed into the SHARED
      // `computeRmd` engine, so the displayed MC floor selects the same
      // Table I/II/III, honours the same still-working exception, and WITHHOLDS on
      // the same incomplete inherited facts as the deterministic engine.
      ...(rmdCtx.rmdFactsByAccountId !== undefined
        ? { rmdFactsByAccountId: rmdCtx.rmdFactsByAccountId }
        : {}),
      ...(rmdCtx.retirementYearByOwner !== undefined
        ? { retirementYearByOwner: rmdCtx.retirementYearByOwner }
        : {}),
    });
  }
  // Tax post-pass: stamp federalTax / IRMAA / ACA-PTC cents on the captured
  // drawdown-phase rows when a tax context is present (no `mcRmdContext`
  // fallback). Display-only; reuses the per-owner `rmdFloorCents` the RMD
  // post-pass just stamped. Injected-return / unit-test runs without a
  // tax context skip it.
  if (input.taxContext) {
    applyMcTaxToRepresentativeYears({
      years: captured.years,
      ledger: input.accountMcLedger,
      taxCtx: input.taxContext,
      firstYear: input.firstYear,
      retirementYear: input.retirementYear,
      ssByYear: input.ssByYear,
      incomeByYear: input.incomeByYear,
      // Tax the depletion year (real activity), skip only later years.
      depletionYear: captured.depletionYear,
      // Drawdown-entry buckets for the display replay.
      ...(captured.accumulationAccountBalances !== undefined
        ? { accumulationAccountBalances: captured.accumulationAccountBalances }
        : {}),
      // The inherited accounts whose §72(t) leg the death exception waives,
      // so the DISPLAYED penalty matches the funded per-path penalty.
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

/** Assemble the three representative runs (Typical = P50, Pessimistic =
 *  P25, Bad-luck = P10 by real ending balance). For each tier, find the path
 *  at that rank, recompute its seed, and replay it under full per-year capture
 *  — covering BOTH the kernel and the strategy-engine paths via
 *  `runOnePath`. Returns the records + the three replay seeds. */
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
    // Rank by real ending balance, then reconcile the pick to the tier's
    // card depletion stat when the rank-p path is effectively depleted.
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

/** Even-spread down-sample of `indices` (already ordered) to at most `cap`
 *  elements, ALWAYS keeping `indices[0]` first. Picks `cap` evenly-rank-spaced
 *  members so the kept seeds are perceptibly distinct (not the closest-clustered
 *  duplicates). Returns the input unchanged when it already fits. */
function evenSpread(indices: number[], cap: number): number[] {
  if (indices.length <= cap) return indices;
  const out: number[] = [];
  for (let k = 0; k < cap; k += 1) {
    // Map slot k → a rank evenly spread across [0, len−1], inclusive of both
    // ends; slot 0 always lands on index 0 (the default pick stays first).
    const rank = Math.round((k * (indices.length - 1)) / (cap - 1));
    out.push(indices[rank]);
  }
  return out;
}

/** Per-tier card-consistent band of candidate path SEEDS for the reroll
 *  control. For each tier, the candidate set is the paths WITHIN the
 *  tolerance of the tier's outcome — depleted tier (the rank-`p` path is
 *  effectively depleted): `|depletionYear − cardTarget| ≤ DEPLETION_BUCKET`;
 *  surviving tier: `|endingReal − percentileValue| ≤ SURVIVING_BAND_FRAC ×
 *  |percentileValue|`. The set is ordered (depleted: by `|depletionYear −
 *  cardTarget|` then pathIndex; surviving: by `|endingReal − percentileValue|`
 *  then pathIndex), the reconciled DEFAULT pick is forced to the FRONT
 *  (band element 0 = the default pick), the rest are capped + even-spread to
 *  `REROLL_BAND_CAP`, and every index maps to its seed via
 *  `seedForPathIndex`. Reuses the `endingReal` + `depletionYearByPath`
 *  accumulators — no extra path math. */
export function assembleRepresentativeBands(
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
    // Same activation gate as the Part-1 tie-break: the rank-`p` path is
    // effectively depleted AND the tier carries a card depletion year.
    const rankDepletion = depletionYearByPath[rankIdx];
    const depletedTier =
      rankDepletion !== null && endingReal[rankIdx] < eps && cardTarget !== null;

    type Candidate = { idx: number; val: number };
    const candidates: Candidate[] = [];
    if (depletedTier) {
      // cardTarget is non-null here (gate). Effectively-depleted paths within
      // DEPLETION_BUCKET years of the card stat; `val` = the run-out year.
      const target = cardTarget as number;
      for (let i = 0; i < depletionYearByPath.length; i += 1) {
        const dep = depletionYearByPath[i];
        if (dep === null || endingReal[i] >= eps) continue;
        if (Math.abs(dep - target) <= DEPLETION_BUCKET) candidates.push({ idx: i, val: dep });
      }
    } else {
      // Surviving / material tier: paths within SURVIVING_BAND_FRAC of the
      // tier's percentile real ending balance; `val` = the ending balance.
      const pct = endingReal[rankIdx];
      const width = SURVIVING_BAND_FRAC * Math.abs(pct);
      for (let i = 0; i < endingReal.length; i += 1) {
        if (Math.abs(endingReal[i] - pct) <= width) candidates.push({ idx: i, val: endingReal[i] });
      }
    }
    // Band element 0 = the reconciled DEFAULT pick — always card-
    // exact. The ALTERNATIVES are spread evenly across the OUTCOME range (run-out
    // year for depleted tiers / ending balance for surviving tiers), NOT clustered
    // on the card value, so consecutive rerolls land on visibly different lines.
    // Sort by outcome value (then pathIndex, deterministic) before the spread.
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

/** Deterministic reroll index into a tier's band. Returns an index in
 *  `[1, bandLen − 1]` — the ALTERNATIVES only, NEVER 0 (the default pick) — so
 *  every reroll yields a path different from the default. A TRUE permutation of
 *  the `bandLen − 1` alternatives (ordered by a per-(seed,basis,index) hash),
 *  indexed by `nonce` — so consecutive rerolls visit EVERY alternative exactly
 *  once before any repeats, never the same line twice in a row. Reproducible (no
 *  `Math.random`). `nonce` advances per reroll (production starts at 1, but
 *  any integer is handled). Callers MUST guard `bandLen ≥ 2` (a 1-member band has
 *  no alternative). */
export function pickBandIndex(
  bandLen: number,
  baseSeed: number,
  basis: McBasis,
  nonce: number,
): number {
  const altCount = bandLen - 1;
  if (altCount <= 0) return 0; // no alternative — caller guards this off
  // Per-tier salt so the three tiers walk distinct orders from the same nonce.
  const basisSalt =
    basis === 'mc-typical' ? 0x1 : basis === 'mc-pessimistic' ? 0x2 : 0x3;
  // Build a deterministic permutation of the alternatives [1, bandLen−1] by
  // ordering them on a per-(seed,basis,index) hash, then index it by `nonce`.
  // Every alternative is therefore visited exactly once before any repeat.
  const salt = seedForPathIndex(baseSeed, basisSalt);
  const order = Array.from({ length: altCount }, (_v, i) => i + 1);
  order.sort((a, b) => seedForPathIndex(salt, a) - seedForPathIndex(salt, b) || a - b);
  // Non-negative modulo so any `nonce` (incl. 0) maps into range.
  return order[(((nonce - 1) % altCount) + altCount) % altCount];
}

/** Post-loop summary assembly: percentile fans, depletion/ending stats,
 *  histograms, the seed-1 planned overlay (computed and stored on the summary,
 *  but no screen displays it), and the optional tax percentile series. Pure
 *  aggregation of the loop's accumulators — no path math. */
export function assembleMonteCarloSummary(
  input: MonteCarloInput,
  runCtx: RunContext,
  acc: PathLoopAccumulation,
): MonteCarloSummary {
  const pathCount = input.pathCount;
  const horizon = input.horizonYear - input.firstYear + 1;
  const percentilesNominal = percentileSeries(acc.balancesByYearNominal);
  const percentilesReal = percentileSeries(acc.balancesByYearReal);

  // Typed-array numeric sort (no comparator) — bit-identical to `(a,b)=>a-b`
  // for the finite ending balances, without the per-comparison JS callback.
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
    // The seed-1 overlay path is computed and stored, but nothing outside
    // tests reads it. Success-only mode skips it (it is the dominant per-pair
    // cost) and returns an empty overlay. Every other field is computed
    // normally, so `successProbability` is bit-identical to a full run. The
    // optimizer reads only `successProbability`.
    plannedOverlay: input.successOnly ? [] : runPlannedOverlay(input, runCtx),
    // Representative runs (P10/P25/P50 by real ending balance, replayed
    // under full capture). Skipped in successOnly mode (the optimizer fast
    // path) exactly like the planned overlay — the replay is the dominant
    // per-tier cost and the optimizer reads only `successProbability`.
    ...(input.successOnly
      ? {}
      : assembleRepresentativeByBasis(input, runCtx, acc.endingReal, acc.depletionYearByPath, {
          // The per-tier card depletion stats the representative pick
          // reconciles toward — the SAME consts the summary already
          // computed above, NOT MonteCarloSummary fields (absent at call time).
          0.5: medianDepletionYear,
          0.25: p25DepletionYear,
          0.1: p10DepletionYear,
        })),
    // Per-tier card-consistent band of candidate path seeds backing the
    // reroll control. Reuses the same accumulators + card targets the
    // representative pick uses; element 0 of each band == the default pick.
    // Skipped in successOnly mode like the representative runs (optimizer reads
    // only successProbability).
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
