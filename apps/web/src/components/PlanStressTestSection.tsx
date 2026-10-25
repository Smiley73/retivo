/**
 * Plan stress-test view model and the slot components the Balance Projection page interleaves. See
 * docs/math-projections.md, "The Monte Carlo stress test".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { useMonteCarlo } from '../monte-carlo/MonteCarloProvider';
import { runBalanceProjectionMc } from '../lib/balance-projection-runner';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import { hashMcInput } from '../lib/monte-carlo-input-signature';
import type {
  RunBalanceProjectionArgs,
} from '../lib/balance-projection-runner-types';
import { type CbpValidationResult } from '../lib/cbp-resolution';
import { seedFromString } from '../lib/sfc32';
import { successDeltaGate } from '../lib/success-delta-noise';
import { McProgressBar } from './McProgressBar';
import type {
  MonteCarloSummary,
  MonteCarloInput,
  RepresentativeRun,
} from '../lib/monte-carlo';
import { replayRepresentativePath } from '../lib/monte-carlo-summary';
import { BTN_SM, successTierForPct } from './plan-stress-test-chrome';
import type { StatusTier } from './plan-stress-test-chrome';
import { createMcPool } from '../monte-carlo/mc-worker-pool';
import MCWorker from '../workers/monte-carlo.worker.ts?worker';
import { computeCacheKey, getCached, putCached } from '../db/monte-carlo-cache';
import { isValidRmdIsoDate } from '../db/rmd-fact-validation';
import type { LastSurvivor } from '../pages/balance-projection-page-markers';
import { btnSecondarySmClass } from './dialog-chrome';

/** Display mode for the page's "Today $ / Future $" toggle. */
export type DisplayMode = 'today' | 'future';

// Shared with the Scenarios-list cache-read helper: a different `pathCount` would change the cache
// key.
const PATH_COUNT = MC_PATH_COUNT;

export interface PlanStressTestVm {
  hasNoAccounts: boolean;
  isRunning: boolean;
  isStale: boolean;
  error: string | null;
  result: MonteCarloSummary | null;
  /** Paths completed in the in-flight worker run. */
  progressDone: number;
  /**
   * Total paths for the in-flight run; `0` until the worker reports one, so the bar renders
   * indeterminate.
   */
  progressTotal: number;
  cancel: () => void;
  retry: () => void;
  /** Forces a fresh run with a new seed, bypassing the cache. No-op while the input is invalid. */
  recalculate: () => void;
  startTypical: number | null;
  startPessimistic: number | null;
  startBadLuck: number | null;
  endTypical: number | null;
  endPessimistic: number | null;
  endBadLuck: number | null;
  /** Year the median path runs out; `null` when it funds the full horizon. */
  typicalDepletionYear: number | null;
  /** Year the 25th-percentile path runs out; `null` when fewer than 25 % of paths deplete. */
  pessimisticDepletionYear: number | null;
  /** Year the 10th-percentile path runs out; `null` when fewer than 10 % of paths deplete. */
  badLuckDepletionYear: number | null;
  /** Rounded success percentage (0–100); `null` until a run completes. */
  successPct: number | null;
  successTier: StatusTier;
  retirementFractionalYear: number | null;
  /** Canonical `Retires <Mon YYYY>` marker label. */
  retirementLabel: string | null;
  lifeMarkers: { fractionalYear: number; label: string; color: string }[];
  /** Last surviving member's projected death year; `null` when no member has a usable birthdate. */
  lastDeathYear: number | null;
  /** `'today'` reads the real-dollar series, `'future'` the nominal ones. */
  displayMode: DisplayMode;
  /** `null` until household and scenario data load; the stress run is suppressed while `!ok`. */
  cbpValidation: CbpValidationResult | null;
  /** Used by the remediation banner to resolve owner names and deep links. */
  cbpAccounts: ReadonlyArray<Aggregate<AccountPayload>>;
  cbpMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /**
   * Replays one path's seed on the main thread, so the "show another likely path" reroll needs no
   * worker round-trip. `null` when the input is invalid or the capture is absent.
   */
  replayPath: (seed: number) => RepresentativeRun | null;
  /**
   * The base plan's Monte Carlo input without this hook's `pathCount` / `seed` overrides. `null`
   * when the input is invalid.
   */
  stressBaseInput: MonteCarloInput | null;
  /**
   * Content signature of the plan on screen folded with the displayed run's seed. `null` unless a
   * completed run for that plan produced the displayed summary; the comparison withholds itself on
   * `null` rather than pair a fresh input with a stale result.
   */
  stressPairSignature: string | null;
  /** A run for the plan on screen is queued or in flight; false after a cancel. */
  runPending: boolean;
  /**
   * Latest birth year in the household, anchoring the longevity stress's age-105 cap. `null`
   * withholds the stress comparison.
   */
  longestLivedBirthYear: number | null;
  /**
   * The member projected to die last, whose life the longevity stress extends; differs from the cap
   * anchor above when an older member outlives a younger one.
   */
  lastSurvivor: LastSurvivor | null;
  /**
   * With/without-guardrails comparison; present only when the active scenario enables the
   * guardrail.
   */
  guardrailComparison?: GuardrailComparisonVm;
}

