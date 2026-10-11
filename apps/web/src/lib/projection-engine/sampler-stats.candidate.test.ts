/**
 * CANDIDATE-L SWEEP (run-once, opt-in).
 *
 * After the block sampler exists, evaluates the candidate set
 * {1, 3, 6, 12, 18, 24} on a fixed seed, fills the `perCandidateL`
 * autocorrelation/SE table in `__fixtures__/sampler-stats.json`, and prints
 * the per-candidate numbers used to select the default `meanBlockLength`
 * (the smallest L clearing the clustering bar within the SE margin). The
 * chosen block length is explained in docs/math-projections.md
 * ("How one path is built").
 *
 * `describe.skip` by default (writes a fixture; reads `fs`). To run:
 * un-skip → `pnpm --filter @retirement/web exec vitest run sampler-stats.candidate`
 * → re-skip. The committed JSON is the source of truth.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { makeRng } from '../sfc32';
import { drawMonthlySeries } from './historical';
import { absReturnAutocorr } from './sampler-stats';
import { runMonteCarlo } from '../monte-carlo.js';
import {
  RECORDER_SERIES_LEN,
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

describe.skip('candidate-L sweep (run-once, fills fixture table)', () => {
  it('evaluates {1,3,6,12,18,24} autocorrelation + success SE', () => {
    const input = buildRecorderInput();
    const seeds = SE_SEED_SET;
    const perCandidateL = L_CANDIDATES.map((L) => {
      const months = concatSampledPaths((seed) =>
        drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN, L),
      );
      const autocorr = absReturnAutocorr(months);
      const successes = seeds.map(
        (seed) => runMonteCarlo({ ...input, seed, meanBlockLength: L }).successProbability,
      );
      const success = mean(successes);
      return {
        L,
        autocorr,
        success,
        // Canonical Monte Carlo SE of the proportion at this path count (same
        // metric as the baseline), so the SE-vs-clustering trade-off is read
        // on a deterministic, comparable scale across candidates.
        successSe: binomialSe(success, input.pathCount),
      };
    });

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    fixture.perCandidateL = perCandidateL;
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

    console.table(perCandidateL);
  }, 120_000);
});
