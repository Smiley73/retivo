/**
 * `retivo_get_scenario`: one scenario's settings after inheritance, each with
 * where it came from, the scenario in the chain that set it or the default the
 * engine filled in. Values are read the way the engines read them (see
 * `scenario-sections.ts`) and then projected through the sharing field model, so
 * the consent switches, rounding and sanitizing apply to every one of them.
 */
import type { ScenarioOverrides } from '../../db/types';
import { medicalCategoryIdsFrom } from '../../lib/expense-category-resolvers';
import { resolveScenario, scenarioChain, type ScenarioAggregate } from '../../lib/scenario-resolution';
import { SCENARIO_CLASSIFICATION, type Classification } from '../sharing/classification';
import { projectPayload } from '../sharing/project';
import type { SharingCategoryId } from '../sharing/switches';
import { defineTool, ToolArgsError, type ToolEnv } from './define';
import {
  SCENARIO_SECTION_COVERAGE,
  SCENARIO_SECTION_KEYS,
  type DefaultApplied,
  type SectionContext,
  type SectionRule,
} from './scenario-sections';

const OVERRIDE_FIELDS = (SCENARIO_CLASSIFICATION.overrides as Extract<Classification, { kind: 'object' }>).fields;

type Source =
  | { kind: 'scenario'; scenarioId: string; scenarioName?: string }
  | { kind: 'default'; basis: string }
  | { kind: 'not-set'; note: string };

interface ReportedSection {
  source: Source;
  /** Every scenario in the chain that sets the section, nearest first. */
  setBy?: string[];
  value?: unknown;
  defaultsApplied?: DefaultApplied[];
  effective?: string;
}

interface WithheldSection {
  withheld: true;
  /** The sharing switch that is off. */
  switch: string;
}

/** The category whose switch gates a section, when the field model gates it. */
function gateOf(key: keyof ScenarioOverrides): SharingCategoryId | undefined {
  const classification = OVERRIDE_FIELDS[key];
  return classification?.kind === 'gated' ? classification.category : undefined;
}

function projectSection(key: keyof ScenarioOverrides, value: unknown, env: ToolEnv): unknown {
  const field = OVERRIDE_FIELDS[key];
  if (field === undefined) return undefined;
  return projectPayload({ [key]: value }, { [key]: field }, { choices: env.choices, masker: env.masker })[key];
}

export const retivoGetScenario = defineTool('retivo_get_scenario', (args, env) => {
  const scenarioId = String(args.scenarioId);
  const { workspace, choices } = env;
  if (!workspace.scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new ToolArgsError('No scenario has that id. Use an id from retivo_list_scenarios.');
  }
  if (!choices.scenarios) return { data: { omittedSections: ['scenarios'] } };

  const rows = new Map((env.view().scenarios ?? []).map((row) => [row.id, row]));
  const chain: ScenarioAggregate[] = scenarioChain(scenarioId, workspace.scenarios);
  const context: SectionContext = {
    scenarioId,
    scenarios: workspace.scenarios,
    chain,
    merged: resolveScenario(scenarioId, workspace.scenarios),
    members: workspace.members,
    accounts: workspace.accounts,
    medicalCategoryIds: medicalCategoryIdsFrom([...workspace.categories]),
    todayYear: env.now.getFullYear(),
  };
  const nameOf = (id: string): string | undefined => {
    const name = rows.get(id)?.name;
    return typeof name === 'string' ? name : undefined;
  };

  const sections: Record<string, ReportedSection | WithheldSection> = {};
  const assumptions: string[] = [];
  for (const key of SCENARIO_SECTION_KEYS) {
    const gate = gateOf(key);
    if (gate !== undefined && !choices[gate]) {
      sections[key] = { withheld: true, switch: gate };
      continue;
    }
    const rule: SectionRule = SCENARIO_SECTION_COVERAGE[key];
    const reading = rule.read(context);
    const setBy = chain.filter((scenario) => scenario.payload.overrides[key] !== undefined).map((scenario) => scenario.id);
    const first = setBy[0];
    let source: Source;
    if (first !== undefined) {
      const scenarioName = nameOf(first);
      source = { kind: 'scenario', scenarioId: first, ...(scenarioName !== undefined && { scenarioName }) };
    } else if (reading.defaultBasis !== undefined) {
      source = { kind: 'default', basis: reading.defaultBasis };
    } else {
      source = { kind: 'not-set', note: rule.whenUnset };
    }
    const reportsValue = first !== undefined || reading.defaultBasis !== undefined;
    const value = reportsValue ? projectSection(key, reading.value, env) : undefined;
    const fills = reading.fills ?? [];
    sections[key] = {
      source,
      ...(setBy.length > 0 && { setBy }),
      ...(value !== undefined && { value }),
      ...(fills.length > 0 && { defaultsApplied: fills }),
      ...(reading.effective !== undefined && { effective: reading.effective }),
    };
    if (source.kind === 'default') assumptions.push(`${key}: ${source.basis}`);
    for (const fill of fills) assumptions.push(`${key}.${fill.field}: ${fill.basis}`);
  }

  const row = rows.get(scenarioId);
  return {
    data: {
      scenario: {
        id: scenarioId,
        ...(row === undefined
          ? {}
          : { name: row.name, description: row.description, notes: row.notes, parentScenarioId: row.parentScenarioId, isPrimary: row.isPrimary }),
        inheritsFrom: chain.slice(1).map((ancestor) => ({ id: ancestor.id, name: nameOf(ancestor.id) })),
      },
      sections,
    },
    assumptions: [...new Set(assumptions)],
  };
});
