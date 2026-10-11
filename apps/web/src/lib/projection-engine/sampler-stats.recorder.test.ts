/**
 * RED-FIRST RECORDER (run-once, opt-in).
 *
 * Records the baseline constants for the block-bootstrap validation suite
 * into `__fixtures__/sampler-stats.json`. The bars in `monte-carlo.test.ts`
 * are deltas off these recorded constants, so they were captured on a FIXED
 * seed against the original IID sampler, before the `drawMonthlySeries` block
 * rewrite, and are never back-fitted to block output.
 *
 * `describe.skip` by default — it writes a fixture (a side effect) and reads
 * `fs`, so it is not part of the normal `pnpm test` run. To (re)record:
 * un-skip, run `pnpm --filter @retirement/web exec vitest run sampler-stats.recorder`,
 * then re-skip before committing. The committed JSON is the source of truth.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRng } from '../sfc32';
import { HISTORICAL_MONTHLY, drawMonthlySeries } from './historical';
import {
  REFERENCE_MIX,
  absReturnAutocorr,
  correlationMatrix,
  drawdownRunFrequency,
} from './sampler-stats';
import { runMonteCarlo, type MonteCarloInput } from '../monte-carlo.js';
import {
  RECORDER_SEED,
  RECORDER_SERIES_LEN,
  RECORDER_DRAWDOWN_RUN_N,
  L_CANDIDATES,
  SE_SEED_SET,
  binomialSe,
  buildRecorderInput,
  concatSampledPaths,
} from './sampler-stats-fixtures.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'sampler-stats.json',
);

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

describe.skip('sampler-stats recorder (run-once, writes fixture)', () => {
  it('records baseline IID + empirical constants', () => {
    const data = HISTORICAL_MONTHLY;

    // (i) IID baseline |return| autocorrelation over a concatenation of
    //     fixed-seed IID paths. L = 1 is the explicit IID control (the
    //     single-month sampler); the 2-arg default now resolves to the block L,
    //     so the baseline MUST pin L = 1.
    const iidMonths = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN, 1),
    );
    const baseline_iid_autocorr = absReturnAutocorr(iidMonths);

    // (ii) empirical |return| autocorrelation on the raw 1950-onward series.
    const empirical_autocorr = absReturnAutocorr(data);

    // (iii) empirical cross-asset + return-CPI correlation matrix.
    const empirical_corr = correlationMatrix(data);

    // (iv) drawdown-run frequencies (IID vs empirical) at the pinned run length.
    const baseline_iid_drawdown_freq = drawdownRunFrequency(
      iidMonths,
      RECORDER_DRAWDOWN_RUN_N,
    );
    const empirical_drawdown_freq = drawdownRunFrequency(
      data,
      RECORDER_DRAWDOWN_RUN_N,
    );

    // (v) tail: P10 band + successProbability on the IID engine, plus SEs.
    const input: MonteCarloInput = buildRecorderInput();
    const successes: number[] = [];
    const p10s: number[] = [];
    for (const seed of SE_SEED_SET) {
      // L = 1 = the IID baseline engine (block sampler defaults to L now).
      const out = runMonteCarlo({ ...input, seed, meanBlockLength: 1 });
      successes.push(out.successProbability);
      // P10 of the ending-balance distribution (real), the band the tail bar
      // tracks; index the at-horizon year.
      p10s.push(out.p10EndingBalanceReal);
    }
    const baseline_iid_success = mean(successes);
    const baseline_iid_p10 = mean(p10s);
    // successProbability SE: the canonical Monte Carlo standard error of a
    // proportion at this fixed path count, `sqrt(p(1-p)/pathCount)`. This is
    // the "Monte Carlo SE for a fixed path count" the selection criterion names;
    // it is deterministic (a function of the recorded p), so the SE bar does not
    // wobble with seed-set noise. The cross-seed std-dev is kept as a sanity
    // diagnostic only.
    const baseline_iid_success_se = binomialSe(baseline_iid_success, input.pathCount);
    const baseline_iid_p10_se = stdDev(p10s) / Math.max(1, Math.abs(baseline_iid_p10));

    // Per-candidate-L table — placeholder rows; the block sampler does not
    // exist yet, so autocorr/SE land null and are filled by the post-rewrite
    // candidate sweep (`sampler-stats.candidate.test.ts`).
    const perCandidateL = L_CANDIDATES.map((L) => ({
      L,
      autocorr: null as number | null,
      success: null as number | null,
      successSe: null as number | null,
    }));

    const fixture = {
      _comment:
        'Red-first baseline constants for the block-bootstrap ' +
        'validation suite. Recorded from the PRE-rewrite IID sampler + raw ' +
        'empirical series on RECORDER_SEED. Do not hand-edit; regenerate via ' +
        'sampler-stats.recorder.test.ts. See docs/math-projections.md.',
      recorderSeed: RECORDER_SEED,
      seriesLen: RECORDER_SERIES_LEN,
      referenceMix: REFERENCE_MIX,
      drawdownRunLength: RECORDER_DRAWDOWN_RUN_N,
      baseline_iid_autocorr,
      empirical_autocorr,
      empirical_corr,
      baseline_iid_drawdown_freq,
      empirical_drawdown_freq,
      baseline_iid_p10,
      baseline_iid_success,
      baseline_iid_success_se,
      baseline_iid_p10_se,
      perCandidateL,
    };

    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

    // Confirm the right red-first reality: IID autocorr is near zero, the raw
    // series carries real clustering, and the IID sampler under-produces
    // sustained drawdowns relative to history.
    expect(Math.abs(baseline_iid_autocorr)).toBeLessThan(0.05);
    expect(empirical_autocorr).toBeGreaterThan(baseline_iid_autocorr + 0.05);
    expect(empirical_drawdown_freq).toBeGreaterThan(baseline_iid_drawdown_freq);
  });
});
