/**
 * `retivo_explain`: where one headline number comes from. For a metric it
 * returns the value and its basis, the resolved inputs that feed it (a pinned
 * metric-to-settings map, reported through the same reader as
 * `retivo_get_scenario`, so each carries its provenance and the defaults the
 * engine applied), the assumptions behind it and the math page that describes it.
 *
 * The Monte Carlo metrics are read from the result the page saved and never
 * computed here: with none, the value is null and the answer points at
 * `retivo_get_stress_test`.
 */
import type { ExplainMetric } from '@retirement/assistant-protocol';
import type { ScenarioOverrides } from '../../db/types';
import type { MonteCarloSummary } from '../../lib/monte-carlo';
import { defineTool, ToolArgsError, type ToolEnv } from './define';
import { deterministicAssumptions, healthAssumptionLines, taxTableNote } from './projection-assumptions';
import { assemblePlan, dollarsFor, headlineOf, requirePageResult, resolveScenarioArg, runPlan } from './projection-support';
import { reportScenarioSections } from './scenario-report';
import { NOT_COMPUTED, peekStressSummary } from './stress-cache';
import { monteCarloAssumptions } from './stress-figures';

type SettingKey = keyof ScenarioOverrides;

/** Settings that decide the household's timing, longevity and dollar basis in every projection. */
const TIMING = ['retirementAge', 'socialSecurity', 'lifeExpectancy', 'inflation'] as const satisfies readonly SettingKey[];
/** Settings that shape how money comes in and goes out. */
const CASHFLOW = ['income', 'expenses', 'discretionarySpending', 'contributions', 'accountContributions'] as const satisfies readonly SettingKey[];
/** Settings that decide how accounts grow. */
const GROWTH = ['accountReturns', 'accountAssetMix', 'retirementAllocation'] as const satisfies readonly SettingKey[];
/** Settings that decide which accounts are drawn on, in what order, and how the draw is taxed. */
const WITHDRAWAL = [
  'withdrawalStrategy',
  'customDrawdownOrder',
  'accountFloors',
  'magiCap',
  'filingStatus',
  'taxFilingPlan',
  'preRetirementRothConversions',
  'preRetirementRothConversionTaxRatePct',
  'qualifiedCharitableDistributions',
] as const satisfies readonly SettingKey[];

/** The resolved settings each metric rests on. Pinned by a test so a change is deliberate. */
export const METRIC_INPUT_KEYS = {
  ending_balance: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL],
  run_out_year: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL],
  // The retirement boundary comes before any withdrawal: only what grows and what goes in matters.
  portfolio_at_retirement: [
    'retirementAge',
    'inflation',
    ...CASHFLOW,
    ...GROWTH,
    'preRetirementRothConversions',
    'preRetirementRothConversionTaxRatePct',
    'preRetirementTaxableIncomeDollars',
  ],
  plan_success: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL, 'downturnGuardrails'],
  typical_ending_balance: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL, 'downturnGuardrails'],
  pessimistic_ending_balance: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL, 'downturnGuardrails'],
  bad_luck_ending_balance: [...TIMING, ...CASHFLOW, ...GROWTH, ...WITHDRAWAL, 'downturnGuardrails'],
} as const satisfies Record<ExplainMetric, readonly SettingKey[]>;

const MATH_PAGE = 'docs/math-projections.md';

/** The math page heading that describes each metric: what each number means for the deterministic ones, reading the result for the Monte Carlo ones. */
export const METRIC_DOCS = {
  ending_balance: { path: MATH_PAGE, heading: 'What each number means', alsoSee: 'Planned and Historical' },
  run_out_year: { path: MATH_PAGE, heading: 'What each number means', alsoSee: 'Planned and Historical' },
  portfolio_at_retirement: { path: MATH_PAGE, heading: 'What each number means', alsoSee: 'Planned and Historical' },
  plan_success: { path: MATH_PAGE, heading: 'Reading the result' },
  typical_ending_balance: { path: MATH_PAGE, heading: 'Reading the result' },
  pessimistic_ending_balance: { path: MATH_PAGE, heading: 'Reading the result' },
  bad_luck_ending_balance: { path: MATH_PAGE, heading: 'Reading the result' },
} as const satisfies Record<ExplainMetric, { path: string; heading: string; alsoSee?: string }>;

interface Reading {
  value: number | null;
  /** The same figure in today's dollars, for a nominal value. */
  valueTodayDollars?: number | null;
  /** What the value is, in a phrase. */
  unit: string;
  basis: string;
}

const STRESS_TIERS = {
  typical_ending_balance: { label: 'Typical', percentile: 50, pick: (s: MonteCarloSummary) => s.medianEndingBalanceReal },
  pessimistic_ending_balance: { label: 'Pessimistic', percentile: 25, pick: (s: MonteCarloSummary) => s.p25EndingBalanceReal },
  bad_luck_ending_balance: { label: 'Bad-luck', percentile: 10, pick: (s: MonteCarloSummary) => s.p10EndingBalanceReal },
} as const;

function isStressTier(metric: ExplainMetric): metric is keyof typeof STRESS_TIERS {
  return metric in STRESS_TIERS;
}

