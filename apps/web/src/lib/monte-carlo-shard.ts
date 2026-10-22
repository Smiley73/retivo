/**
 * Monte Carlo path-range sharding primitives.
 *
 * A single `runMonteCarlo` run is split into contiguous path ranges. Each
 * range is simulated by `runPathRange` (the extracted per-path loop, calling
 * the single-path primitive `runOnePath`), producing a transferable
 * typed-array `PathRangeResult`. The main-thread coordinator merges the
 * ranges by ABSOLUTE path index into a full-size `MergedAccumulationTransfer`
 * (`mergePathRanges`, Stage 1 — cheap `TypedArray.set` copies, transferable),
 * then `assembleAccumulationFromTyped` (Stage 2) reconstructs the plain-array
 * `PathLoopAccumulation` that `assembleMonteCarloSummary` consumes. Serial and
 * sharded runs drive the SAME two-stage pipeline, so a sharded run is
 * bit-for-bit identical to a serial one (per-path seeds are index-derived).
 *
 * Runtime dependency direction: this module depends on `monte-carlo.ts`
 * (`runOnePath`, `buildRunContext` are not re-implemented here) and
 * `monte-carlo-tax.ts` (`createTaxAccumulators` for the reconstructed
 * tax-matrix shape). `PathLoopAccumulation` is imported TYPE-ONLY (erased at
 * compile time).
 */
import { runOnePath, seedForPathIndex } from './monte-carlo.js';
import type { PathLoopAccumulation, RunContext } from './monte-carlo.js';
import type { MonteCarloInput } from './monte-carlo-types.js';
import { createTaxAccumulators, type McTaxAccumulators } from './monte-carlo-tax.js';

/** The six per-year tax matrices carried through a shard / merge, matching
 *  `McTaxAccumulators`' field set. `null` when the run has no `taxContext`. */
interface TaxMatrices {
  fedTaxByYear: Float64Array[];
  irmaaSurchargeByYear: Float64Array[];
  acaPtcSubsidyByYear: Float64Array[];
  acaCreditAppliedToPremiumsByYear: Float64Array[];
  effectiveTaxRateByYear: Float64Array[];
  netAfterTaxByYear: Float64Array[];
}

/** One shard's accumulated path results, sized `pathEnd − pathStart`. Every
 *  field is a `Float64Array` / `Int32Array` so its `.buffer` can populate a
 *  `postMessage` transfer list. `depletionYearByPath` uses −1 as the
 *  "never depleted" sentinel (the plain-array reconstruction maps it back to
 *  `null`). */
export interface PathRangeResult {
  readonly pathStart: number;
  readonly pathEnd: number;
  readonly balancesByYearNominal: Float64Array[];
  readonly balancesByYearReal: Float64Array[];
  readonly tax: TaxMatrices | null;
  readonly endingNominal: Float64Array;
  readonly endingReal: Float64Array;
  readonly depletionYearByPath: Int32Array;
  readonly failureYearHistogram: Int32Array;
  readonly successes: number;
}

/** The full-run typed merge produced by `mergePathRanges` (Stage 1). Same
 *  field shapes as `PathRangeResult` but sized `pathCount`; carries no
 *  `pathStart`/`pathEnd`. Transferable — see `collectAccumulationTransferables`. */
export interface MergedAccumulationTransfer {
  readonly balancesByYearNominal: Float64Array[];
  readonly balancesByYearReal: Float64Array[];
  readonly tax: TaxMatrices | null;
  readonly endingNominal: Float64Array;
  readonly endingReal: Float64Array;
  readonly depletionYearByPath: Int32Array;
  readonly failureYearHistogram: Int32Array;
  readonly successes: number;
}

function makeMatrix(horizon: number, cols: number): Float64Array[] {
  const rows: Float64Array[] = new Array(horizon);
  for (let y = 0; y < horizon; y += 1) rows[y] = new Float64Array(cols);
  return rows;
}

