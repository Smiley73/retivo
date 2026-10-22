/**
 * What the save-plan dialog says, as data: the plan being saved, and the cap
 * windows the save replaces and where they come from.
 */
import { isMagiCapDisabled, type MagiCapOverride } from '../../db/types';
import { scenarioChain, type ScenarioAggregate } from '../../lib/scenario-resolution';
import type { RothSuggestionRow } from './roth-suggestion-view-model';

export interface SavePlanSummary {
  /** The plan as the table names it, e.g. "Fill the 24% bracket, kept under both lines". */
  readonly label: string;
  readonly firstYear: number;
  readonly lastYear: number;
  readonly windowCount: number;
  readonly yearsConverted: number;
  /** Total converted in today's dollars, formatted. */
  readonly totalConverted: string;
  /** Years spending withdrawals were moved to a later account. */
  readonly reroutedYears: readonly number[];
  /** The Roth IRA the search converted into, from the ladder it ranked. */
  readonly targetRothId: string | null;
}

/** True for a row the dialog can save: a ranked plan of the search's own, not
 *  the current plan and not one whose cap was not met. */
export function canSaveRow(row: RothSuggestionRow): boolean {
  return !row.isReference && row.rank !== null && row.ladder.length > 0;
}

function yearOf(window: RothSuggestionRow['ladder'][number]): number {
  return window.start.kind === 'year' ? window.start.year : 0;
}

export function summarizeSavePlan(row: RothSuggestionRow): SavePlanSummary {
  const years = row.ladder.map(yearOf);
  return {
    label: row.detailLabel,
    firstYear: Math.min(...years),
    lastYear: Math.max(...years),
    windowCount: row.ladder.length,
    yearsConverted: row.yearsConverted,
    totalConverted: row.totalConverted,
    reroutedYears: row.reroutedYears,
    targetRothId: row.ladder[0]?.targetRothAccountId ?? null,
  };
}

export interface ReplacedCap {
  /** Windows in the scenario's resolved cap, which the save replaces. */
  readonly count: number;
  /** The nearest ancestor the cap comes from when the scenario has no cap of its own. */
  readonly inheritedFrom: string | null;
}

/**
 * The cap the save replaces; `resolvedCap` is the page's `parentCap`. The
 * inherited-from name is the nearest ancestor with a real cap, only when the
 * scenario has no cap of its own.
 */
export function describeReplacedCap(
  scenarios: readonly ScenarioAggregate[],
  scenarioId: string,
  resolvedCap: MagiCapOverride | undefined,
): ReplacedCap {
  const count = resolvedCap?.windows.length ?? 0;
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (count === 0 || scenario === undefined || scenario.payload.overrides.magiCap !== undefined) {
    return { count, inheritedFrom: null };
  }
  try {
    const chain = scenarioChain(scenarioId, [...scenarios]);
    for (let i = 1; i < chain.length; i += 1) {
      const cap = chain[i].payload.overrides.magiCap;
      if (cap !== undefined && !isMagiCapDisabled(cap)) {
        return { count, inheritedFrom: chain[i].payload.name };
      }
    }
  } catch {
    /* A broken parent chain only costs the parent's name in the copy. */
  }
  return { count, inheritedFrom: null };
}
