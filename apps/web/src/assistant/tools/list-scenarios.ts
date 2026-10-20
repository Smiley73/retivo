/**
 * `retivo_list_scenarios`: every scenario with its id, name, parent and the
 * settings it changes itself. The rows come from the share view, so the whole
 * list is absent while the Scenarios switch is off, and a setting whose own
 * category is off is not named as changed.
 */
import type { ScenarioOverrides } from '../../db/types';
import { SCENARIO_CLASSIFICATION, type Classification } from '../sharing/classification';
import { defineTool } from './define';
import { SCENARIO_SECTION_KEYS } from './scenario-sections';

const OVERRIDE_FIELDS = (SCENARIO_CLASSIFICATION.overrides as Extract<Classification, { kind: 'object' }>).fields;

export const retivoListScenarios = defineTool('retivo_list_scenarios', (_args, env) => {
  const rows = env.view().scenarios;
  if (rows === undefined) return { data: { omittedSections: ['scenarios'] } };
  const stored = new Map(env.workspace.scenarios.map((scenario) => [scenario.id, scenario.payload.overrides]));
  const scenarios = rows
    .map((row) => {
      const overrides: ScenarioOverrides = stored.get(row.id) ?? {};
      // Only the keys the app defines, and only those whose category the person shares.
      const changes = SCENARIO_SECTION_KEYS.filter((key) => {
        const field = OVERRIDE_FIELDS[key];
        const gate = field?.kind === 'gated' ? field.category : undefined;
        return overrides[key] !== undefined && (gate === undefined || env.choices[gate]);
      });
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        parentScenarioId: row.parentScenarioId,
        isPrimary: row.isPrimary,
        changes,
      };
    })
    // The base scenario first, then by name, so the list reads the same on every call.
    .sort((a, b) => Number(b.isPrimary === true) - Number(a.isPrimary === true) || String(a.name).localeCompare(String(b.name)));
  return {
    data: { scenarios },
    assumptions: ['`changes` names the settings a scenario sets itself; everything else it inherits from its parent.'],
  };
});