function makeTaxMatrices(horizon: number, cols: number): TaxMatrices {
  return {
    fedTaxByYear: makeMatrix(horizon, cols),
    irmaaSurchargeByYear: makeMatrix(horizon, cols),
    acaPtcSubsidyByYear: makeMatrix(horizon, cols),
    acaCreditAppliedToPremiumsByYear: makeMatrix(horizon, cols),
    effectiveTaxRateByYear: makeMatrix(horizon, cols),
    netAfterTaxByYear: makeMatrix(horizon, cols),
  };
}

/**
 * Simulate the paths `[pathStart, pathEnd)` and accumulate them into a
 * transferable `PathRangeResult`. Per-path seeds use the ABSOLUTE path index
 * `p` (`(input.seed + p * 0x9e3779b1) >>> 0`), identical to the serial loop,
 * so range boundaries never shift a path's sample.
 *
 * `onProgress` (when supplied) is called range-relative: `(doneInRange,
 * rangeLen)`, on the same cadence the serial loop used (`progressEvery =
 * max(25, floor(rangeLen / 40))`, plus the final path). For a single
 * `[0, pathCount)` range this is byte-identical to the old
 * `input.onProgress?.(p + 1, pathCount)` — same call count, same arguments.
 */
export function runPathRange(
  input: MonteCarloInput,
  runCtx: RunContext,
  pathStart: number,
  pathEnd: number,
  onProgress?: (done: number, total: number) => void,
): PathRangeResult {
  const horizon = input.horizonYear - input.firstYear + 1;
  const rangeLen = pathEnd - pathStart;
  const hasTaxCtx = input.taxContext !== undefined;

  const balancesByYearNominal = makeMatrix(horizon, rangeLen);
  const balancesByYearReal = makeMatrix(horizon, rangeLen);
  const tax: TaxMatrices | null = hasTaxCtx ? makeTaxMatrices(horizon, rangeLen) : null;
  const endingNominal = new Float64Array(rangeLen);
  const endingReal = new Float64Array(rangeLen);
  const depletionYearByPath = new Int32Array(rangeLen);
  const failureYearHistogram = new Int32Array(horizon);

  const progressEvery = Math.max(25, Math.floor(rangeLen / 40));
  let successes = 0;

  for (let li = 0; li < rangeLen; li += 1) {
    const p = pathStart + li;
    const pathSeed = seedForPathIndex(input.seed, p);
    const outcome = runOnePath(input, pathSeed, runCtx);
    for (let y = 0; y < horizon; y += 1) {
      balancesByYearNominal[y][li] = outcome.balanceByYearNominal[y];
      balancesByYearReal[y][li] = outcome.balanceByYearReal[y];
    }
    if (tax) {
      for (let y = 0; y < horizon; y += 1) {
        tax.fedTaxByYear[y][li] = outcome.federalTaxByYear?.[y] ?? 0;
        tax.irmaaSurchargeByYear[y][li] = outcome.irmaaSurchargeByYear?.[y] ?? 0;
        tax.acaPtcSubsidyByYear[y][li] = outcome.acaPtcSubsidyByYear?.[y] ?? 0;
        tax.acaCreditAppliedToPremiumsByYear[y][li] =
          outcome.acaCreditAppliedToPremiumsByYear?.[y] ?? 0;
        tax.effectiveTaxRateByYear[y][li] = outcome.effectiveTaxRateByYear?.[y] ?? 0;
        tax.netAfterTaxByYear[y][li] = outcome.netAfterTaxByYear?.[y] ?? 0;
      }
    }
    endingNominal[li] = outcome.endingBalanceNominal;
    endingReal[li] = outcome.endingBalanceReal;
    depletionYearByPath[li] = outcome.depletionYear === null ? -1 : outcome.depletionYear;
    if (outcome.depletionYear === null) {
      successes += 1;
    } else {
      const idx = outcome.depletionYear - input.firstYear;
      if (idx >= 0 && idx < horizon) failureYearHistogram[idx] += 1;
    }
    if ((li + 1) % progressEvery === 0 || li === rangeLen - 1) {
      onProgress?.(li + 1, rangeLen);
    }
  }

  return {
    pathStart,
    pathEnd,
    balancesByYearNominal,
    balancesByYearReal,
    tax,
    endingNominal,
    endingReal,
    depletionYearByPath,
    failureYearHistogram,
    successes,
  };
}

