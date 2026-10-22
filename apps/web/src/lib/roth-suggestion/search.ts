/**
 * Roth conversion suggestion search. Builds a small grid of candidate ladders
 * (the plausible ordinary brackets, each with and without the IRMAA / ACA
 * cliff guards) plus the scenario's current plan as the reference, runs each
 * through the planned-basis projection, and ranks them on after-tax ending
 * balance. Deterministic for fixed inputs, bounded in projections, and
 * cancellable between projections.
 */
import { MAX_AGE, isMagiCapDisabled, type MagiCapWindow } from '../../db/types';
import { grossSsForYear } from '../balance-projection-runner-tax-helpers';
import { MagiCapCalibrationError, type PipelineContext } from '../balance-projection-runner-types';
import { MissingCustomDrawdownOrderError } from '../drawdown-engine-per-account';
import type { DrawdownYear } from '../drawdown-engine-types';
import { detectUnsupportedScenarioFeatures } from '../optimizer-unsupported';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from '../tax-integration';
import {
  indexRows,
  searchLadderCandidate,
  type PassEnvironment,
  type WindowYear,
} from './candidate-passes';
import { buildCandidateGrid, type CandidateSpec } from './candidate-grid';
import { conversionWindow, isValidFillTarget, type ConversionWindow } from './ladder';
import {
  RothSuggestionCancelled,
  buildProjectionArgs,
  createProjectionRunner,
  prepareProjection,
  type PlannedProjection,
  type PreparedProjection,
  type ProjectionRunner,
} from './projection';
import { rankedOrder } from './ranking';
import {
  breachYearsOf,
  finalizeCandidate,
  measureDraft,
  type CandidateDraft,
} from './summarise';
import { buildYearDetail, type DetailYearInput, type YearDetailEnvironment } from './year-detail';
import { benchmarkSlcspCentsForYear, resolveLookbackFacts, resolveYearFacts } from './year-facts';
import type { LimitEnvironment, ReferenceTiers } from './year-limits';
import { buildYearRecords, type AccountsById } from './year-records';
import type {
  RothSuggestionOk,
  RothSuggestionRequest,
  RothSuggestionResult,
  RothSuggestionUnsupportedReason,
  YearLimits,
} from './types';

type Unsupported = { readonly kind: 'unsupported'; readonly reason: RothSuggestionUnsupportedReason };

function unsupported(reason: RothSuggestionUnsupportedReason): Unsupported {
  return { kind: 'unsupported', reason };
}

/** Throws `RangeError` on a rate or death age a caller should never send. */
function validateRequest(request: RothSuggestionRequest): void {
  const { leftoverTaxRate, deathAges } = request;
  if (!Number.isFinite(leftoverTaxRate) || leftoverTaxRate < 0 || leftoverTaxRate >= 1) {
    throw new RangeError(`leftoverTaxRate must be a fraction in [0, 1); got ${leftoverTaxRate}`);
  }
  const ages: number[] = [deathAges.primary];
  if (deathAges.secondary !== undefined) ages.push(deathAges.secondary);
  for (const age of ages) {
    if (!Number.isInteger(age) || age < 1 || age > MAX_AGE) {
      throw new RangeError(`death ages must be whole years in [1, ${MAX_AGE}]; got ${String(age)}`);
    }
  }
}

interface SearchSetup {
  readonly prepared: PreparedProjection;
  readonly window: ConversionWindow;
  readonly limitEnv: LimitEnvironment;
  readonly accountsById: AccountsById;
  readonly years: readonly Omit<WindowYear, 'reference'>[];
  /** What each window year's detail reads that no candidate changes. */
  readonly detailYears: ReadonlyMap<number, DetailYearInput>;
  readonly detailEnv: YearDetailEnvironment;
}

/** Without a birth year the engine dates the horizon from the clock. */
function hasBirthYear(birthdate: string | null | undefined): boolean {
  const birthYear = Number((birthdate ?? '').slice(0, 4));
  return Number.isFinite(birthYear) && birthYear > 0;
}

/** The window years' filing facts and gross Social Security, or why the
 *  search cannot run on this household. */
