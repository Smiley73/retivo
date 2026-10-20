/**
 * The per-candidate pass loop. The limits come from the calibration tables and
 * the year's filing facts, but the MAGI the engine reports for a year also
 * carries income the Fill step cannot see while it sizes a conversion, and
 * that gap moves a little with the rest of the ladder. So a ladder is a short
 * fixed-point loop: write every window year's ceiling, project once with the
 * whole ladder, measure the gap from the new rows, verify from the same rows,
 * and repeat while a ceiling moved by more than a dollar. The greedy fill is
 * per year with no lookahead across years, which is what keeps the projection
 * count at `1 + candidates x passes`.
 */
import type { MagiCapWindow } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import type { CandidateSpec } from './candidate-grid';
import { buildLadder } from './ladder';
import type { PlannedProjection, ProjectionRunner } from './projection';
import type { LookbackFacts, YearFacts } from './year-facts';
import {
  bracketGeometry,
  deriveYearLimits,
  taxableOrdinaryBoundDollars,
  type LimitEnvironment,
  type ReferenceTiers,
} from './year-limits';
import type { UnrankedReason, YearLimits } from './types';

/** Upper bound on projections per ladder candidate. */
export const MAX_PASSES_PER_CANDIDATE = 10;
/** A ceiling that moved this many dollars or less has settled. */
const SETTLED_DOLLARS = 1;
/** Rounding slack when comparing a row's MAGI with a whole-dollar ceiling. */
const BRACKET_SLACK_DOLLARS = 1;
/** Kept under the limit when the offset is measured: the gap drifts by cents
 *  from pass to pass as earlier conversions change the taxable balances that
 *  throw it off, and a limit is only worth anything if the MAGI stays at or
 *  under it. Costs at most this many dollars of conversion per year. */
const OFFSET_MARGIN_DOLLARS = 2;
const CENTS_PER_DOLLAR = 100;

/** What a window year's limits read that no candidate changes. */
export interface WindowYear {
  readonly facts: YearFacts;
  readonly lookback: LookbackFacts;
  readonly reference: ReferenceTiers;
  readonly grossSsDollars: number;
}

/** Everything a pass reads that does not change from candidate to candidate. */
export interface PassEnvironment {
  readonly limitEnv: LimitEnvironment;
  readonly targetRothAccountId: string;
  /** Ascending, one entry per year of the conversion window. */
  readonly windowYears: readonly WindowYear[];
  readonly runner: ProjectionRunner;
}

export interface LadderOutcome {
  readonly limits: readonly YearLimits[];
  readonly ladder: readonly MagiCapWindow[];
  readonly plan: PlannedProjection;
  readonly passes: number;
  readonly converged: boolean;
  /** Why the cap was not met, empty when it was. */
  readonly unranked: readonly UnrankedReason[];
}

export function indexRows(rows: readonly DrawdownYear[]): Map<number, DrawdownYear> {
  return new Map(rows.map((row) => [row.year, row]));
}

function deriveAllLimits(
  spec: CandidateSpec,
  env: PassEnvironment,
  offsets: readonly number[],
): YearLimits[] {
  return env.windowYears.map((year, i) =>
    deriveYearLimits(
      {
        rate: spec.bracketRate ?? 0,
        guarded: spec.guarded === true,
        facts: year.facts,
        lookback: year.lookback,
        reference: year.reference,
        grossSsDollars: year.grossSsDollars,
        engineOffsetDollars: offsets[i],
      },
      env.limitEnv,
    ),
  );
}

/**
 * Per-year gap between the MAGI a row reports and the ceiling the Fill step
 * was given. The step sizes a conversion against the income its funding pass
 * can see (withdrawals, their gains and the conversion), which leaves out the
 * year's interest and dividends on taxable accounts, so the reported MAGI
 * lands above the ceiling by that amount. Only a year a conversion filled up
 * to its ceiling shows the gap; any other year keeps the offset it had. A year
 * whose spending was rerouted is left alone on purpose: the rerouted draw adds
 * gains the cap does not govern, so no ceiling moves its MAGI one for one.
 */
function calibrateOffsets(
  limits: readonly YearLimits[],
  rows: ReadonlyMap<number, DrawdownYear>,
): number[] {
  return limits.map((limit) => {
    const row = rows.get(limit.year);
    const filled =
      row !== undefined &&
      (row.rothConvertedCents ?? 0) > 0 &&
      (row.magiCapBreachDollars ?? 0) <= 0;
    if (!filled) return limit.engineOffsetDollars;
    const gap = (row.magiCents ?? 0) / CENTS_PER_DOLLAR - limit.ceilingDollars;
    return Math.max(0, Math.ceil(gap) + OFFSET_MARGIN_DOLLARS);
  });
}

