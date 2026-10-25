/**
 * `retivo_run_what_if`: the Planned projection headline for a stored scenario and for a what-if built from it,
 * side by side, the differences, and an echo of exactly which values changed from what. Optionally the Monte
 * Carlo summary for the what-if, computed in this tab under the stress-test tool's caps.
 *
 * The what-if exists only as an in-memory throwaway child of the base scenario, appended to a COPY of the
 * workspace's scenarios, so it inherits everything the base resolves and every engine entry point runs on it
 * unchanged. Nothing is written: not the scenario store, not the sync queue, not the Monte Carlo result cache
 * (it is neither read nor written), not the selected scenario. The shared snapshot is never mutated, so a
 * throwaway cannot leak into `retivo_list_scenarios` or into another call.
 */
import type { WhatIfOverrides } from '@retirement/assistant-protocol';
import type { ScenarioOverrides } from '../../db/types';
import type { RunBalanceProjectionPageResult } from '../../lib/balance-projection-runner';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { defineTool, PROJECTION_UNAVAILABLE_MESSAGE, ToolArgsError, ToolFailure, type ToolEnv } from './define';
import { signedDifference } from './compare-scenarios';
import { projectionRows } from './get-projection';
import { deterministicAssumptions } from './projection-assumptions';
import { dollarsFor, headlineOf, requireMethodSlice, requirePageResult, resolveScenarioArg, runPlan } from './projection-support';
import { gateOf, projectSection } from './scenario-report';
import { monteCarloInputFor } from './stress-cache';
import { STRESS_BASIS, monteCarloAssumptions, stressFigures } from './stress-figures';
import { stressRunner } from './stress-test';
import { buildWhatIf, getPath, setPath, type EchoChange, type EchoKept } from './what-if-overrides';

/** The fixed label the throwaway scenario carries; the agent supplies no text of its own. */
const WHAT_IF_LABEL = 'What-if (not saved)';

/** Said with every result: nothing was saved, and where the person makes it real. */
const NOT_SAVED_STATEMENT =
  'Nothing was saved. This what-if is not a scenario: it does not appear on the Scenarios page and is gone when this call ends. To make it real, the person creates it in Retivo (Planning, Scenarios, Create scenario, with the base scenario as the parent) and sets the same values; it cannot be done through the assistant.';

/** The throwaway child: every field the engines do not read is inert, so only the parent link and the overrides matter. */
function throwawayFor(base: ScenarioAggregate, overrides: ScenarioOverrides, now: Date): ScenarioAggregate {
  return {
    id: crypto.randomUUID(),
    householdId: base.householdId,
    schemaVersion: base.schemaVersion,
    version: 0,
    updatedAt: now.toISOString(),
    deviceId: 'what-if',
    aggregateType: 'scenario',
    payload: { name: WHAT_IF_LABEL, description: '', parentScenarioId: base.id, isPrimary: false, notes: '', overrides },
  };
}

/** `env` over a copy of the scenarios with `extra` appended; the caller's array is never touched. */
function withScenario(env: ToolEnv, extra: ScenarioAggregate): ToolEnv {
  return { ...env, workspace: { ...env.workspace, scenarios: [...env.workspace.scenarios, extra] } };
}

function headlineData(pageResult: RunBalanceProjectionPageResult, dollars: ReturnType<typeof dollarsFor>) {
  const headline = headlineOf(pageResult, 'planned');
  return {
    horizonYear: headline.horizonYear,
    retirementYear: headline.retirementYear,
    endingBalanceTodayDollars: dollars(headline.endingBalanceTodayDollars),
    runOutYear: headline.runOutYear,
    portfolioAtRetirementNominal: dollars(headline.portfolioAtRetirementNominal),
    portfolioAtRetirementTodayDollars: dollars(headline.portfolioAtRetirementTodayDollars),
  };
}

/** What-if minus base for each headline figure; a year is positive when the what-if's is later. */
function deltaOf(base: RunBalanceProjectionPageResult, whatIf: RunBalanceProjectionPageResult, dollars: ReturnType<typeof dollarsFor>) {
  const a = headlineOf(whatIf, 'planned');
  const b = headlineOf(base, 'planned');
  const years = (value: number | null) => value;
  return {
    basis: 'Each difference is the what-if minus the base scenario. A year difference is positive when the what-if’s year is later. A difference is null when either side has no such figure, for example when only one side runs out of money.',
    retirementYear: signedDifference(a.retirementYear, b.retirementYear, years),
    horizonYear: signedDifference(a.horizonYear, b.horizonYear, years),
    endingBalanceTodayDollars: signedDifference(a.endingBalanceTodayDollars, b.endingBalanceTodayDollars, dollars),
    runOutYear: signedDifference(a.runOutYear, b.runOutYear, years),
    portfolioAtRetirementNominal: signedDifference(a.portfolioAtRetirementNominal, b.portfolioAtRetirementNominal, dollars),
    portfolioAtRetirementTodayDollars: signedDifference(a.portfolioAtRetirementTodayDollars, b.portfolioAtRetirementTodayDollars, dollars),
  };
}

type LeafPath = readonly string[];

/** The path of a leaf inside its section, with an account's id in place for the generic `perAccount` segment. */
function nestedPath(path: string, accountId: string | undefined): LeafPath {
  const segments = path.split('.');
  return accountId === undefined ? segments : [segments[0]!, accountId, ...segments.slice(1)];
}

/** `value` after the sharing field model, or `undefined` when the model does not share it. */
function shared(section: EchoChange['section'], path: string, accountId: string | undefined, value: unknown, env: ToolEnv): unknown {
  const nested = nestedPath(path, accountId);
  return getPath(projectSection(section, setPath({}, nested, value), env), nested);
}