function prepareSetup(request: RothSuggestionRequest): SearchSetup | Unsupported {
  const { projection } = request;
  const scenario = projection.scenarios.find((s) => s.id === projection.selectedScenarioId);
  if (scenario === undefined) {
    throw new RangeError(`unknown scenario ${projection.selectedScenarioId}`);
  }
  const prepared = prepareProjection(buildProjectionArgs(request, undefined));
  if (prepared === null) return unsupported('no-primary-retirement');
  const { ctx, series } = prepared;
  const members = ctx.secondary === undefined ? [ctx.primary] : [ctx.primary, ctx.secondary];
  if (!members.every((m) => hasBirthYear(m.payload.birthdate))) {
    return unsupported('member-birthdate-missing');
  }
  const cbp = detectUnsupportedScenarioFeatures({
    scenario,
    scenarios: projection.scenarios,
    accounts: projection.accounts,
    incomeStreams: projection.incomeStreams,
  });
  if (cbp !== null) return unsupported(cbp);
  if (!isValidFillTarget(projection.accounts, request.targetRothAccountId)) {
    return unsupported('no-roth-ira');
  }
  const window = conversionWindow({
    primaryBirthYear: Number((ctx.primary.payload.birthdate ?? '').slice(0, 4)),
    retirementYear: ctx.primaryRetirementYear,
    horizonYear: ctx.horizonYear,
    todayYear: projection.todayYear,
  });
  if (window === null) return unsupported('no-retirement-window');
  const years: Omit<WindowYear, 'reference'>[] = [];
  const detailYears = new Map<number, DetailYearInput>();
  for (let year = window.startYear; year <= window.endYear; year += 1) {
    const resolved = resolveYearFacts(ctx, year);
    if (resolved.kind === 'unsupported') return unsupported(resolved.reason);
    const windowYear = {
      facts: resolved.facts,
      lookback: resolveLookbackFacts(ctx, year),
      grossSsDollars: grossSsForYear(series.ssRows, year),
    };
    years.push(windowYear);
    detailYears.set(year, {
      ...windowYear,
      benchmarkSlcspCents: benchmarkSlcspCentsForYear(ctx, resolved.facts),
    });
  }
  const limitEnv: LimitEnvironment = {
    bundle: projection.bundle ?? DEFAULT_TAX_CALIBRATION_BUNDLE,
    inflationPct: ctx.projCtx.inflationPct,
    acaFplRegion: ctx.acaFplRegion,
  };
  return {
    prepared,
    window,
    years,
    limitEnv,
    detailYears,
    // The projection models tax-exempt interest as zero (`applyTaxYear` input).
    detailEnv: { ...limitEnv, taxExemptInterestCents: 0 },
    accountsById: new Map(projection.accounts.map((a) => [a.id, a.payload])),
  };
}

/** What the zero-conversion baseline rows show at a window year: the guards
 *  only constrain a line the household is under without converting. */
function referenceTiersFor(
  year: number,
  rows: ReadonlyMap<number, DrawdownYear>,
): ReferenceTiers {
  const own = rows.get(year);
  const lookback = rows.get(year + 2);
  return {
    lookbackIrmaaTier: lookback === undefined ? null : (lookback.irmaaTier ?? 'none'),
    acaPtcTier: own === undefined ? null : (own.acaPtcTier ?? 'below-fpl'),
  };
}

/** The scenario's own resolved ladder; a disable sentinel or no cap is empty. */
function resolvedLadder(ctx: PipelineContext): MagiCapWindow[] {
  const cap = ctx.resolvedScenario.magiCap;
  return cap === undefined || isMagiCapDisabled(cap) ? [] : [...cap.windows];
}

/** A candidate's per-year records and the table opened from them. */
function recordsFor(
  setup: SearchSetup,
  plan: PlannedProjection,
  limits: readonly YearLimits[] | null,
): Pick<CandidateDraft, 'years' | 'yearDetail'> {
  const years = buildYearRecords({
    years: plan.years,
    window: setup.window,
    limits,
    accounts: setup.accountsById,
  });
  const yearDetail = buildYearDetail({
    records: years,
    rows: plan.years,
    years: setup.detailYears,
    accounts: setup.accountsById,
    env: setup.detailEnv,
  });
  return { years, yearDetail };
}

function referenceDraft(
  spec: CandidateSpec,
  plan: PlannedProjection,
  setup: SearchSetup,
): CandidateDraft {
  const breached = breachYearsOf(plan.years);
  return {
    spec,
    ladder: resolvedLadder(setup.prepared.ctx),
    plan,
    ...recordsFor(setup, plan, null),
    unranked: breached.length > 0 ? [{ kind: 'cap-breached', years: breached }] : [],
    passes: 1,
    converged: true,
  };
}

