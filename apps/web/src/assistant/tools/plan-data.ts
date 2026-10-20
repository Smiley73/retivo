/**
 * `retivo_get_plan_data`: the plan as recorded, one part at a time. Every part
 * comes from the share view, so it is present only while its consent switch is
 * on; a part that is off is left out whole and named in `omittedSections`.
 */
import { PLAN_DATA_SECTIONS, type PlanDataSection } from '@retirement/assistant-protocol';
import { defineTool } from './define';
import { localDateIso } from './facts';

function sectionsOf(args: Record<string, unknown>): PlanDataSection[] {
  const requested = Array.isArray(args.sections) ? (args.sections as PlanDataSection[]) : [...PLAN_DATA_SECTIONS];
  // In the order the registry lists them, each once.
  return PLAN_DATA_SECTIONS.filter((section) => requested.includes(section));
}

export const retivoGetPlanData = defineTool('retivo_get_plan_data', (args, env) => {
  const view = env.view();
  const data: Record<string, unknown> = {};
  const omittedSections: PlanDataSection[] = [];
  for (const section of sectionsOf(args)) {
    const part = view[section];
    if (part === undefined) omittedSections.push(section);
    else data[section] = part;
  }
  if (omittedSections.length > 0) data.omittedSections = omittedSections;
  return {
    data,
    assumptions: [
      'Figures are what the person recorded in the plan. Nothing here is projected or estimated.',
      `Ages are whole years on ${localDateIso(env.now)}.`,
    ],
  };
});