function largestMove(a: readonly YearLimits[], b: readonly YearLimits[]): number {
  return a.reduce((max, limit, i) => Math.max(max, Math.abs(limit.ceilingDollars - b[i].ceilingDollars)), 0);
}

/** Whether the rows kept each guarded year on its side of the line, judged
 *  from the rows rather than from the ceilings. */
function guardCrossings(
  limits: readonly YearLimits[],
  rows: ReadonlyMap<number, DrawdownYear>,
): { year: number; line: 'irmaa' | 'aca' }[] {
  const crossings: { year: number; line: 'irmaa' | 'aca' }[] = [];
  for (const limit of limits) {
    if (limit.irmaa.applies) {
      const tier = rows.get(limit.irmaa.lookbackYear)?.irmaaTier ?? 'none';
      if (tier !== 'none') crossings.push({ year: limit.year, line: 'irmaa' });
    }
    if (limit.aca.applies && rows.get(limit.year)?.acaPtcTier === 'above-400-cliff') {
      crossings.push({ year: limit.year, line: 'aca' });
    }
  }
  return crossings;
}

/**
 * Conversion years whose MAGI, less that year's deductions, is above the
 * bracket top. A year with no conversion is not the candidate's doing (its
 * income is whatever spending forced, and MAGI there can include capital gains
 * that are not ordinary income), and a breach year is reported as a breach.
 * In a conversion year the check is conservative: MAGI also carries gains and
 * dividends, so taxable ordinary income is at most MAGI less deductions.
 */
function bracketExceededYears(
  spec: CandidateSpec,
  limits: readonly YearLimits[],
  rows: ReadonlyMap<number, DrawdownYear>,
  env: PassEnvironment,
): number[] {
  const exceeded: number[] = [];
  for (const [i, limit] of limits.entries()) {
    const row = rows.get(limit.year);
    if (row === undefined || (row.rothConvertedCents ?? 0) <= 0) continue;
    if ((row.magiCapBreachDollars ?? 0) > 0) continue;
    const geometry = bracketGeometry(spec.bracketRate ?? 0, env.windowYears[i].facts, env.limitEnv);
    const magiDollars = (row.magiCents ?? 0) / CENTS_PER_DOLLAR;
    if (taxableOrdinaryBoundDollars(geometry, magiDollars) > geometry.topDollars + BRACKET_SLACK_DOLLARS) {
      exceeded.push(limit.year);
    }
  }
  return exceeded;
}

function unrankedReasons(
  spec: CandidateSpec,
  limits: readonly YearLimits[],
  plan: PlannedProjection,
  env: PassEnvironment,
): UnrankedReason[] {
  const rows = indexRows(plan.years);
  const reasons: UnrankedReason[] = [];
  const breached = limits.filter((l) => (rows.get(l.year)?.magiCapBreachDollars ?? 0) > 0);
  if (breached.length > 0) {
    reasons.push({ kind: 'cap-breached', years: breached.map((l) => l.year) });
  }
  const crossings = guardCrossings(limits, rows);
  if (crossings.length > 0) reasons.push({ kind: 'guard-crossed', crossings });
  const exceeded = bracketExceededYears(spec, limits, rows, env);
  if (exceeded.length > 0) reasons.push({ kind: 'bracket-exceeded', years: exceeded });
  return reasons;
}

/**
 * Runs one ladder candidate to a settled plan or the pass cap. Returns null
 * when a projection has no portfolio to draw down. A guarded plan that still
 * crosses a guarded line when the loop ends is returned unranked with the
 * years and lines, never as a plan that merely looks guarded.
 */
export async function searchLadderCandidate(
  spec: CandidateSpec,
  env: PassEnvironment,
): Promise<LadderOutcome | null> {
  let limits = deriveAllLimits(spec, env, env.windowYears.map(() => 0));
  for (let pass = 1; ; pass += 1) {
    const ladder = buildLadder(limits, env.targetRothAccountId);
    const plan = await env.runner.project(ladder);
    if (plan === null) return null;
    const rows = indexRows(plan.years);
    const next = deriveAllLimits(spec, env, calibrateOffsets(limits, rows));
    const settled = largestMove(limits, next) <= SETTLED_DOLLARS;
    const finished = settled || pass >= MAX_PASSES_PER_CANDIDATE;
    env.runner.tick(finished);
    if (finished) {
      return {
        limits,
        ladder,
        plan,
        passes: pass,
        converged: settled,
        unranked: unrankedReasons(spec, limits, plan, env),
      };
    }
    limits = next;
  }
}
