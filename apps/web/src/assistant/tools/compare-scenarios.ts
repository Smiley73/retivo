/**
 * `retivo_compare_scenarios`: how two scenarios relate, which of their resolved
 * settings differ, and how their planned outcomes differ, every difference as
 * `scenario - other`. Settings are compared the way the engines read them
 * (`scenario-sections.ts`: per-section resolvers, sparse expense and income
 * sections resolved item by item), so a scenario that re-sets an inherited
 * value differs from nothing. The compare map below is exhaustive over
 * `ScenarioOverrides`, so a new setting fails typecheck until it is labelled.
 *
 * It never runs a simulation: each side's stress test is read from what the
 * page already saved, and a side with none says so and names the tool that runs it.
 */
import type { ScenarioOverrides } from '../../db/types';
import { CbpUnconfiguredError, NoPrimaryRetirementError } from '../../lib/balance-projection-runner';
import { structurallyEqual } from '../../lib/structural-equality';
import { scenarioChain } from '../../lib/scenario-resolution';
import { defineTool, ToolArgsError, type ToolEnv } from './define';
import { rowAssumptions } from './projection-assumptions';
import { analysisRefusal, assemblePlan, dollarsFor, hasPlannedProjection, headlineOf, runPlan, type PlanRun } from './projection-support';
import { projectSection, sectionContextFor } from './scenario-report';
import { SCENARIO_SECTION_COVERAGE } from './scenario-sections';
import { NOT_COMPUTED, peekStressSummary } from './stress-cache';
import { stressHeadline } from './stress-figures';

/** The label each setting is reported under; exhaustive, so a new override key must be named here. */
const COMPARE_LABELS = {
  retirementAge: 'Retirement age',
  socialSecurity: 'Social Security',
  filingStatus: 'Filing status',
  taxFilingPlan: 'Tax filing plan',
  contributions: 'Future contributions',
  lifeExpectancy: 'Life expectancy',
  inflation: 'Inflation',
  discretionarySpending: 'Discretionary spending',
  downturnGuardrails: 'Spending guardrails',
  expenses: 'Expenses',
  income: 'Income',
  withdrawalStrategy: 'Withdrawal strategy',
  customDrawdownOrder: 'Custom drawdown order',
  magiCap: 'MAGI cap',
  retirementAllocation: 'Asset allocation',
  assumedCostBasisFractionOfTaxableWithdrawal: 'Taxable withdrawal cost basis',
  magiBootstrapLookbackMinus2: 'MAGI two years before retirement',
  magiBootstrapLookbackMinus1: 'MAGI one year before retirement',
  acaPtcBenchmark: 'ACA benchmark plan cost',
  accountContributions: 'Account contributions',
  accountReturns: 'Planned returns',
  accountAssetMix: 'Account asset mix',
  accountFloors: 'Account limits',
  hsaQualifiedMedicalExpensePct: 'HSA qualified medical share',
  earlyWithdrawalPenaltyExemptAccountIds: 'Early-withdrawal penalty exemptions',
  acaMarketplaceOptOutMemberIds: 'ACA Marketplace opt-outs',
  healthCoverageMonths: 'Medicare and Marketplace months',
  acaFplRegion: 'ACA poverty-guideline region',
  preRetirementRothConversions: 'Pre-retirement Roth conversions',
  preRetirementRothConversionTaxRatePct: 'Roth conversion tax rate',
  preRetirementTaxableIncomeDollars: 'Working-years taxable income',
  qualifiedCharitableDistributions: 'Charitable distributions (QCDs)',
} satisfies Record<keyof ScenarioOverrides, string>;

const COMPARE_KEYS = Object.keys(COMPARE_LABELS) as Array<keyof typeof COMPARE_LABELS>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A per-account setting names every account on both sides, and the whole map would drown the one account that
 * differs. When the two values differ only inside `perAccount`, keep the accounts that differ.
 */