/** Seed-paired with/without-guardrails comparison state. */
export interface GuardrailComparisonVm {
  /** `pending` while the forced-off sibling run is in flight, `error` on a worker failure. */
  readonly state: 'pending' | 'error' | 'ready';
  /** Success probability with guardrails (0..1); `null` until the primary run completes. */
  readonly withPct: number | null;
  /** Success probability without guardrails (0..1); `null` until the sibling run completes. */
  readonly withoutPct: number | null;
  /** `withPct − withoutPct`, or `null` when either side is absent. */
  readonly deltaPct: number | null;
  /**
   * Unpaired two-proportion standard error on the delta (0..1), an upper bound on the true paired
   * SE (no per-path outcomes are retained). The delta is signal only when `|deltaPct| > se`; erring
   * high only over-suppresses.
   */
  readonly se: number | null;
}

/**
 * Page-derived presentation extras threaded into the hook (life-marker colours, retirement year).
 */
export interface PlanStressTestExtras {
  readonly lifeMarkers: ReadonlyArray<{
    fractionalYear: number;
    label: string;
    color: string;
  }>;
  readonly retirementFractionalYear: number | null;
  /** Canonical `Retires <Mon YYYY>` marker label. */
  readonly retirementLabel: string | null;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /**
   * The member projected to die last; page-derived because it needs the scenario's life-expectancy
   * override.
   */
  readonly lastSurvivor: LastSurvivor | null;
}

const EMPTY_EXTRAS: PlanStressTestExtras = {
  lifeMarkers: [],
  retirementFractionalYear: null,
  retirementLabel: null,
  accounts: [],
  members: [],
  lastSurvivor: null,
};

/**
 * Builds the MC input via the shared runner helper. The runner's typed throws are deliberately not
 * caught: they mark call-site bugs.
 */
function buildMcInputFromArgs(
  runArgs: RunBalanceProjectionArgs | null,
): MonteCarloInput | null {
  if (!runArgs) return null;
  return runBalanceProjectionMc(runArgs);
}

/**
 * Latest birth year among the members, the anchor for the market-stress longevity cap. Birthdates
 * come from imported payloads, so only a complete, real ISO date counts; `null` when none is usable
 * withholds the comparison.
 */
export function longestLivedBirthYearOf(
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): number | null {
  const years = members
    .map((m) => m.payload.birthdate)
    .filter((b): b is string => isValidRmdIsoDate(b))
    .map((b) => Number(b.slice(0, 4)));
  return years.length > 0 ? Math.max(...years) : null;
}

// Request and settlement are two independent slots. `settled` is written only when the same request
// resolves with a summary and survives a newer request, so a cancelled or failed Recalculate still
// leaves the on-screen summary paired. The provider serves the previous `result` through its async
// cache work, so settlement cannot be inferred from the requested signature: that paired the new
// plan's input with the old plan's summary.
interface PrimaryRunState {
  readonly requested: { readonly id: number; readonly signature: string } | null;
  readonly settled: {
    readonly signature: string;
    readonly summary: MonteCarloSummary;
  } | null;
  /** Id of the last request that ended by any path (summary, cancel, error). */
  readonly endedId: number;
}

const NO_PRIMARY_RUN: PrimaryRunState = { requested: null, settled: null, endedId: 0 };

