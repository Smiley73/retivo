/**
 * The stress-test figures a tool may report from a `MonteCarloSummary`: tier
 * figures and the per-year real percentiles only. Histograms, representative
 * paths and the per-year tax series stay out (the answer must fit the result
 * cap and the agent has no use for them). Shared by the stress-test tool and by
 * compare and explain, which read the same summary from the cache.
 */
import { MC_PATH_COUNT } from '../../lib/monte-carlo-scenario-input';
import type { MonteCarloSummary } from '../../lib/monte-carlo';
import type { ToolEnv } from './define';
import { dollarsFor } from './projection-support';

interface Tier {
  /** The percentile of ending balances this tier is: Typical is the 50th, Pessimistic the 25th, Bad-luck the 10th. */
  percentile: number;
  endingBalanceReal: number | null;
  endingBalanceNominal: number | null;
  /** The year by which this share of paths had run out; `null` when fewer ran out. */
  depletionYear: number | null;
}

/** The stress-test figures without the per-year series: what compare quotes beside a scenario. */
export interface StressHeadline {
  /** The share of simulated paths that never ran out, 0 to 1. */
  successProbability: number;
  pathCount: number;
  seed: number;
  engineVersion: number;
  computedAt: string;
  firstYear: number;
  horizonYears: number;
  tiers: { typical: Tier; pessimistic: Tier; badLuck: Tier };
}

export interface StressFigures extends StressHeadline {
  /** Real (today's-dollar) balance percentiles per year, the first entry being `firstYear`. */
  percentilesReal: { p10: Array<number | null>; p25: Array<number | null>; p50: Array<number | null> };
}

function isoOrNull(milliseconds: number): string {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

export function stressHeadline(summary: MonteCarloSummary, env: ToolEnv): StressHeadline {
  const dollars = dollarsFor(env);
  return {
    successProbability: summary.successProbability,
    pathCount: summary.pathCount,
    seed: summary.seed,
    engineVersion: summary.engineVersion,
    computedAt: isoOrNull(summary.computedAt),
    firstYear: summary.firstYear,
    horizonYears: summary.horizonYears,
    tiers: {
      typical: {
        percentile: 50,
        endingBalanceReal: dollars(summary.medianEndingBalanceReal),
        endingBalanceNominal: dollars(summary.medianEndingBalanceNominal),
        depletionYear: summary.medianDepletionYear,
      },
      pessimistic: {
        percentile: 25,
        endingBalanceReal: dollars(summary.p25EndingBalanceReal),
        endingBalanceNominal: dollars(summary.p25EndingBalanceNominal),
        depletionYear: summary.p25DepletionYear,
      },
      badLuck: {
        percentile: 10,
        endingBalanceReal: dollars(summary.p10EndingBalanceReal),
        endingBalanceNominal: dollars(summary.p10EndingBalanceNominal),
        depletionYear: summary.p10DepletionYear,
      },
    },
  };
}

export function stressFigures(summary: MonteCarloSummary, env: ToolEnv): StressFigures {
  const dollars = dollarsFor(env);
  const series = (values: readonly number[]): Array<number | null> => values.map((value) => dollars(value));
  return {
    ...stressHeadline(summary, env),
    percentilesReal: {
      p10: series(summary.percentilesReal.p10),
      p25: series(summary.percentilesReal.p25),
      p50: series(summary.percentilesReal.p50),
    },
  };
}

/** Where a stress-test reading came from, said the way the page says it. */
export const STRESS_BASIS =
  "Real figures are in today's dollars, with each simulated path's own inflation removed; nominal figures are in the dollars of the horizon year. Typical, Pessimistic and Bad-luck are the 50th, 25th and 10th percentile of ending balances.";

/**
 * The sampling-error note and the seed rule from docs/math-projections.md, "Reading the result". The
 * standard error of a success probability estimated from `n` paths is at most 0.5 / sqrt(n).
 */
export function monteCarloAssumptions(summary: MonteCarloSummary): string[] {
  const standardErrorPoints = (50 / Math.sqrt(summary.pathCount)).toFixed(1);
  return [
    `Sampling error: success is an estimate from ${summary.pathCount.toLocaleString('en-US')} simulated paths. The standard error is at most about ${standardErrorPoints} percentage points, so treat a one-point difference between two plans as noise.`,
    'Seed rule: a run is deterministic. Its random numbers come from a seed worked out from the plan’s inputs, so an unchanged plan gives the same sample and the same numbers every time, and a change to the inputs gives a new sample.',
    `The paths replay real historical market months in a random order. ${summary.pathCount === MC_PATH_COUNT ? 'This is the same path count the Balance Projection page uses.' : `The Balance Projection page uses ${MC_PATH_COUNT.toLocaleString('en-US')} paths.`}`,
  ];
}