function assembleResult(
  request: RothSuggestionRequest,
  setup: SearchSetup,
  drafts: readonly CandidateDraft[],
  projectionsRun: number,
): RothSuggestionOk {
  const measured = drafts.map((draft) =>
    measureDraft(draft, setup.accountsById, request.leftoverTaxRate),
  );
  const order = rankedOrder(
    measured.map((m) => ({
      id: m.draft.spec.id,
      ranked: m.draft.unranked.length === 0,
      afterTaxTodayDollars: m.afterTax.afterTaxTodayDollars,
      totalConvertedTodayDollars: m.totals.totalConvertedTodayDollars,
      bracketRate: m.draft.spec.bracketRate,
    })),
  );
  return {
    kind: 'ok',
    candidates: measured.map((m) => {
      const position = order.indexOf(m.draft.spec.id);
      return finalizeCandidate(m, measured[0], position < 0 ? null : position + 1);
    }),
    rankedIds: order,
    window: { startYear: setup.window.startYear, endYear: setup.window.endYear },
    horizonYear: setup.prepared.ctx.horizonYear,
    leftoverTaxRate: request.leftoverTaxRate,
    deathAges: request.deathAges,
    projectionsRun,
  };
}

/** The zero-conversion projection the guards are held to; the current plan
 *  stands in for it only when it has no cap windows. */
async function baselineFor(
  referencePlan: PlannedProjection,
  setup: SearchSetup,
  runner: ProjectionRunner,
): Promise<PlannedProjection | null> {
  if (resolvedLadder(setup.prepared.ctx).length === 0) return referencePlan;
  const baseline = await runner.project([]);
  runner.tick(false);
  return baseline;
}

async function runSearch(
  request: RothSuggestionRequest,
  grid: readonly CandidateSpec[],
  runner: ProjectionRunner,
): Promise<RothSuggestionResult> {
  const setup = prepareSetup(request);
  if ('kind' in setup) return setup;
  const referencePlan = await runner.project(undefined, setup.prepared);
  if (referencePlan === null) return unsupported('no-projection');
  runner.tick(true);
  const baselinePlan = await baselineFor(referencePlan, setup, runner);
  if (baselinePlan === null) return unsupported('no-projection');
  const baselineRows = indexRows(baselinePlan.years);
  const env: PassEnvironment = {
    limitEnv: setup.limitEnv,
    targetRothAccountId: request.targetRothAccountId,
    windowYears: setup.years.map((y) => ({
      ...y,
      reference: referenceTiersFor(y.facts.year, baselineRows),
    })),
    runner,
  };
  const drafts: CandidateDraft[] = [referenceDraft(grid[0], referencePlan, setup)];
  for (const spec of grid.slice(1)) {
    const outcome = await searchLadderCandidate(spec, env);
    if (outcome === null) return unsupported('no-projection');
    drafts.push({
      spec,
      ladder: outcome.ladder,
      plan: outcome.plan,
      ...recordsFor(setup, outcome.plan, outcome.limits),
      unranked: outcome.unranked,
      passes: outcome.passes,
      converged: outcome.converged,
    });
  }
  return assembleResult(request, setup, drafts, runner.projectionsRun());
}

/**
 * Searches ladders for the selected scenario and ranks them on after-tax
 * ending balance in today's dollars.
 *
 * Resolves `unsupported` with a typed reason when the household has no valid
 * plan to search, `cancelled` (with no partial ranking) when the request's
 * `AbortSignal` aborts, and `error` for an engine failure the caller can show.
 *
 * @throws {RangeError} for a leftover tax rate outside [0, 1), a death age that
 *   is not a whole number of years, or an unknown scenario id.
 */
export async function searchRothSuggestions(
  request: RothSuggestionRequest,
): Promise<RothSuggestionResult> {
  validateRequest(request);
  const grid = buildCandidateGrid();
  const runner = createProjectionRunner(request, grid.length);
  try {
    return await runSearch(request, grid, runner);
  } catch (err) {
    if (err instanceof RothSuggestionCancelled) {
      return { kind: 'cancelled', projectionsRun: runner.projectionsRun() };
    }
    if (err instanceof MissingCustomDrawdownOrderError || err instanceof MagiCapCalibrationError) {
      return { kind: 'error', message: err.message };
    }
    throw err;
  }
}
