/**
 * Apply-flow helpers — prompt-message builder + confirm-dialog input
 * derivation + the `saveScenario` payload assembly. Extracted from
 * `ss-optimizer-page-helpers.ts` so that file stays under the ≤400-ln
 * shape limit. Pure compute — no React, no IO.
 */
import { mergeSsOverride } from '../lib/claim-age-optimizer';
import { memberLabel } from '../lib/expense-format';
import { resolveScenario } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import type {
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { ScenarioRow } from './ss-optimizer-page-chrome';

interface PromptArgs {
  primaryName: string;
  secondaryName: string | null;
  primaryAge: number;
  secondaryAge: number | null;
  scenarioName: string;
  secondaryPastWindow: boolean;
  secondaryMissingPia: boolean;
  primaryMissingPia: boolean;
}

function buildPromptMessage(args: PromptArgs): string {
  if (args.secondaryName === null) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} in scenario '${args.scenarioName}'? This overrides the current values.`;
  }
  if (args.secondaryPastWindow) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} in scenario '${args.scenarioName}'? (${args.secondaryName} is past the claim-age window, keeping their current setting.) This overrides the current values.`;
  }
  if (args.secondaryMissingPia) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} in scenario '${args.scenarioName}'? (${args.secondaryName} has no PIA recorded, keeping their current setting.) This overrides the current values.`;
  }
  if (args.primaryMissingPia) {
    return `Set ${args.secondaryName}'s claim age to ${args.secondaryAge ?? args.primaryAge} in scenario '${args.scenarioName}'? (${args.primaryName} has no PIA recorded, keeping their current setting.) This overrides the current values.`;
  }
  return `Set ${args.primaryName}'s claim age to ${args.primaryAge} and ${args.secondaryName}'s to ${args.secondaryAge ?? args.primaryAge} in scenario '${args.scenarioName}'? This overrides the current values.`;
}

export interface ApplyConfirmInputs {
  readonly row: ScenarioRow;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Deterministic tab passes `'planned'` or `'twr'` per-child Apply.
   *  When omitted, the helper reads `row.result` (legacy MC path). */
  readonly method?: ProjectionMethod;
}

export interface ApplyConfirmOutputs {
  readonly message: string;
  readonly winner: NonNullable<
    Extract<OptimizerWorkerOutbound, { kind: 'result' }>['winner']
  >;
  readonly hasSecondary: boolean;
  readonly secondaryPastWindow: boolean;
}

/**
 * Build the confirm-dialog message + the derived flags
 * `applyMergedOverride` needs. Returns `null` when the row isn't
 * apply-eligible (non-`result` kind, missing winner) so the caller
 * short-circuits. When `method` is supplied, the helper reads the
 * child slot `row.methods![method].result`.
 */
export function buildApplyConfirmArgs(
  inputs: ApplyConfirmInputs,
): ApplyConfirmOutputs | null {
  const { row, members, method } = inputs;
  const source: OptimizerWorkerOutbound | null =
    method && row.methods ? row.methods[method].result : row.result;
  if (source?.kind !== 'result') return null;
  const winner = source.winner;
  if (!winner) return null;
  const primaryMember = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  const primaryName = memberLabel(primaryMember, members, 'primary');
  const secondaryName = secondary
    ? memberLabel(secondary, members, 'secondary')
    : null;
  const secondaryMissingPia =
    secondary !== undefined &&
    source.missingPiaMembers.includes(secondary.id);
  const primaryMissingPia =
    primaryMember !== undefined &&
    source.missingPiaMembers.includes(primaryMember.id);
  const secondaryPastWindow =
    secondary !== undefined &&
    winner.secondaryAgeYears === null &&
    !secondaryMissingPia;
  const message = buildPromptMessage({
    primaryName,
    secondaryName,
    primaryAge: winner.primaryAgeYears,
    secondaryAge: winner.secondaryAgeYears,
    scenarioName: row.scenario.payload.name,
    secondaryPastWindow,
    secondaryMissingPia,
    primaryMissingPia,
  });
  return {
    message,
    winner,
    hasSecondary: secondary !== undefined,
    secondaryPastWindow,
  };
}

export interface ApplyMergedOverrideArgs {
  readonly row: ScenarioRow;
  readonly winner: ApplyConfirmOutputs['winner'];
  readonly hasSecondary: boolean;
  readonly secondaryPastWindow: boolean;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
}

/**
 * Build the new `ScenarioPayload` with the merged SS override
 * (`mergeSsOverride` preserves `benefitReductionPct` / `colaPct`).
 */
export function applyMergedOverride(
  args: ApplyMergedOverrideArgs,
): ScenarioPayload {
  const resolved = resolveScenario(args.row.scenario.id, [...args.scenarios]);
  const mergedSs = mergeSsOverride({
    currentResolvedOverride: resolved.socialSecurity,
    optimalPair: {
      primaryAgeYears: args.winner.primaryAgeYears,
      secondaryAgeYears: args.winner.secondaryAgeYears,
    },
    hasSecondary: args.hasSecondary,
    secondaryPastWindow: args.secondaryPastWindow,
  });
  return {
    ...args.row.scenario.payload,
    overrides: {
      ...args.row.scenario.payload.overrides,
      socialSecurity: mergedSs,
    },
  };
}