/**
 * Stage 1 — merge the shard ranges into full-size (`pathCount`) typed
 * arrays by ABSOLUTE path index (`TypedArray.set` at each range's `pathStart`).
 * Integer histograms and `successes` are summed. Output stays TYPED and
 * transferable; the plain-array reconstruction is Stage 2
 * (`assembleAccumulationFromTyped`).
 */
export function mergePathRanges(
  ranges: readonly PathRangeResult[],
  input: MonteCarloInput,
): MergedAccumulationTransfer {
  const horizon = input.horizonYear - input.firstYear + 1;
  const pathCount = input.pathCount;
  const hasTaxCtx = input.taxContext !== undefined;

  const balancesByYearNominal = makeMatrix(horizon, pathCount);
  const balancesByYearReal = makeMatrix(horizon, pathCount);
  const tax: TaxMatrices | null = hasTaxCtx ? makeTaxMatrices(horizon, pathCount) : null;
  const endingNominal = new Float64Array(pathCount);
  const endingReal = new Float64Array(pathCount);
  const depletionYearByPath = new Int32Array(pathCount);
  const failureYearHistogram = new Int32Array(horizon);
  let successes = 0;

  for (const r of ranges) {
    const off = r.pathStart;
    for (let y = 0; y < horizon; y += 1) {
      balancesByYearNominal[y].set(r.balancesByYearNominal[y], off);
      balancesByYearReal[y].set(r.balancesByYearReal[y], off);
    }
    if (tax && r.tax) {
      for (let y = 0; y < horizon; y += 1) {
        tax.fedTaxByYear[y].set(r.tax.fedTaxByYear[y], off);
        tax.irmaaSurchargeByYear[y].set(r.tax.irmaaSurchargeByYear[y], off);
        tax.acaPtcSubsidyByYear[y].set(r.tax.acaPtcSubsidyByYear[y], off);
        tax.acaCreditAppliedToPremiumsByYear[y].set(r.tax.acaCreditAppliedToPremiumsByYear[y], off);
        tax.effectiveTaxRateByYear[y].set(r.tax.effectiveTaxRateByYear[y], off);
        tax.netAfterTaxByYear[y].set(r.tax.netAfterTaxByYear[y], off);
      }
    }
    endingNominal.set(r.endingNominal, off);
    endingReal.set(r.endingReal, off);
    depletionYearByPath.set(r.depletionYearByPath, off);
    for (let y = 0; y < horizon; y += 1) failureYearHistogram[y] += r.failureYearHistogram[y];
    successes += r.successes;
  }

  return {
    balancesByYearNominal,
    balancesByYearReal,
    tax,
    endingNominal,
    endingReal,
    depletionYearByPath,
    failureYearHistogram,
    successes,
  };
}

/**
 * Stage 2 — reconstruct the plain-array `PathLoopAccumulation` that
 * `assembleMonteCarloSummary` consumes from the merged typed payload. Runs
 * ONCE per run (not per path). `depletionYears` is rebuilt by iterating
 * `depletionYearByPath` in ASCENDING path index and pushing non-sentinel
 * values, reproducing the serial loop's push order exactly; the −1 sentinel
 * maps back to `null` in `depletionYearByPath`. The five tax matrices are
 * rebuilt into `McTaxAccumulators`' shape via `createTaxAccumulators`.
 */
