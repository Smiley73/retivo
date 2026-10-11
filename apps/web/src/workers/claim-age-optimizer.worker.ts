/**
 * Deterministic claim-age optimizer Web Worker. Receives the raw
 * aggregates + a target scenario id; runs `optimiseClaimAgesForScenario`
 * (which delegates each candidate to `runBalanceProjection` for the
 * BPP-equivalent at-horizon balance) and posts the winner back.
 *
 * The SS-dependent slice is rebuilt per candidate inside the
 * runner — the worker forwards raw aggregates so the candidate overlay
 * can apply on top of the resolved chain.
 *
 * Protocol:
 *   main → worker: { kind: 'run', runId, input: OptimizerWorkerInput }
 *   worker → main: { kind: 'result', runId, scenarioId, winner, partial,
 *                    missingPiaMembers }
 *                | { kind: 'empty',  runId, scenarioId, reason }
 *                | { kind: 'unsupported', runId, scenarioId, reason }
 *                | { kind: 'error',  runId, scenarioId, message }
 *
 * Test pattern: tests install a fake `self` (with
 * `addEventListener` capturing the worker's listener and a `postMessage`
 * spy) BEFORE importing this module. The import runs the
 * `self.addEventListener('message', handler)` registration against the
 * fake `self`, leaving a captured `handler` reference. Tests then
 * invoke `handler({ data: <input> } as MessageEvent)` and assert
 * against the spy.
 */
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

export interface OptimizerWorkerInput {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /** Flag-derived medical category ids. Threaded into the optimizer's
   *  projections so the +2pp medical-inflation default follows the
   *  `isMedical` flag (a recreated/second medical category must not diverge
   *  from the legacy default). Structured-clone-safe Array. */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
  /** Serialised today timestamp; the worker reconstructs `new Date(iso)`. */
  readonly todayIso: string;
  /** Defaults to `'planned'`. The deterministic page posts two messages
   *  per scenario — one per method — and groups the two replies under
   *  one parent row. */
  readonly projectionMethod?: ProjectionMethod;
}

/**
 * `runId` correlates a single dispatch round-trip. The page effect can
 * re-run mid-flight (aggregates change via WORKSPACE_CHANGED_EVENT or
 * cross-tab sync) and register a second listener that would otherwise
 * match the previous run's reply purely by `scenarioId`. Filtering on
 * both keys prevents the new dispatch from resolving to the old reply.
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
      /** Metric value at the scenario's current claim ages — drives the
       *  "current → recommended" metric cell. `undefined` when the
       *  current pair isn't a whole-year grid candidate. */
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
      /** Requested `projectionMethod: 'twr'` but at least one active
       *  non-CBP account has < 2 yr of balance history. Separate kind
       *  (not `unsupported`) — only the TWR child row renders the
       *  "Insufficient history" message; the Planned child row still
       *  resolves. */
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
  // Defence-in-depth pre-check: if the scenario's CBP election is
  // unresolved, surface the Unsupported callout immediately so the page
  // doesn't spend a full BPP run on it. The runner also throws on
  // unconfigured CBP — this pre-check just skips the heavier path.
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
  // Empty-state pre-check: no primary or no resolvable primary
  // retirement date.
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
  // Birthdate shape check above is necessary but not sufficient —
  // a scenario with no `retirementAge` override (and no inherited one)
  // resolves to no retirement date too. Probe the resolved chain so
  // the empty surface fires for that case as well.
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

/**
 * Tighten the empty-state precheck. Birthdate validity isn't
 * sufficient — a scenario with no `retirementAge` override (and no
 * inherited override up the parent chain) still has no resolvable
 * primary retirement date. `resolveMemberRetirementDates` returns
 * `null` for the primary in that case; surface it as the same
 * `no-retirement-date` empty variant so the page renders the user-
 * facing "Set a primary retirement age…" copy instead of letting the
 * runner throw `NoPrimaryRetirementError` and bubble through as an
 * ErrorRow.
 */
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

/**
 * Register the worker's message listener on a target global. Exported
 * so tests can drive the side effect against a mocked `self` without
 * relying on import-time machinery.
 */
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

/**
 * Brand-check guard. `SsOptimizerPage.tsx` spawns this file as a real Worker
 * through Vite's `?worker` import, and the listener is registered there. The
 * `instanceof WorkerGlobalScope` brand check makes the registration a no-op
 * anywhere else the module is loaded (the main thread, jsdom), where
 * `WorkerGlobalScope` is undefined, so importing the module does not pollute
 * `window` with a stray `message` listener.
 *
 * Tests bypass this guard by calling `registerOptimizerWorkerListener`
 * directly against a fake `self`.
 */
const WORKER_GLOBAL_SCOPE_CTOR =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function'
    ? ((globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope as new (...args: unknown[]) => unknown)
    : null;
if (WORKER_GLOBAL_SCOPE_CTOR !== null && self instanceof WORKER_GLOBAL_SCOPE_CTOR) {
  registerOptimizerWorkerListener(self);
}