/** The settings behind the metric, each section reported with its provenance, plus a flat list of the defaults applied. */
function inputsFor(scenarioId: string, metric: ExplainMetric, env: ToolEnv) {
  if (!env.choices.scenarios) return { inputs: { omittedSections: ['scenarios'] }, defaultsApplied: [], assumptions: [] as string[] };
  const report = reportScenarioSections(scenarioId, env, METRIC_INPUT_KEYS[metric]);
  const defaultsApplied: Array<Record<string, unknown>> = [];
  for (const [key, section] of Object.entries(report.sections)) {
    if ('withheld' in section) continue;
    const reported = section;
    if (reported.source.kind === 'default') defaultsApplied.push({ setting: key, basis: reported.source.basis });
    for (const fill of reported.defaultsApplied ?? []) defaultsApplied.push({ setting: key, field: fill.field, value: fill.value, basis: fill.basis });
  }
  return { inputs: report.sections, defaultsApplied, assumptions: report.assumptions };
}

export const retivoExplain = defineTool('retivo_explain', async (args, env) => {
  const metric = args.metric as ExplainMetric;
  if (!Object.hasOwn(METRIC_DOCS, metric)) throw new ToolArgsError('That metric is not one retivo_explain knows.');
  const scenarioId = resolveScenarioArg(args.scenarioId, env);
  const dollars = dollarsFor(env);
  const { inputs, defaultsApplied, assumptions: inputAssumptions } = inputsFor(scenarioId, metric, env);

  let reading: Reading;
  let assumptions: string[];
  let stressTest: Record<string, unknown> | undefined;

  if (isStressTier(metric) || metric === 'plan_success') {
    const summary = await peekStressSummary(scenarioId, env);
    const tier = isStressTier(metric) ? STRESS_TIERS[metric] : null;
    if (summary === null) {
      reading = {
        value: null,
        unit: tier === null ? 'percent of simulated paths that never ran out' : "today's dollars",
        basis: NOT_COMPUTED.note,
      };
      stressTest = { ...NOT_COMPUTED, tool: 'retivo_get_stress_test' };
      assumptions = [...inputAssumptions];
    } else if (tier === null) {
      reading = {
        value: summary.successProbability * 100,
        unit: 'percent of simulated paths that never ran out',
        basis: `The share of ${summary.pathCount.toLocaleString('en-US')} simulated market histories in which the money lasted to the horizon, from the result the Balance Projection page saved.`,
      };
      stressTest = { source: 'cache', pathCount: summary.pathCount, seed: summary.seed, computedAt: new Date(summary.computedAt).toISOString() };
      assumptions = [...monteCarloAssumptions(summary), ...inputAssumptions];
    } else {
      reading = {
        value: dollars(tier.pick(summary)),
        unit: "today's dollars",
        basis: `The ${tier.label} tier: the ${tier.percentile}th percentile of ending balances across ${summary.pathCount.toLocaleString('en-US')} simulated market histories, in today's dollars, from the result the Balance Projection page saved.`,
      };
      stressTest = { source: 'cache', pathCount: summary.pathCount, seed: summary.seed, computedAt: new Date(summary.computedAt).toISOString() };
      assumptions = [...monteCarloAssumptions(summary), ...inputAssumptions];
    }
    if (summary !== null) assumptions.push(taxTableNote(env), ...healthAssumptionLines(assemblePlan(scenarioId, env).resolved, env));
  } else {
    const run = runPlan(scenarioId, env);
    const pageResult = requirePageResult(run);
    const headline = headlineOf(pageResult, 'planned');
    if (metric === 'ending_balance') {
      reading = {
        value: dollars(headline.endingBalanceTodayDollars),
        unit: "today's dollars",
        basis: `The Planned projection's balance at the horizon (${headline.horizonYear}), with inflation removed from the current month to that December. Empty when the projection has no rows.`,
      };
    } else if (metric === 'run_out_year') {
      reading = {
        value: headline.runOutYear,
        unit: 'calendar year; null means the money lasts to the horizon',
        basis: `The first year the Planned projection's withdrawals fall short of spending plus tax. The horizon is ${headline.horizonYear}.`,
      };
    } else {
      reading = {
        value: dollars(headline.portfolioAtRetirementNominal),
        valueTodayDollars: dollars(headline.portfolioAtRetirementTodayDollars),
        unit: `nominal dollars at the start of retirement (${headline.retirementYear})`,
        basis:
          'The portfolio the retirement years start from: every account that stays invested at the primary member\'s retirement date, grown to that date, excluding cash balance plan accounts elected as an annuity or a lump sum paid out.',
      };
    }
    assumptions = [...deterministicAssumptions(run, 'planned', env), ...inputAssumptions];
  }

  const doc = METRIC_DOCS[metric];
  return {
    data: {
      scenarioId,
      metric,
      value: reading.value,
      ...(reading.valueTodayDollars !== undefined && { valueTodayDollars: reading.valueTodayDollars }),
      unit: reading.unit,
      basis: reading.basis,
      ...(stressTest !== undefined && { stressTest }),
      inputs,
      defaultsApplied,
      doc: { path: doc.path, heading: doc.heading },
      ...('alsoSee' in doc && { alsoSee: { path: doc.path, heading: doc.alsoSee } }),
    },
    assumptions: [...new Set(assumptions)],
  };
});
