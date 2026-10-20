/**
 * One scenario's resolved sections with provenance, built once for every tool that
 * reports scenario inputs (`retivo_get_scenario`, `retivo_explain`,
 * `retivo_compare_scenarios`). Each section is read the way the engines read it (see
 * `scenario-sections.ts`), says where its value came from (the nearest scenario in the chain
 * that sets it, an engine default, or nothing) and is projected through the sharing field
 * model, so the consent switches, rounding and sanitizing apply to every value.
 */
import type { ScenarioOverrides } from '../../db/types';
import { medicalCategoryIdsFrom } from '../../lib/expense-category-resolvers';
import { resolveScenario, scenarioChain, type ScenarioAggregate } from '../../lib/scenario-resolution';
import { SCENARIO_CLASSIFICATION, type Classification } from '../sharing/classification';
import { projectPayload } from '../sharing/project';
import type { SharingCategoryId } from '../sharing/switches';
import type { ToolEnv } from './define';
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
export function gateOf(key: keyof ScenarioOverrides): SharingCategoryId | undefined {
  const classification = OVERRIDE_FIELDS[key];
  return classification?.kind === 'gated' ? classification.category : undefined;
}

/** `value` of setting `key` after the field model: gated, rounded, sanitized. `undefined` when the model shares nothing. */
export function projectSection(key: keyof ScenarioOverrides, value: unknown, env: ToolEnv): unknown {
  const field = OVERRIDE_FIELDS[key];
  if (field === undefined) return undefined;
  return projectPayload({ [key]: value }, { [key]: field }, { choices: env.choices, masker: env.masker })[key];
}

export interface ScenarioReport {
  /** The scenario and its ancestors, nearest first. */
  chain: ScenarioAggregate[];
  /** The share view's row per scenario id; empty while the Scenarios switch is off. */
  rows: Map<string, Record<string, unknown>>;
  nameOf(id: string): string | undefined;
  sections: Record<string, ReportedSection | WithheldSection>;
  /** One line per default the engine applied among `sections`, with its basis. */
  assumptions: string[];
}

/** The section context both the reporter and the compare tool read a scenario's settings through. */
export function sectionContextFor(scenarioId: string, env: ToolEnv): SectionContext {
  const { workspace } = env;
  return {
    scenarioId,
    scenarios: workspace.scenarios,
    chain: scenarioChain(scenarioId, workspace.scenarios),
    merged: resolveScenario(scenarioId, workspace.scenarios),
    members: workspace.members,
    accounts: workspace.accounts,
    medicalCategoryIds: medicalCategoryIdsFrom([...workspace.categories]),
    todayYear: env.now.getFullYear(),
  };
}

/** Reports `keys` (every setting by default) of scenario `scenarioId`, which must exist in the workspace. */
export function reportScenarioSections(
  scenarioId: string,
  env: ToolEnv,
  keys: readonly (keyof ScenarioOverrides)[] = SCENARIO_SECTION_KEYS,
): ScenarioReport {
  const { choices } = env;
  const rows = new Map((env.view().scenarios ?? []).map((row) => [row.id, row as Record<string, unknown>]));
  const context = sectionContextFor(scenarioId, env);
  const { chain } = context;
  const nameOf = (id: string): string | undefined => {
    const name = rows.get(id)?.name;
    return typeof name === 'string' ? name : undefined;
  };

  const sections: Record<string, ReportedSection | WithheldSection> = {};
  const assumptions: string[] = [];
  for (const key of keys) {
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
  return { chain, rows, nameOf, sections, assumptions: [...new Set(assumptions)] };
}
