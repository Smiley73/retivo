// Deterministic claim-age optimizer Web Worker: runs `optimiseClaimAgesForScenario` over raw aggregates and posts the winner.
// Tests drive `registerOptimizerWorkerListener` against a fake `self` (see the brand-check guard at the bottom).
import {
  optimiseClaimAgesForScenario,
  type OptimizerResult,
} from '../lib/claim-age-optimizer';
import {
  detectUnsupportedScenarioFeatures,
  type UnsupportedScenarioReason,
} from '../lib/optimizer-unsupported';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

// Raw aggregates are forwarded, not a prebuilt SS slice: the SS-dependent slice is rebuilt per candidate and the
// overlay applies on top of the resolved chain.
export interface OptimizerWorkerInput {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /**
   * Flag-derived medical category ids, so the +2pp medical-inflation default follows the `isMedical` flag (a recreated
   * medical category must not diverge from the legacy default); a structured-clone-safe array.
   */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  /** Serialised today timestamp; the worker reconstructs `new Date(iso)`. */
  readonly todayIso: string;
  /**
   * Defaults to `'planned'`; the deterministic page posts one message per method per scenario and groups the two
   * replies under one row.
   */
  readonly projectionMethod?: ProjectionMethod;
}

/**
 * `runId` correlates one dispatch round-trip: the page effect can re-run mid-flight (aggregates change via
 * WORKSPACE_CHANGED_EVENT or cross-tab sync) and a second listener would otherwise match the previous run's reply by
 * `scenarioId` alone.
 */
export type OptimizerWorkerInbound = {
  kind: 'run';
  runId: string;
  input: OptimizerWorkerInput;
};

export type OptimizerWorkerOutbound =
  | {
      kind: 'result';
      runId: string;
      scenarioId: string;
      winner: OptimizerResult['winner'];
      partial: boolean;
      missingPiaMembers: ReadonlyArray<string>;
      /**
       * Metric value at the scenario's current claim ages (the "current -> recommended" cell); `undefined` when that
       * pair isn't a whole-year grid candidate.
       */
      baselineMetricValue?: number;
      /** Disclosure only: assumed fixed primary death age. */
      assumedDeathAge?: number;
    }
  | {
      kind: 'empty';
      runId: string;
      scenarioId: string;
      reason: 'no-primary-member' | 'no-retirement-date';
    }
  | {
      kind: 'unsupported';
      runId: string;
      scenarioId: string;
      reason: UnsupportedScenarioReason;
    }
  | {
      /**
       * `projectionMethod: 'twr'` but an active non-CBP account has < 2 yr of balance history. A separate kind so only
       * the TWR child row shows "Insufficient history" while the Planned row still resolves.
       */
      kind: 'twr-insufficient';
      runId: string;
      scenarioId: string;
    }
  | { kind: 'error'; runId: string; scenarioId: string; message: string };

