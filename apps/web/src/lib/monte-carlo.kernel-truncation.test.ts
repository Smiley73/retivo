/**
 * Kernel-truncation + SoA-sampler tests.
 *
 *  (a) Instrumented kernel-invocation-count assertion — proves the
 *      truncation DIRECTLY (independent of the byte-identity pins, which pass
 *      whether or not truncation actually happens): the proportional kernel is
 *      called ZERO times for an already-retired scenario (`retStart === 0`,
 *      kernel skipped) and EXACTLY ONCE with a length-`retStart` (truncated)
 *      step for a future-retirement scenario.
 *  (b) The four injected-return byte-identity pins (future
 *      retirement / already retired / guardrails / QCD), each captured as a
 *      named case in the SHARED `mc-perf-identity.json` fixture (same
 *      unskip-capture-reskip procedure as the other cases) with a non-zero,
 *      month-to-month VARYING injected `cpiPct` so the cumCpi-source
 *      swap is exercised where a mismatch would be visible.
 *  (c) `drawMonthlyIndices` ↔ `drawMonthlySeries` index/object-identity
 *      equivalence across seeds {1, 12345} × block lengths {1, 3, 24}.
 *
 * All must stay green with NO fixture re-capture and NO ENGINE_VERSION bump —
 * a red result means the last change moved a number; fix the code, never the
 * fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import fixtureJson from './__fixtures__/mc-perf-identity.json';
import {
  buildRunContext,
  runMonteCarlo,
  runOnePath,
  truncateStepForAccumulation,
} from './monte-carlo';
import { runStepKernel } from './projection-engine/kernel';
import type { KernelAccount, StepInputs } from './projection-engine/kernel-shared';
import { summaryToComparable } from './monte-carlo.test-helpers';
import {
  buildAlreadyRetiredInput,
  buildFutureRetirementInput,
  buildGuardrailsEnabledInput,
  buildQcdEnabledInput,
} from './monte-carlo.kernel-truncation-cases';
// Namespace import so the kernel-invocation spy can intercept the live
// `runStepKernel` binding that `monte-carlo.ts` calls internally.
import * as kernelModule from './projection-engine/kernel';
import {
  drawMonthlyIndices,
  drawMonthlySeries,
  HISTORICAL_MONTHLY,
} from './projection-engine/historical';
import { makeRng } from './sfc32';

interface McPerfIdentityFixture {
  readonly caseA: unknown;
  readonly caseB: unknown;
  readonly futureRetirement: unknown;
  readonly alreadyRetired: unknown;
  readonly guardrailsEnabled: unknown;
  readonly qcdEnabled: unknown;
}

const fixture = fixtureJson as McPerfIdentityFixture;

// ---------------------------------------------------------------------------
// (a) Instrumented kernel-invocation-count assertion.
// ---------------------------------------------------------------------------

describe('kernel truncation + skip — invocation count', () => {
  it('SKIPS the kernel entirely for an already-retired scenario (retStart === 0)', () => {
    const input = buildAlreadyRetiredInput();
    const ctx = buildRunContext(input);
    const spy = vi.spyOn(kernelModule, 'runStepKernel');
    // One strategy path directly (no representative replay / overlay noise): an
    // already-retired path has no accumulation phase, so the kernel is never run.
    runOnePath(input, input.seed, ctx);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs the kernel EXACTLY ONCE with a length-retStart (truncated) step for a future-retirement scenario', () => {
    const input = buildFutureRetirementInput();
    const retStart = (input.retirementYear - input.firstYear) * 12; // 10 accum years → 120.
    const fullStepCount = (input.horizonYear - input.firstYear + 1) * 12; // 300.
    const ctx = buildRunContext(input);
    const spy = vi.spyOn(kernelModule, 'runStepKernel');
    runOnePath(input, input.seed, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    const stepArg = spy.mock.calls[0][0] as { cpiPct: Float64Array };
    // The kernel sees only the accumulation-phase (truncated) step, NOT the
    // full horizon — the drawdown-phase output the strategy path discards is
    // never computed.
    expect(stepArg.cpiPct.length).toBe(retStart);
    expect(stepArg.cpiPct.length).toBeLessThan(fullStepCount);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (a2) Self-contained truncation ↔ full-run accumulation equivalence.
//      Proves `truncateStepForAccumulation` preserves the accumulation-phase
//      kernel output byte-for-byte, independent of any captured fixture: run a
//      hand-built step full AND truncated, then compare the truncated output to
//      the full output SLICED to the truncation length.
// ---------------------------------------------------------------------------

describe('truncateStepForAccumulation — accumulation-phase output identity', () => {
  it('yields kernel output byte-identical to the full run sliced to [0, retStart)', () => {
    const stepCount = 24;
    const retirementStepIdx = 15;
    // Real derivation: strategy engine trims at the whole retirement-YEAR
    // boundary, `Math.floor(retirementStepIdx / 12) * 12`.
    const retStart = Math.floor(retirementStepIdx / 12) * 12; // 12
    expect(retStart).toBeLessThan(stepCount);
    expect(retStart).toBeLessThanOrEqual(retirementStepIdx);

    const contribPre = new Float64Array(stepCount);
    const contribPost = new Float64Array(stepCount);
    const deposit = new Float64Array(stepCount);
    const returnPct = new Float64Array(stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      contribPre[i] = 100 + i;
      contribPost[i] = 50 + i * 2;
      returnPct[i] = 0.4 + i * 0.01;
    }
    const account: KernelAccount = {
      id: 'acc',
      initialPre: 250_000,
      initialPost: 120_000,
      contribPre,
      contribPost,
      deposit,
      returnPct,
    };
    const cpiPct = new Float64Array(stepCount).fill(0.2);
    const step: StepInputs = {
      mainReturnPct: new Float64Array(stepCount),
      cpiPct,
      contribPre: new Float64Array(stepCount),
      contribPost: new Float64Array(stepCount),
      expense: new Float64Array(stepCount),
      income: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      retirementStepIdx,
      initialPre: 0,
      initialPost: 0,
      accounts: [account],
    };

    const full = runStepKernel(step);
    const truncated = runStepKernel(truncateStepForAccumulation(step, retStart));

    // Aggregate accumulation balances match the full run's first `retStart` steps.
    expect(Array.from(truncated.preEnd)).toEqual(Array.from(full.preEnd.slice(0, retStart)));
    expect(Array.from(truncated.postEnd)).toEqual(Array.from(full.postEnd.slice(0, retStart)));

    // Per-account balances match too.
    const fullPre = full.accountPreEnd!;
    const fullPost = full.accountPostEnd!;
    const truncPre = truncated.accountPreEnd!;
    const truncPost = truncated.accountPostEnd!;
    expect(truncPre).toHaveLength(fullPre.length);
    for (let a = 0; a < fullPre.length; a += 1) {
      expect(Array.from(truncPre[a])).toEqual(Array.from(fullPre[a].slice(0, retStart)));
      expect(Array.from(truncPost[a])).toEqual(Array.from(fullPost[a].slice(0, retStart)));
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Four injected-return byte-identity pins (edge cases).
// ---------------------------------------------------------------------------

describe('kernel-truncation injected-return byte-identity pins', () => {
  it('futureRetirement — reproduces the captured fixture', () => {
    expect(summaryToComparable(runMonteCarlo(buildFutureRetirementInput()))).toEqual(
      fixture.futureRetirement,
    );
  });

  it('alreadyRetired (kernel skipped) — reproduces the captured fixture', () => {
    expect(summaryToComparable(runMonteCarlo(buildAlreadyRetiredInput()))).toEqual(
      fixture.alreadyRetired,
    );
  });

  it('guardrailsEnabled — reproduces the captured fixture', () => {
    expect(summaryToComparable(runMonteCarlo(buildGuardrailsEnabledInput()))).toEqual(
      fixture.guardrailsEnabled,
    );
  });

  it('qcdEnabled — reproduces the captured fixture', () => {
    expect(summaryToComparable(runMonteCarlo(buildQcdEnabledInput()))).toEqual(fixture.qcdEnabled);
  });
});

// ---------------------------------------------------------------------------
// (c) drawMonthlyIndices ↔ drawMonthlySeries equivalence.
// ---------------------------------------------------------------------------

describe('drawMonthlyIndices ↔ drawMonthlySeries object-identity equivalence', () => {
  it('the sampled row at each index is the SAME object drawMonthlySeries returns, across seeds × block lengths', () => {
    const monthCount = 60;
    for (const seed of [1, 12345]) {
      for (const meanBlockLength of [1, 3, 24]) {
        // Independent RNG instances with the same seed → identical call sequence.
        const idx = drawMonthlyIndices(makeRng(seed), monthCount, meanBlockLength);
        const series = drawMonthlySeries(makeRng(seed), monthCount, meanBlockLength);
        expect(idx.length).toBe(monthCount);
        for (let i = 0; i < monthCount; i += 1) {
          // Object identity: the index selects the exact same dataset row.
          expect(HISTORICAL_MONTHLY[idx[i]]).toBe(series[i]);
        }
      }
    }
  });
});
