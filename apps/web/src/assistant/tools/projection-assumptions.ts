/**
 * The assumptions a deterministic reading rests on, said in sentences the
 * envelope carries beside the numbers: how each method grows an account, which
 * tax table year applied and whether any projected year scaled it forward, the
 * flags the engine stamps on the rows, the defaults it filled in, and the health
 * coverage wording the Report uses. Everything here is read from the run or from
 * a constant the engine imports, never restated as a literal.
 */
import type { ProjectionMethod } from '@retirement/assistant-protocol';
import type { ScenarioOverrides } from '../../db/types';
import type { DrawdownYear } from '../../lib/drawdown-engine';
import { buildHealthAssumptions } from '../../lib/report-data';
import type { ToolEnv } from './define';
import { taxTableFacts } from './facts';
import type { PlanRun } from './projection-support';
import { methodSlice } from './projection-support';
import { reportScenarioSections } from './scenario-report';

/** The settings whose engine defaults decide the horizon, the retirement date and the dollar basis. */
const DEFAULT_SOURCE_KEYS = ['retirementAge', 'socialSecurity', 'lifeExpectancy', 'inflation'] as const;

/** One line per default the engine applied among the settings every projection rests on. */
export function inputDefaultAssumptions(scenarioId: string, env: ToolEnv): string[] {
  return reportScenarioSections(scenarioId, env, DEFAULT_SOURCE_KEYS).assumptions;
}

/** The standing health-coverage sentences; the lines that name stated years only while the scenario's settings are shared. */
export function healthAssumptionLines(resolved: ScenarioOverrides, env: ToolEnv): string[] {
  const health = buildHealthAssumptions(resolved, env.workspace.members);
  const lines = [`Poverty guidelines used for the Marketplace subsidy: ${health.povertyGuidelines}.`, ...health.disclosures];
  if (env.choices.scenarios) lines.push(health.benchmarkPrice, health.coverageMonths);
  return lines.map((line) => `Health coverage: ${line}`);
}

/** How many of `years` carry the flag `pick` reads. */
function countFlag(years: ReadonlyArray<DrawdownYear>, pick: (year: DrawdownYear) => boolean | undefined): number {
  return years.filter((year) => pick(year) === true).length;
}

function methodAssumption(run: PlanRun, method: ProjectionMethod): string {
  if (method === 'planned') {
    return 'Planned: every account grows at the return planned for it, in every year.';
  }
  const fallbacks = run.pageResult?.sharedCtx.fallbackAccounts.length ?? 0;
  return (
    'Historical: every account grows at the yearly rate it actually earned in its balance history; that is a record, not a forecast. ' +
    (fallbacks === 0
      ? 'Every account has a measured rate.'
      : `${fallbacks} account${fallbacks === 1 ? ' has' : 's have'} no measured rate and grow${fallbacks === 1 ? 's' : ''} at the planned rate.`)
  );
}

/** The tax-table sentence for a reading that has no rows to inspect (a simulation): the tables end somewhere and later years scale forward. */
export function taxTableNote(env: ToolEnv): string {
  const tables = taxTableFacts(env.now.getFullYear());
  return `Tax tables: the built-in federal tables run through ${tables.year}; a projected year after that scales the ${tables.year} table forward.`;
}

/** Tax-table and engine-flag sentences for the rows a reading is based on. */
export function rowAssumptions(years: ReadonlyArray<DrawdownYear>, env: ToolEnv): string[] {
  const tables = taxTableFacts(env.now.getFullYear());
  const lines: string[] = [];
  const extrapolated = countFlag(years, (year) => year.taxYearExtrapolated);
  if (extrapolated > 0) {
    lines.push(
      `Tax tables: the built-in federal tables run through ${tables.year}. ${extrapolated} of ${years.length} projected years are later than that and scale the ${tables.year} table forward (taxYearExtrapolated).`,
    );
  } else if (years.length > 0) {
    lines.push(`Tax tables: every projected year uses a built-in federal table; the newest covers ${tables.year}.`);
  } else {
    lines.push(taxTableNote(env));
  }
  const estimated = countFlag(years, (year) => year.magiEstimatedFromProjection);
  if (estimated > 0) {
    lines.push(
      `Medicare surcharge look-back: for ${estimated} projected year${estimated === 1 ? '' : 's'} the income two years earlier was estimated from the projection's own first-year income, because none was recorded (magiEstimatedFromProjection).`,
    );
  }
  return lines;
}

/** Everything a reading of `method`'s rows rests on, with the scenario's defaults. */
export function deterministicAssumptions(run: PlanRun, method: ProjectionMethod, env: ToolEnv): string[] {
  const years = methodSlice(run.pageResult, method)?.years ?? [];
  return [
    methodAssumption(run, method),
    "Today's-dollar figures divide each nominal amount by the scenario's inflation compounded from the current month to December of that year.",
    ...rowAssumptions(years, env),
    ...inputDefaultAssumptions(run.scenarioId, env),
    ...healthAssumptionLines(run.assembly.resolved, env),
  ];
}
