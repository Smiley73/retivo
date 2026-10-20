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
import { formatAgeYearsMonths } from '../lib/format-age';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  ScenarioPayload,
} from '../db/types';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { ScenarioRow } from './ss-optimizer-page-chrome';
import { resolveCurrentClaimAges } from './ss-optimizer-row-view';

interface PromptArgs {
  primaryName: string;
  secondaryName: string | null;
  primaryAge: string;
  secondaryAge: string | null;
  scenarioName: string;
  secondaryPastWindow: boolean;
  secondaryMissingPia: boolean;
  primaryMissingPia: boolean;
  /** The winner's age for that member equals the stored one — Save
   *  leaves them as they are. */
  primaryUnchanged: boolean;
  secondaryUnchanged: boolean;
  /** Plain sentence naming each member whose stored months are being
   *  replaced; empty when nothing is. */
  replacedMonthsNote: string;
}

function buildPromptMessage(args: PromptArgs): string {
  const tail = `${args.replacedMonthsNote}This overrides the current values.`;
  const where = `in scenario '${args.scenarioName}'`;
  if (args.secondaryName === null) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} ${where}? ${tail}`;
  }
  if (args.secondaryPastWindow) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} ${where}? (${args.secondaryName} is past the claim-age window, keeping their current setting.) ${tail}`;
  }
  if (args.secondaryMissingPia) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} ${where}? (${args.secondaryName} has no PIA recorded, keeping their current setting.) ${tail}`;
  }
  const secondaryAge = args.secondaryAge ?? args.primaryAge;
  if (args.primaryMissingPia) {
    return `Set ${args.secondaryName}'s claim age to ${secondaryAge} ${where}? (${args.primaryName} has no PIA recorded, keeping their current setting.) ${tail}`;
  }
  if (args.primaryUnchanged) {
    return `Set ${args.secondaryName}'s claim age to ${secondaryAge} ${where}? (${args.primaryName} is already set to ${args.primaryAge}, keeping their current setting.) ${tail}`;
  }
  if (args.secondaryUnchanged) {
    return `Set ${args.primaryName}'s claim age to ${args.primaryAge} ${where}? (${args.secondaryName} is already set to ${secondaryAge}, keeping their current setting.) ${tail}`;
  }
  return `Set ${args.primaryName}'s claim age to ${args.primaryAge} and ${args.secondaryName}'s to ${secondaryAge} ${where}? ${tail}`;
}

type ClaimAge = RetirementAgePerMember | null;

function sameAge(
  current: ClaimAge,
  years: number | null,
  months: number | undefined,
): boolean {
  return (
    current !== null &&
    years !== null &&
    current.ageYears === years &&
    current.ageMonths === (months ?? 0)
  );
}

/** One sentence per member whose stored age carries months and is being
 *  replaced by a different age; empty when Save drops no months. */
function replacedMonthsNote(
  members: ReadonlyArray<{
    readonly name: string;
    readonly current: ClaimAge;
    readonly unchanged: boolean;
    readonly written: boolean;
  }>,
): string {
  return members
    .filter((m) => m.written && !m.unchanged && (m.current?.ageMonths ?? 0) > 0)
    .map(
      (m) =>
        `The months in ${m.name}'s current claim age (${formatClaimAge(m.current)}) are replaced. `,
    )
    .join('');
}

function formatClaimAge(age: ClaimAge): string {
  return age
    ? formatAgeYearsMonths({ years: age.ageYears, months: age.ageMonths })
    : '';
}

export interface ApplyConfirmInputs {
  readonly row: ScenarioRow;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Every scenario — the stored (current) claim ages resolve through the
   *  row's override chain. */
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
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
  const { row, members, scenarios, method } = inputs;
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
  const current = resolveCurrentClaimAges(row.scenario.id, scenarios);
  const primaryUnchanged = sameAge(
    current.primary,
    winner.primaryAgeYears,
    winner.primaryAgeMonths,
  );
  const secondaryUnchanged = sameAge(
    current.secondary,
    winner.secondaryAgeYears,
    winner.secondaryAgeMonths,
  );
  const message = buildPromptMessage({
    primaryName,
    secondaryName,
    primaryAge: formatAgeYearsMonths({
      years: winner.primaryAgeYears,
      months: winner.primaryAgeMonths ?? 0,
    }),
    secondaryAge:
      winner.secondaryAgeYears === null
        ? null
        : formatAgeYearsMonths({
            years: winner.secondaryAgeYears,
            months: winner.secondaryAgeMonths ?? 0,
          }),
    scenarioName: row.scenario.payload.name,
    secondaryPastWindow,
    secondaryMissingPia,
    primaryMissingPia,
    primaryUnchanged,
    secondaryUnchanged,
    replacedMonthsNote: replacedMonthsNote([
      {
        name: primaryName,
        current: current.primary,
        unchanged: primaryUnchanged,
        written: !primaryMissingPia,
      },
      {
        name: secondaryName ?? '',
        current: current.secondary,
        unchanged: secondaryUnchanged,
        written:
          secondaryName !== null &&
          winner.secondaryAgeYears !== null &&
          !secondaryPastWindow &&
          !secondaryMissingPia,
      },
    ]),
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
      primaryAgeMonths: args.winner.primaryAgeMonths,
      secondaryAgeYears: args.winner.secondaryAgeYears,
      secondaryAgeMonths: args.winner.secondaryAgeMonths,
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