function trimPerAccount(mine: unknown, theirs: unknown): { mine: unknown; theirs: unknown; trimmed: boolean } {
  if (!isRecord(mine) || !isRecord(theirs)) return { mine, theirs, trimmed: false };
  const mineAccounts = mine.perAccount;
  const theirAccounts = theirs.perAccount;
  if (!isRecord(mineAccounts) || !isRecord(theirAccounts)) return { mine, theirs, trimmed: false };
  const ids = new Set([...Object.keys(mineAccounts), ...Object.keys(theirAccounts)]);
  const differing = [...ids].filter((id) => !structurallyEqual(mineAccounts[id], theirAccounts[id]));
  const pick = (side: Record<string, unknown>, accounts: Record<string, unknown>) => ({
    ...side,
    perAccount: Object.fromEntries(differing.filter((id) => id in accounts).map((id) => [id, accounts[id]])),
  });
  return { mine: pick(mine, mineAccounts), theirs: pick(theirs, theirAccounts), trimmed: true };
}

type Relation =
  | { kind: 'same' }
  | { kind: 'descendant_of_other'; generations: number }
  | { kind: 'ancestor_of_other'; generations: number }
  | { kind: 'siblings'; parentId: string }
  | { kind: 'shares_ancestor'; ancestorId: string }
  | { kind: 'unrelated' };

/** How `scenarioId` relates to `otherId` along the inheritance chains. */
function relationOf(scenarioId: string, otherId: string, env: ToolEnv): Relation {
  if (scenarioId === otherId) return { kind: 'same' };
  const { scenarios } = env.workspace;
  const own = scenarioChain(scenarioId, scenarios).map((scenario) => scenario.id);
  const theirs = scenarioChain(otherId, scenarios).map((scenario) => scenario.id);
  const up = own.indexOf(otherId);
  if (up > 0) return { kind: 'descendant_of_other', generations: up };
  const down = theirs.indexOf(scenarioId);
  if (down > 0) return { kind: 'ancestor_of_other', generations: down };
  const sharedAt = own.findIndex((id, index) => index > 0 && theirs.includes(id));
  if (sharedAt === -1) return { kind: 'unrelated' };
  const ancestorId = own[sharedAt]!;
  return sharedAt === 1 && theirs.indexOf(ancestorId) === 1
    ? { kind: 'siblings', parentId: ancestorId }
    : { kind: 'shares_ancestor', ancestorId };
}

/** `scenario - other` when both exist, else `null` (one side has no such figure). */
export function signedDifference(scenario: number | null, other: number | null, round: (value: number | null) => number | null): number | null {
  if (scenario === null || other === null) return null;
  return round(scenario - other);
}

interface Outcomes {
  endingBalanceTodayDollars: number | null;
  runOutYear: number | null;
  horizonYear: number | null;
  portfolioAtRetirementNominal: number | null;
  portfolioAtRetirementTodayDollars: number | null;
}

/**
 * A side the page could not project reads as no outcomes, not as a failed comparison. That includes a run that
 * came back without a Planned projection (a cash balance plan account with no payout election), which is
 * normalised to `pageResult: null` so the outcomes, the availability flag and the row assumptions agree.
 */
function tryRunPlan(scenarioId: string, env: ToolEnv): PlanRun {
  try {
    const run = runPlan(scenarioId, env);
    return hasPlannedProjection(run.pageResult) ? run : { ...run, pageResult: null };
  } catch (error) {
    if (error instanceof NoPrimaryRetirementError || error instanceof CbpUnconfiguredError) {
      return { scenarioId, pageResult: null, assembly: assemblePlan(scenarioId, env) };
    }
    throw error;
  }
}

function outcomesOf(run: PlanRun): Outcomes {
  const { endingBalanceTodayDollars, runOutYear, horizonYear, portfolioAtRetirementNominal, portfolioAtRetirementTodayDollars } = headlineOf(
    run.pageResult,
    'planned',
  );
  return { endingBalanceTodayDollars, runOutYear, horizonYear, portfolioAtRetirementNominal, portfolioAtRetirementTodayDollars };
}

