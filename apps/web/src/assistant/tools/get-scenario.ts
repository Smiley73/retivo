/**
 * `retivo_get_scenario`: one scenario's settings after inheritance, each with
 * where it came from, the scenario in the chain that set it or the default the
 * engine filled in. Values are read the way the engines read them (see
 * `scenario-sections.ts`) and then projected through the sharing field model, so
 * the consent switches, rounding and sanitizing apply to every one of them.
 * `scenario-report.ts` does the reading; this tool adds the scenario's own row.
 */
import { defineTool, ToolArgsError } from './define';
import { reportScenarioSections } from './scenario-report';

export const retivoGetScenario = defineTool('retivo_get_scenario', (args, env) => {
  const scenarioId = String(args.scenarioId);
  const { workspace, choices } = env;
  if (!workspace.scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new ToolArgsError('No scenario has that id. Use an id from retivo_list_scenarios.');
  }
  if (!choices.scenarios) return { data: { omittedSections: ['scenarios'] } };

  const { chain, rows, nameOf, sections, assumptions } = reportScenarioSections(scenarioId, env);
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
    assumptions,
  };
});