/**
 * The echo, through the field model: a section whose sharing switch is off is named and withheld, a value the
 * model will not share is withheld, and an account is named only when the accounts switch lets its name out.
 */
function echoOf(changes: readonly EchoChange[], kept: readonly EchoKept[], env: ToolEnv) {
  const accountNames = new Map((env.view().accounts ?? []).map((row) => [String(row.id), row.name]));
  const withheldSections: Array<{ section: string; switch: string }> = [];
  const open = (section: EchoChange['section']): boolean => {
    const gate = gateOf(section);
    if (gate === undefined || env.choices[gate]) return true;
    if (!withheldSections.some((entry) => entry.section === section)) withheldSections.push({ section, switch: gate });
    return false;
  };
  const accountFields = (accountId: string | undefined) =>
    accountId === undefined ? {} : { accountId, ...(accountNames.has(accountId) && { accountName: accountNames.get(accountId) }) };

  const changeRows = changes
    .filter((change) => open(change.section))
    .map((change) => {
      const setting = `${change.section}.${change.path}`;
      const previous = shared(change.section, change.path, change.accountId, change.previous, env);
      const next = shared(change.section, change.path, change.accountId, change.new, env);
      if (previous === undefined || next === undefined) return { setting, withheld: true, ...accountFields(change.accountId) };
      return {
        setting,
        ...accountFields(change.accountId),
        previous,
        previousSource: change.previousSource,
        ...(change.basis !== undefined && { previousBasis: change.basis }),
        new: next,
        changed: change.changed,
        ...(change.derived !== undefined && { followsFrom: change.derived }),
      };
    });
  const keptRows = kept
    .filter((entry) => open(entry.section))
    .flatMap((entry) => {
      const value = shared(entry.section, entry.path, entry.accountId, entry.value, env);
      if (value === undefined) return [];
      return [
        {
          setting: `${entry.section}.${entry.path}`,
          ...accountFields(entry.accountId),
          value,
          source: entry.source,
          ...(entry.basis !== undefined && { basis: entry.basis }),
        },
      ];
    });
  return {
    changes: changeRows,
    unchangedInTheseSections: keptRows,
    ...(withheldSections.length > 0 && { withheldSections }),
  };
}

export const retivoRunWhatIf = defineTool('retivo_run_what_if', async (args, env) => {
  const baseId = resolveScenarioArg(args.baseScenarioId, env);
  if (!env.choices.scenarios) return { data: { omittedSections: ['scenarios'] } };
  const from = typeof args.fromYear === 'number' ? args.fromYear : undefined;
  const to = typeof args.toYear === 'number' ? args.toYear : undefined;
  if (from !== undefined && to !== undefined && from > to) throw new ToolArgsError('fromYear is after toYear.');

  const built = buildWhatIf(baseId, args.overrides as WhatIfOverrides, env);
  const base = env.workspace.scenarios.find((scenario) => scenario.id === baseId)!;
  const throwaway = throwawayFor(base, built.overrides, env.now);
  const whatIfEnv = withScenario(env, throwaway);

  const baseRun = runPlan(baseId, env);
  const basePage = requirePageResult(baseRun);
  const baseSlice = requireMethodSlice(basePage, 'planned');
  const whatIfRun = runPlan(throwaway.id, whatIfEnv);
  const whatIfPage = requirePageResult(whatIfRun);
  const whatIfSlice = requireMethodSlice(whatIfPage, 'planned');

  const dollars = dollarsFor(env);
  const baseName = env.view().scenarios?.find((row) => row.id === baseId)?.name;
  const wantRows = from !== undefined || to !== undefined;

  let stress: ReturnType<typeof stressFigures> | undefined;
  let monteCarloNotes: string[] = [];
  if (args.stressTest === true) {
    const input = monteCarloInputFor(throwaway.id, whatIfEnv, stressRunner.pathCount);
    if (input === null) throw new ToolFailure('INVALID_ARGS', PROJECTION_UNAVAILABLE_MESSAGE);
    // Always computed: the saved results are neither read nor written, so a what-if cannot meet or leave an entry.
    const summary = await stressRunner.run(input, env);
    stress = stressFigures(summary, env);
    monteCarloNotes = monteCarloAssumptions(summary);
  }

  return {
    data: {
      saved: false,
      statement: NOT_SAVED_STATEMENT,
      base: { scenarioId: baseId, ...(typeof baseName === 'string' && { name: baseName }), headline: headlineData(basePage, dollars) },
      whatIf: { label: WHAT_IF_LABEL, headline: headlineData(whatIfPage, dollars) },
      difference: deltaOf(basePage, whatIfPage, dollars),
      echo: echoOf(built.changes, built.kept, env),
      ...(wantRows && {
        years: {
          base: projectionRows(basePage, baseSlice, from, to, dollars),
          whatIf: projectionRows(whatIfPage, whatIfSlice, from, to, dollars),
        },
      }),
      ...(stress !== undefined && {
        stressTest: {
          source: 'computed',
          sourceNote: `Computed now in the open tab for the what-if only, with ${stress.pathCount.toLocaleString('en-US')} paths. Nothing was saved, and no saved stress-test result was read or changed.`,
          basis: STRESS_BASIS,
          ...stress,
        },
      }),
    },
    assumptions: [
      ...new Set([
        'The what-if starts from the base scenario and changes only the settings in the echo; everything else is inherited from the base as it resolves today. Both sides are the Planned projection.',
        ...built.notes,
        ...deterministicAssumptions(whatIfRun, 'planned', whatIfEnv),
        ...monteCarloNotes,
      ]),
    ],
  };
});
