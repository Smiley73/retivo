/**
 * `retivo_get_stress_test`: the Monte Carlo summary the Balance Projection page
 * shows, for one scenario.
 *
 * Cache first, read without touching it (`peekCached`: no `lastAccessedAt` bump,
 * no eviction, no delete). On a miss the tool runs the page's own computation in
 * this tab: the same input (`buildMonteCarloInputForScenario`), the same path
 * count (`MC_PATH_COUNT`, never reduced) and the seed the page's auto-run draws
 * from the same input (`autoRunSeed`), through its own `runMonteCarloSharded`
 * call, so the numbers equal the page's whatever the pool size. It never writes
 * the result: not `putCached`, not any other storage.
 *
 * Caps live here: one assistant run at a time (a second concurrent call fails
 * fast), a wall clock that fails the call instead of shrinking the run, and an
 * abort (cancel, timeout, session teardown) that disposes the pool and every
 * worker.
 */
import { autoRunSeed } from '../../lib/monte-carlo-input-signature';
import { MC_PATH_COUNT } from '../../lib/monte-carlo-scenario-input';
import type { MonteCarloInput, MonteCarloSummary } from '../../lib/monte-carlo';
import type { MinimalMcWorker } from '../../monte-carlo/mc-worker-pool';
import { runMonteCarloSharded } from '../../monte-carlo/run-monte-carlo-sharded';
import MCWorker from '../../workers/monte-carlo.worker.ts?worker';
import { sanitizeFreeText } from '../sharing/sanitize';
import { defineTool, PROJECTION_UNAVAILABLE_MESSAGE, ToolFailure, type ToolEnv } from './define';
import { inputDefaultAssumptions } from './projection-assumptions';
import { analysisRefusal, resolveScenarioArg } from './projection-support';
import { monteCarloInputFor, peekSummary } from './stress-cache';
import { STRESS_BASIS, monteCarloAssumptions, stressFigures } from './stress-figures';

/** How long a simulation may run before the call fails. The registry gives the bridge 90 seconds, above this. */
export const STRESS_TEST_WALL_CLOCK_MS = 60_000;

const MAX_WORKER_MESSAGE_CHARS = 200;

export interface StressTestOptions {
  /** Builds one pool worker. Production passes none and gets the real Monte Carlo worker. */
  workerFactory?: () => MinimalMcWorker;
  /** Test-only: the path count a miss runs. Production always runs `MC_PATH_COUNT`. */
  pathCount?: number;
  /** Test-only: the wall clock. */
  wallClockMs?: number;
  /** The runner to compute on, shared with another tool so the two count as one simulation at a time. */
  runner?: StressRunner;
}

/** Runs one simulation under the assistant's caps. Reads and writes no cache; the caller decides what to do with the result. */
export interface StressRunner {
  readonly pathCount: number;
  run(input: MonteCarloInput, env: ToolEnv): Promise<MonteCarloSummary>;
}

export function makeStressRunner(options: Omit<StressTestOptions, 'runner'> = {}): StressRunner {
  const factory = options.workerFactory ?? ((): MinimalMcWorker => new MCWorker() as unknown as MinimalMcWorker);
  const pathCount = options.pathCount ?? MC_PATH_COUNT;
  const wallClockMs = options.wallClockMs ?? STRESS_TEST_WALL_CLOCK_MS;
  /** At most one assistant simulation at a time; the page's own runs are not counted here. */
  let running = false;

  /** Runs the simulation on a miss. Resolves with the summary or throws the failure the caller reports. */
  async function compute(input: MonteCarloInput, env: ToolEnv): Promise<MonteCarloSummary> {
    const { signal, progress } = env.context;
    if (running) throw new ToolFailure('TOO_MANY_IN_FLIGHT', 'A stress test is already running for this assistant. Wait for it to finish, then ask again.');
    if (signal.aborted) throw new ToolFailure('CANCELLED', 'The request was cancelled.');
    running = true;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort);
    let capped = false;
    const timer = setTimeout(() => {
      capped = true;
      controller.abort();
    }, wallClockMs);

    // One progress frame per whole percent, and exactly one for the finish.
    let lastPercent = -1;
    let completeReported = false;
    const report = (done: number, total: number): void => {
      const complete = done >= total;
      const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
      if (complete ? completeReported : percent <= lastPercent) return;
      lastPercent = percent;
      completeReported = complete;
      progress({ fraction: total > 0 ? done / total : 1, message: `Simulated ${done} of ${total} paths.` });
    };

    try {
      const reply = await runMonteCarloSharded(
        { ...input, seed: autoRunSeed(input, false) },
        { factory, signal: controller.signal, onProgress: report },
      );
      if (reply.kind === 'result') {
        if (!completeReported) report(input.pathCount, input.pathCount);
        return reply.summary;
      }
      if (capped) {
        throw new ToolFailure(
          'COMPUTE_CAP_EXCEEDED',
          `The stress test did not finish within ${Math.round(wallClockMs / 1000)} seconds, so it was stopped. It was not shortened to fit; nothing was saved. Run it from the Balance Projection page instead, which can take as long as it needs.`,
        );
      }
      if (reply.kind === 'aborted') throw new ToolFailure('CANCELLED', 'The request was cancelled.');
      const message = sanitizeFreeText(reply.message, env.masker).slice(0, MAX_WORKER_MESSAGE_CHARS);
      throw new ToolFailure('INTERNAL', `The simulation failed in the worker: ${message}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
      running = false;
    }
  }

  return { pathCount, run: compute };
}

export function makeStressTestTool(options: StressTestOptions = {}) {
  const runner = options.runner ?? makeStressRunner(options);
  return defineTool('retivo_get_stress_test', async (args, env) => {
    const scenarioId = resolveScenarioArg(args.scenarioId, env);
    const refused = analysisRefusal(env, [scenarioId]);
    if (refused !== null) return refused;
    const input = monteCarloInputFor(scenarioId, env, runner.pathCount);
    if (input === null) throw new ToolFailure('INVALID_ARGS', PROJECTION_UNAVAILABLE_MESSAGE);

    const cached = await peekSummary(input);
    const source = cached === null ? 'computed' : 'cache';
    const summary = cached ?? (await runner.run(input, env));
    return {
      data: {
        scenarioId,
        source,
        sourceNote:
          source === 'cache'
            ? 'This is the result the Balance Projection page already saved for the plan as it stands. Nothing was recalculated.'
            : `The app had no saved result, so it was computed now in the open tab with the page's own seed and ${input.pathCount.toLocaleString('en-US')} paths. Nothing was saved, and it does not change what the page shows.`,
        basis: STRESS_BASIS,
        ...stressFigures(summary, env),
      },
      assumptions: [...monteCarloAssumptions(summary), ...inputDefaultAssumptions(scenarioId, env)],
    };
  });
}

/** The one runner the shipped stress-test and what-if tools compute on, so a call to either counts against the same single slot. */
export const stressRunner = makeStressRunner();

export const retivoGetStressTest = makeStressTestTool({ runner: stressRunner });