export function assembleAccumulationFromTyped(
  merged: MergedAccumulationTransfer,
  input: MonteCarloInput,
): PathLoopAccumulation {
  const horizon = input.horizonYear - input.firstYear + 1;
  const pathCount = input.pathCount;

  const balancesByYearNominal: number[][] = new Array(horizon);
  const balancesByYearReal: number[][] = new Array(horizon);
  for (let y = 0; y < horizon; y += 1) {
    balancesByYearNominal[y] = Array.from(merged.balancesByYearNominal[y]);
    balancesByYearReal[y] = Array.from(merged.balancesByYearReal[y]);
  }

  let taxAcc: McTaxAccumulators | null = null;
  if (merged.tax) {
    const built = createTaxAccumulators(horizon, pathCount, true);
    if (built) {
      for (let y = 0; y < horizon; y += 1) {
        built.fedTaxByYear[y] = Array.from(merged.tax.fedTaxByYear[y]);
        built.irmaaSurchargeByYear[y] = Array.from(merged.tax.irmaaSurchargeByYear[y]);
        built.acaPtcSubsidyByYear[y] = Array.from(merged.tax.acaPtcSubsidyByYear[y]);
        built.acaCreditAppliedToPremiumsByYear[y] = Array.from(
          merged.tax.acaCreditAppliedToPremiumsByYear[y],
        );
        built.effectiveTaxRateByYear[y] = Array.from(merged.tax.effectiveTaxRateByYear[y]);
        built.netAfterTaxByYear[y] = Array.from(merged.tax.netAfterTaxByYear[y]);
      }
    }
    taxAcc = built;
  }

  const endingNominal = Array.from(merged.endingNominal);
  const endingReal = Array.from(merged.endingReal);

  const depletionYears: number[] = [];
  const depletionYearByPath: (number | null)[] = new Array(pathCount);
  for (let p = 0; p < pathCount; p += 1) {
    const v = merged.depletionYearByPath[p];
    if (v === -1) {
      depletionYearByPath[p] = null;
    } else {
      depletionYearByPath[p] = v;
      depletionYears.push(v);
    }
  }

  const failureYearHistogram = Array.from(merged.failureYearHistogram);

  return {
    balancesByYearNominal,
    balancesByYearReal,
    taxAcc,
    endingNominal,
    endingReal,
    depletionYears,
    depletionYearByPath,
    failureYearHistogram,
    successes: merged.successes,
  };
}

/** Split `pathCount` into `shardCount` equal contiguous chunks, remainder to
 *  the LAST chunk. `shardCount` is clamped to `[1, pathCount]`, so a request
 *  for more shards than paths yields `pathCount` chunks of 1. */
export function shardBounds(
  pathCount: number,
  shardCount: number,
): Array<{ start: number; end: number }> {
  const shards = Math.max(1, Math.min(Math.floor(shardCount), pathCount));
  const base = Math.floor(pathCount / shards);
  const bounds: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < shards; i += 1) {
    const end = i === shards - 1 ? pathCount : start + base;
    bounds.push({ start, end });
    start = end;
  }
  return bounds;
}

function pushMatrixBuffers(out: Transferable[], rows: Float64Array[]): void {
  for (const row of rows) out.push(row.buffer);
}

/** Every underlying `ArrayBuffer` of a merged/shard accumulation, for the
 *  `postMessage` transfer list (zero-copy, single recipient). A
 *  `PathRangeResult` is structurally assignable to the parameter (its extra
 *  `pathStart`/`pathEnd` are ignored), so both the `shardResult` reply and the
 *  `assemble` dispatch share this collector. */
export function collectAccumulationTransferables(x: MergedAccumulationTransfer): Transferable[] {
  const out: Transferable[] = [];
  pushMatrixBuffers(out, x.balancesByYearNominal);
  pushMatrixBuffers(out, x.balancesByYearReal);
  if (x.tax) {
    pushMatrixBuffers(out, x.tax.fedTaxByYear);
    pushMatrixBuffers(out, x.tax.irmaaSurchargeByYear);
    pushMatrixBuffers(out, x.tax.acaPtcSubsidyByYear);
    pushMatrixBuffers(out, x.tax.acaCreditAppliedToPremiumsByYear);
    pushMatrixBuffers(out, x.tax.effectiveTaxRateByYear);
    pushMatrixBuffers(out, x.tax.netAfterTaxByYear);
  }
  out.push(x.endingNominal.buffer, x.endingReal.buffer);
  out.push(x.depletionYearByPath.buffer, x.failureYearHistogram.buffer);
  return out;
}