/**
 * Runs the primary Monte Carlo run and the guardrail sibling. Uses `runToCompletion` so the hook
 * knows which request produced the summary on screen (see `PrimaryRunState`); the call-site
 * override stamps BPP's path count and a signature-derived seed on the runner's defaults.
 */
export function usePlanStressTestVm(
  runArgs: RunBalanceProjectionArgs | null,
  cbpResolution: CbpValidationResult | null,
  displayMode: DisplayMode,
  extras: PlanStressTestExtras = EMPTY_EXTRAS,
): PlanStressTestVm {
  const {
    runToCompletion,
    status,
    result: rawResult,
    error,
    cancel,
    progressDone,
    progressTotal,
  } = useMonteCarlo();
  const [primaryRun, setPrimaryRun] = useState<PrimaryRunState>(NO_PRIMARY_RUN);
  // A ref: bumping the id is part of kicking a run, and `setPrimaryRun` already re-renders.
  const runIdRef = useRef(0);
  // The signature last asked to run: the auto-run dedupe must not restart a cancelled run.
  const lastRunSignature = primaryRun.requested?.signature ?? null;
  // Salts the forced-recalc seed; a ref so bumping it does not re-trigger the debounced auto-run.
  const recalcCountRef = useRef(0);

  // A CBP failure short-circuits before the MC input is built.
  const cbpFailed = cbpResolution !== null && !cbpResolution.ok;
  const mcInput = useMemo(
    () => (cbpFailed ? null : buildMcInputFromArgs(runArgs)),
    [runArgs, cbpFailed],
  );

  // The signature must cover every field the kernel reads from `mcInput`: a same-scenario edit
  // keeps `scenarioId`.
   // When the input is invalid the provider can still hold the prior result, so keep a non-null
   // token for `isStale`.
  const currentSignature = useMemo(() => {
    if (mcInput) return hashMcInput(mcInput, cbpFailed);
    return JSON.stringify({
      cbpFailed,
      scenarioId: runArgs?.scenarioId ?? null,
      pathCount: PATH_COUNT,
    });
  }, [mcInput, cbpFailed, runArgs]);

  const kickRun = useCallback(
    (kind: 'reset' | 'reroll' | 'recalc') => {
      if (!mcInput || !currentSignature) return;
      let seed: number;
      if (kind === 'reset') {
        // Deterministic seed from the signature, so an unchanged plan reuses the same sample.
        seed = seedFromString(currentSignature);
      } else if (kind === 'recalc') {
        // Fold a counter into the seed so each forced run is a fresh sample.
        recalcCountRef.current += 1;
        seed =
          (seedFromString(currentSignature) + recalcCountRef.current * 0x9e3779b1) >>>
          0;
      } else {
        seed = Date.now() & 0xffffffff;
      }
      // Record the request before calling the provider, so its async pre-`running` work is not
      // mistaken for a settled run.
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setPrimaryRun((prev) => ({
        ...prev,
        requested: { id: runId, signature: currentSignature },
      }));
      // A `recalc` forces past the cache short-circuit.
      void runToCompletion(
        { ...mcInput, pathCount: PATH_COUNT, seed },
        kind === 'recalc' ? { force: true } : undefined,
      )
        .then((summary) => {
          // `null` = cancelled mid-flight; the run on screen stays settled.
          setPrimaryRun((prev) => {
            // A newer request replaced this one; only its completion may settle the pair.
            if (prev.requested === null || prev.requested.id !== runId) return prev;
            return summary === null
              ? { ...prev, endedId: runId }
              : {
                  ...prev,
                  endedId: runId,
                  settled: { signature: currentSignature, summary },
                };
          });
        })
        .catch(() => {
          // The provider already surfaces the worker error; the previously settled run stays
          // settled.
          setPrimaryRun((prev) =>
            prev.requested !== null && prev.requested.id === runId
              ? { ...prev, endedId: runId }
              : prev,
          );
        });
    },
    [mcInput, currentSignature, runToCompletion],
  );

  useEffect(() => {
    if (!mcInput || !currentSignature) return;
    if (currentSignature === lastRunSignature) return;
    if (cbpFailed) return;
    const handle = window.setTimeout(() => {
      kickRun('reset');
    }, 800);
    return () => window.clearTimeout(handle);
  }, [mcInput, currentSignature, lastRunSignature, kickRun, cbpFailed]);

  // Mirrors the call-site `pathCount` / `seed` overrides so the main-thread replay reproduces the
  // worker's path.
  const replayPath = useCallback(
    (seed: number): RepresentativeRun | null => {
      if (!mcInput || !currentSignature) return null;
      return replayRepresentativePath(
        { ...mcInput, pathCount: PATH_COUNT, seed: seedFromString(currentSignature) },
        seed,
      );
    },
    [mcInput, currentSignature],
  );

  // No accounts renders the empty card; CBP failures fall through to the remediation banner
  // instead.
  const hasNoAccounts =
    !runArgs ||
    extras.accounts.length === 0 ||
    runArgs.accounts.filter((a) => a.payload.active).length === 0;

  // Null the result locally when the input is invalid so a prior run does not leak into the cards.
  const result = mcInput === null ? null : rawResult;
  const isStale =
    result !== null &&
    lastRunSignature !== null &&
    currentSignature !== null &&
    lastRunSignature !== currentSignature;
  const isRunning = status === 'running';
  const runPending =
    mcInput !== null &&
    !cbpFailed &&
    (currentSignature !== lastRunSignature ||
      (primaryRun.requested !== null && primaryRun.endedId !== primaryRun.requested.id));

  // Guardrail with/without comparison: the hook runs the forced-off sibling (only `enabled`
  // differs, so the delta is seed-paired) in a one-worker pool, disposed on completion, unmount and
  // input change.
  const guardrailEnabled = mcInput?.downturnGuardrails?.enabled === true;
  const [siblingResult, setSiblingResult] = useState<{
    pairKey: string;
    withoutPct: number | null;
    state: 'pending' | 'error' | 'ready';
  } | null>(null);
  // The pair key whose sibling run has started; a ref so the effect does not loop on its own state
  // write.
  const siblingStartedRef = useRef<string | null>(null);
  // Read inside the sibling effect but not a dep: a `mcInput` identity churn with an unchanged
  // pairKey must not abort an in-flight run.
  const mcInputRef = useRef(mcInput);
  mcInputRef.current = mcInput;
  // Settled: this hook's own request completed for the signature on screen and its summary is the
  // displayed result. That withholds the pair across an edit's whole cache-read + worker window.
  const primarySettled =
    result !== null &&
    primaryRun.settled !== null &&
    primaryRun.settled.signature === currentSignature &&
    primaryRun.settled.summary === result;
  // Pair on the primary run's actual seed: a recalc or reroll changes it while the signature stays
  // fixed, and re-keying on it re-arms the effect.
  const primarySeed = primarySettled ? (result?.seed ?? null) : null;
  const pairKey =
    currentSignature !== null && primarySeed !== null
      ? `${currentSignature}::${primarySeed}`
      : null;

  useEffect(() => {
    const latestMcInput = mcInputRef.current;
    if (!guardrailEnabled || !latestMcInput || !currentSignature) {
      siblingStartedRef.current = null;
      setSiblingResult(null);
      return;
    }
    // Wait for the primary run so the comparison is seed-paired with the shown result.
    if (!primarySettled || primarySeed === null || pairKey === null) return;
    if (siblingStartedRef.current === pairKey) return;
    siblingStartedRef.current = pairKey;

    let disposed = false;
    let pool: ReturnType<typeof createMcPool> | null = null;
    setSiblingResult({ pairKey, withoutPct: null, state: 'pending' });
    const forcedOff: MonteCarloInput = {
      ...latestMcInput,
      pathCount: PATH_COUNT,
      // The primary run's actual seed keeps the pair seed-paired after a recalc.
      seed: primarySeed,
      downturnGuardrails: { ...latestMcInput.downturnGuardrails!, enabled: false },
    };
    void (async () => {
      // Cache-first like the primary; the key includes the seed, so a hit is paired with the
      // displayed result and a Recalculate misses.
      const key = await computeCacheKey({ ...forcedOff, onProgress: undefined });
      if (disposed) return;
      const cached = await getCached(key);
      if (disposed) return;
      if (cached) {
        setSiblingResult({ pairKey, withoutPct: cached.successProbability, state: 'ready' });
        return;
      }
      pool = createMcPool({ factory: () => new MCWorker(), size: 1 });
      if (disposed) {
        pool.dispose();
        pool = null;
        return;
      }
      try {
        const reply = await pool.run(forcedOff);
        if (disposed) return;
        if (reply.kind === 'result') {
          // Cache write is fire-and-forget.
          void putCached(key, reply.summary).catch(() => {});
          setSiblingResult({
            pairKey,
            withoutPct: reply.summary.successProbability,
            state: 'ready',
          });
        } else if (reply.kind === 'error') {
          setSiblingResult({ pairKey, withoutPct: null, state: 'error' });
        }
        // `aborted` leaves the pending state for the next effect run to supersede.
      } catch {
        if (!disposed) {
          setSiblingResult({ pairKey, withoutPct: null, state: 'error' });
        }
      } finally {
        pool?.dispose();
        pool = null;
      }
    })();
    return () => {
      disposed = true;
      pool?.dispose();
      pool = null;
    };
    // `mcInput` is read via `mcInputRef` so identity churn does not re-fire this effect.
  }, [guardrailEnabled, currentSignature, primarySettled, primarySeed, pairKey]);

  const guardrailComparison: GuardrailComparisonVm | undefined = guardrailEnabled
    ? buildGuardrailComparison(
        result?.successProbability ?? null,
        siblingResult?.pairKey === pairKey ? siblingResult : null,
        result?.pathCount ?? null,
      )
    : undefined;

  const successProbabilityRaw = result
    ? result.successProbability * 100
    : null;
  const successPct =
    successProbabilityRaw == null ? null : Math.round(successProbabilityRaw);
  const successTier: StatusTier = successTierForPct(successPct);

  const pcts = result
    ? displayMode === 'today'
      ? result.percentilesReal
      : result.percentilesNominal
    : null;
  const retIdx = mcInput
    ? Math.max(0, mcInput.retirementYear - mcInput.firstYear)
    : 0;
  const startTypical = pcts ? pcts.p50[retIdx] : null;
  const startPessimistic = pcts ? pcts.p25[retIdx] : null;
  const startBadLuck = pcts ? pcts.p10[retIdx] : null;
  const endTypical =
    result == null
      ? null
      : displayMode === 'today'
        ? result.medianEndingBalanceReal
        : result.medianEndingBalanceNominal;
  const endPessimistic =
    result == null
      ? null
      : displayMode === 'today'
        ? result.p25EndingBalanceReal
        : result.p25EndingBalanceNominal;
  const endBadLuck =
    result == null
      ? null
      : displayMode === 'today'
        ? result.p10EndingBalanceReal
        : result.p10EndingBalanceNominal;
  // Death is Dec 31 of the integer death year, so `Math.ceil` is the identity.
  const lastDeathYear =
    extras.lifeMarkers.length > 0
      ? Math.max(...extras.lifeMarkers.map((m) => Math.ceil(m.fractionalYear)))
      : null;
  const longestLivedBirthYear = longestLivedBirthYearOf(extras.members);

  return {
    hasNoAccounts,
    isRunning,
    isStale,
    error,
    result,
    progressDone,
    progressTotal,
    cancel,
    retry: () => kickRun('reroll'),
    recalculate: () => kickRun('recalc'),
    startTypical,
    startPessimistic,
    startBadLuck,
    endTypical,
    endPessimistic,
    endBadLuck,
    typicalDepletionYear: result?.medianDepletionYear ?? null,
    pessimisticDepletionYear: result?.p25DepletionYear ?? null,
    badLuckDepletionYear: result?.p10DepletionYear ?? null,
    successPct,
    successTier,
    retirementFractionalYear: extras.retirementFractionalYear,
    retirementLabel: extras.retirementLabel,
    lifeMarkers: [...extras.lifeMarkers],
    lastDeathYear,
    displayMode,
    stressBaseInput: mcInput,
    // Non-null only once a request for the current signature has completed and its summary is the
    // one on screen.
    stressPairSignature: pairKey,
    runPending,
    longestLivedBirthYear,
    lastSurvivor: extras.lastSurvivor,
    cbpValidation: cbpResolution,
    cbpAccounts: extras.accounts,
    cbpMembers: extras.members,
    replayPath,
    ...(guardrailComparison !== undefined ? { guardrailComparison } : {}),
  };
}