export const retivoCompareScenarios = defineTool('retivo_compare_scenarios', async (args, env) => {
  const scenarioId = String(args.scenarioId);
  const otherId = String(args.otherScenarioId);
  const { workspace } = env;
  for (const id of [scenarioId, otherId]) {
    if (!workspace.scenarios.some((scenario) => scenario.id === id)) {
      throw new ToolArgsError('No scenario has that id. Use an id from retivo_list_scenarios.');
    }
  }
  const refused = analysisRefusal(env, [scenarioId, otherId], true);
  if (refused !== null) return refused;

  const rows = new Map((env.view().scenarios ?? []).map((row) => [row.id, row]));
  const describe = (id: string) => {
    const name = rows.get(id)?.name;
    return { id, ...(typeof name === 'string' && { name }) };
  };

  // Resolved settings, as the engines read them.
  const contexts = { scenario: sectionContextFor(scenarioId, env), other: sectionContextFor(otherId, env) };
  const settings: Array<{ key: string; label: string; scenario: unknown; other: unknown; note?: string }> = [];
  for (const key of COMPARE_KEYS) {
    const rule = SCENARIO_SECTION_COVERAGE[key];
    const mine = rule.read(contexts.scenario).value;
    const theirs = rule.read(contexts.other).value;
    if (structurallyEqual(mine, theirs)) continue;
    const shown = trimPerAccount(mine, theirs);
    settings.push({
      key,
      label: COMPARE_LABELS[key],
      scenario: projectSection(key, shown.mine, env) ?? null,
      other: projectSection(key, shown.theirs, env) ?? null,
      ...(shown.trimmed && { note: 'Only the accounts that differ are listed.' }),
    });
  }

  // Planned outcomes and any saved stress test, per side.
  const dollars = dollarsFor(env);
  const runs = { scenario: tryRunPlan(scenarioId, env), other: tryRunPlan(otherId, env) };
  const outcomes = { scenario: outcomesOf(runs.scenario), other: outcomesOf(runs.other) };
  const stress = {
    scenario: await peekStressSummary(scenarioId, env),
    other: await peekStressSummary(otherId, env),
  };
  const side = (id: string, which: 'scenario' | 'other') => {
    const { runOutYear, horizonYear, endingBalanceTodayDollars, portfolioAtRetirementNominal, portfolioAtRetirementTodayDollars } = outcomes[which];
    const summary = stress[which];
    return {
      ...describe(id),
      plannedProjectionAvailable: hasPlannedProjection(runs[which].pageResult),
      endingBalanceTodayDollars: dollars(endingBalanceTodayDollars),
      runOutYear,
      horizonYear,
      portfolioAtRetirementNominal: dollars(portfolioAtRetirementNominal),
      portfolioAtRetirementTodayDollars: dollars(portfolioAtRetirementTodayDollars),
      stressTest: summary === null ? null : { source: 'cache', ...stressHeadline(summary, env) },
      ...(summary === null && NOT_COMPUTED),
    };
  };

  const a = outcomes.scenario;
  const b = outcomes.other;
  const years = [...(runs.scenario.pageResult?.planned?.years ?? []), ...(runs.other.pageResult?.planned?.years ?? [])];
  return {
    data: {
      scenario: side(scenarioId, 'scenario'),
      other: side(otherId, 'other'),
      relation: relationOf(scenarioId, otherId, env),
      settingDifferences: settings,
      outcomeDifferences: {
        endingBalanceTodayDollars: signedDifference(a.endingBalanceTodayDollars, b.endingBalanceTodayDollars, dollars),
        runOutYear: signedDifference(a.runOutYear, b.runOutYear, (value) => value),
        horizonYear: signedDifference(a.horizonYear, b.horizonYear, (value) => value),
        portfolioAtRetirementNominal: signedDifference(a.portfolioAtRetirementNominal, b.portfolioAtRetirementNominal, dollars),
        portfolioAtRetirementTodayDollars: signedDifference(
          a.portfolioAtRetirementTodayDollars,
          b.portfolioAtRetirementTodayDollars,
          dollars,
        ),
      },
    },
    assumptions: [
      'Every difference is the first scenario minus the second (scenario − other). A year difference is positive when the first is later. A difference is null when either side has no such figure, for example when only one side runs out of money.',
      "Outcomes are the Planned projection. Ending balance and portfolio at retirement (today's dollars) remove each scenario's own inflation from the current month; the nominal portfolio at retirement does not.",
      'Settings are compared as the engines resolve them, with defaults filled in, so a scenario that re-sets a value it inherits does not differ. The list names what differs, not why a result moved.',
      'Stress-test figures are read from the result the app already saved; none was computed for this call.',
      ...rowAssumptions(years, env),
    ],
  };
});