export async function runOptimizerForScenario(
  runId: string,
  input: OptimizerWorkerInput,
): Promise<OptimizerWorkerOutbound> {
  const today = new Date(input.todayIso);
  const scenario = input.scenarios.find((s) => s.id === input.scenarioId);
  if (!scenario) {
    return {
      kind: 'error',
      runId,
      scenarioId: input.scenarioId,
      message: `Unknown scenario id: ${input.scenarioId}`,
    };
  }
  // Defence in depth: an unresolved CBP election surfaces the Unsupported callout at once instead of spending a full
  // BPP run (the runner also throws on unconfigured CBP).
  const unsupported = detectUnsupportedScenarioFeatures({
    scenario,
    scenarios: input.scenarios,
    accounts: input.accounts,
    incomeStreams: input.incomeStreams,
  });
  if (unsupported !== null) {
    return {
      kind: 'unsupported',
      runId,
      scenarioId: input.scenarioId,
      reason: unsupported,
    };
  }
  // Empty state: no primary, or no resolvable primary retirement date.
  const primary = input.members.find((m) => m.payload.isPrimary);
  if (!primary) {
    return {
      kind: 'empty',
      runId,
      scenarioId: input.scenarioId,
      reason: 'no-primary-member',
    };
  }
  if (!hasResolvableRetirementDate(primary)) {
    return {
      kind: 'empty',
      runId,
      scenarioId: input.scenarioId,
      reason: 'no-retirement-date',
    };
  }
  // The birthdate shape check isn't sufficient: a scenario with no `retirementAge` override anywhere in the chain also
  // has no retirement date.
  if (!hasResolvedRetirementDate(scenario, input)) {
    return {
      kind: 'empty',
      runId,
      scenarioId: input.scenarioId,
      reason: 'no-retirement-date',
    };
  }
  const result = await optimiseClaimAgesForScenario({
    scenario,
    scenarios: input.scenarios,
    accounts: input.accounts,
    balances: input.balances,
    members: input.members,
    ssBenefits: input.ssBenefits,
    expenses: input.expenses,
    incomeStreams: input.incomeStreams,
    medicalCategoryIds: input.medicalCategoryIds,
    metric: 'balance',
    projectionMethod: input.projectionMethod ?? 'planned',
    today,
  });
  if (result.twrInsufficient === true) {
    return {
      kind: 'twr-insufficient',
      runId,
      scenarioId: input.scenarioId,
    };
  }
  return {
    kind: 'result',
    runId,
    scenarioId: input.scenarioId,
    winner: result.winner,
    partial: result.partial,
    missingPiaMembers: result.missingPiaMembers,
    baselineMetricValue: result.baselineMetricValue,
  };
}

function hasResolvableRetirementDate(
  primary: Aggregate<HouseholdMemberPayload>,
): boolean {
  const iso = primary.payload.birthdate;
  if (!iso || iso.length < 10) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return (
    Number.isFinite(y) &&
    Number.isFinite(m) &&
    Number.isFinite(d) &&
    y > 1800 &&
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= 31
  );
}

// A valid birthdate isn't enough: a scenario with no `retirementAge` override (own or inherited) has no resolvable
// primary retirement date. Surface it as the same `no-retirement-date` empty variant, for the page's "Set a primary
// retirement age…" copy, instead of the runner throwing `NoPrimaryRetirementError` into an ErrorRow.
function hasResolvedRetirementDate(
  scenario: ScenarioAggregate,
  input: OptimizerWorkerInput,
): boolean {
  const resolved = resolveScenario(scenario.id, [...input.scenarios]);
  const dates = resolveMemberRetirementDates(
    resolved.retirementAge,
    input.members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate ?? '',
    })),
  );
  const primary = input.members.find((m) => m.payload.isPrimary);
  if (!primary) return false;
  return (dates.get(primary.id) ?? null) !== null;
}

/** Registers the worker's message listener on a target global; exported so tests can drive it against a fake `self`. */
export function registerOptimizerWorkerListener(
  target: { addEventListener: typeof self.addEventListener; postMessage: typeof self.postMessage },
): void {
  target.addEventListener('message', (ev: Event) => {
    const messageEv = ev as MessageEvent<OptimizerWorkerInbound>;
    const msg = messageEv.data;
    if (!msg || msg.kind !== 'run') return;
    void runOptimizerForScenario(msg.runId, msg.input)
      .then((out) => {
        target.postMessage(out);
      })
      .catch((e: unknown) => {
        const err = e as Error;
        const out: OptimizerWorkerOutbound = {
          kind: 'error',
          runId: msg.runId,
          scenarioId: msg.input.scenarioId,
          message: friendlyProjectionErrorMessage(e) ?? err.message ?? String(err),
        };
        target.postMessage(out);
      });
  });
}

// Brand-check guard: `SsOptimizerPage.tsx` spawns this file as a real Worker via Vite's `?worker`. The `instanceof
// WorkerGlobalScope` check makes registration a no-op on the main thread and in jsdom (`WorkerGlobalScope` is
// undefined), so importing it adds no stray `message` listener to `window`. Tests call
// `registerOptimizerWorkerListener` directly.
const WORKER_GLOBAL_SCOPE_CTOR =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function'
    ? ((globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope as new (...args: unknown[]) => unknown)
    : null;
if (WORKER_GLOBAL_SCOPE_CTOR !== null && self instanceof WORKER_GLOBAL_SCOPE_CTOR) {
  registerOptimizerWorkerListener(self);
}