/**
 * Builds the seed-paired guardrail comparison. The SE is the independent two-proportion bound from
 * `lib/success-delta-noise.ts`, conservative because the summary-only engine keeps no per-path
 * outcomes.
 */
function buildGuardrailComparison(
  withProbability: number | null,
  sibling: { withoutPct: number | null; state: 'pending' | 'error' | 'ready' } | null,
  pathCount: number | null,
): GuardrailComparisonVm {
  const withPct = withProbability;
  if (sibling === null) {
    return { state: 'pending', withPct, withoutPct: null, deltaPct: null, se: null };
  }
  if (sibling.state === 'error') {
    return { state: 'error', withPct, withoutPct: null, deltaPct: null, se: null };
  }
  const withoutPct = sibling.withoutPct;
  if (sibling.state !== 'ready' || withPct === null || withoutPct === null) {
    return { state: 'pending', withPct, withoutPct, deltaPct: null, se: null };
  }
  const n = pathCount && pathCount > 0 ? pathCount : PATH_COUNT;
  const { delta, se } = successDeltaGate(withPct, n, withoutPct, n);
  return { state: 'ready', withPct, withoutPct, deltaPct: delta, se };
}

/** Empty-state CTA for a household with no accounts. */
export function PlanStressTestEmpty() {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-6 shadow-sm">
      <h2 className="m-0 text-xl font-semibold text-ink">
        Add an account to run a plan stress-test
      </h2>
      <p className="text-muted">
        Your simulation needs at least one active account with a positive
        balance.
      </p>
      <div>
        <Link to="/accounts?new" className={BTN_SM}>
          Add account
        </Link>
      </div>
    </div>
  );
}

/**
 * Determinate progress bar with Cancel while a run is in flight, and the error alert with retry.
 */
export function PlanStressTestStatusRow({ vm }: { vm: PlanStressTestVm }) {
  if (!vm.isRunning && !vm.error) return null;
  return (
    <div className="flex flex-col gap-2">
      {vm.isRunning && (
        <div
          className="flex flex-wrap items-center gap-3"
          role="status"
          aria-live="polite"
        >
          <McProgressBar done={vm.progressDone} total={vm.progressTotal} />
          <button
            type="button"
            className={BTN_SM}
            onClick={vm.cancel}
          >
            Cancel
          </button>
        </div>
      )}
      {vm.error && (
        <div
          className="rounded-lg border border-negative/40 bg-negative/5 px-4 py-3 text-negative"
          role="alert"
        >
          Stress-test failed: {vm.error}
          <button
            type="button"
            className={`ml-2 ${BTN_SM}`}
            onClick={vm.retry}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Manual "Recalculate" control: a fresh run with a new seed. `ariaLabel` is overridden where two
 * instances share a page.
 */
export function PlanStressTestRecalcButton({
  vm,
  ariaLabel = 'Recalculate plan stress test',
}: {
  vm: PlanStressTestVm;
  ariaLabel?: string;
}) {
  // Hidden when there is nothing to recalculate; the remediation banner owns the CBP-failed
  // surface.
  if (vm.hasNoAccounts || (vm.cbpValidation && !vm.cbpValidation.ok)) {
    return null;
  }
  const disabled = vm.isRunning || vm.result === null;
  return (
    <button
      type="button"
      className={`${btnSecondarySmClass} disabled:cursor-not-allowed disabled:opacity-50`}
      onClick={vm.recalculate}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      Recalculate
    </button>
  );
}

// The stat-card slot renderers (`PlanStressTestSuccessCard`,
// `PlanStressTestRetirementCards`, `PlanStressTestHorizonCards`) and the
// fan-chart + data-table renderer (`PlanStressTestChart`) were extracted
// to sibling modules to keep this file under the shape limit.
// They are pure presentation over the `PlanStressTestVm` built
// above. Re-exported here so existing importers and the section's test
// suite keep their `./PlanStressTestSection` import paths unchanged.
export {
  PlanStressTestSuccessCard,
  PlanStressTestRetirementCards,
  PlanStressTestHorizonCards,
} from './PlanStressTestCards';
export {
  PlanStressTestChart,
} from './PlanStressTestChart';
export { PlanStressTestMarketStress } from './PlanStressTestCards';
