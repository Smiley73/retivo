/**
 * Plan stress-test view model + slot components.
 *
 * Auto-runs on mount when no fresh cache entry is available, then
 * re-runs whenever the input signature changes (debounced ~800 ms).
 * Consumes a pre-resolved `BalanceProjectionMcBundle` from the host
 * page — all scenario resolution + CBP election resolution happens
 * upstream in `balance-projection-bundle.ts`.
 *
 * The Balance Projection page interleaves the slots: MC stat cards
 * sit alongside the deterministic "At retirement / At horizon" cards
 * (via the shared `.stat-grid`), the running-status row renders in the
 * "Stress-test outcomes" card header, and the fan chart +
 * companion data table go under the per-year projection chart.
 *
 * See docs/math-projections.md, "The Monte Carlo stress test".
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
// Shared small outlined-secondary button — same size as the page's other
// "Show … table" toggles (year-by-year, taxes & health costs) for visual
// consistency across the Balance Projection page disclosures.
import { btnSecondarySmClass } from './dialog-chrome';

/** Display mode for the page's "Today $ / Future $" toggle. Mirrors
 *  `DisplayMode` in `BalanceProjectionPage.tsx`; the stress section
 *  swaps the percentile + ending-balance series read off the engine
 *  result based on this value. */
export type DisplayMode = 'today' | 'future';

// Shared with the Scenarios-list cache-read helper so both hash the same
// `pathCount` (a mismatch would change the cache key → a stale-forever miss).
const PATH_COUNT = MC_PATH_COUNT;

export interface PlanStressTestVm {
  hasNoAccounts: boolean;
  isRunning: boolean;
  isStale: boolean;
  error: string | null;
  result: MonteCarloSummary | null;
  /** Paths completed in the in-flight worker run (path-level progress
   *  from `useMonteCarlo`). Drives the determinate `McProgressBar`. */
  progressDone: number;
  /** Total paths for the in-flight run. `0` until the worker reports a
   *  total → the bar renders indeterminate. */
  progressTotal: number;
  cancel: () => void;
  retry: () => void;
  /** Force a fresh MC run, bypassing the cache short-circuit, with a new
   *  seed so the user gets a genuinely new sample even when the input
   *  signature is unchanged. The fresh result overwrites the cached
   *  entry. No-op while invalid (CBP-failed / null input). */
  recalculate: () => void;
  startTypical: number | null;
  startPessimistic: number | null;
  startBadLuck: number | null;
  endTypical: number | null;
  endPessimistic: number | null;
  endBadLuck: number | null;
  /** Year the median path runs out. `null` when the median path
   *  funds the full horizon (i.e. success probability > 50 %). */
  typicalDepletionYear: number | null;
  /** Year the 25th-percentile (pessimistic) path runs out. `null` when
   *  fewer than 25 % of paths deplete. */
  pessimisticDepletionYear: number | null;
  /** Year the 10th-percentile (bad-luck) path runs out. `null` when
   *  fewer than 10 % of paths deplete. */
  badLuckDepletionYear: number | null;
  /** Rounded integer (0–100) — drives the success-tier thresholds
   *  (≥ 85 / ≥ 70). `null` until a run completes. */
  successPct: number | null;
  successTier: StatusTier;
  retirementFractionalYear: number | null;
  /** Canonical `Retires <Mon YYYY>` marker label for the fan chart. */
  retirementLabel: string | null;
  lifeMarkers: { fractionalYear: number; label: string; color: string }[];
  /** Last surviving household member's projected death year. Drives
   *  the horizon-card danger predicate. `null`
   *  when no member has a usable birthdate. */
  lastDeathYear: number | null;
  /** Active display mode: `'today'` reads `percentilesReal` /
   *  `*EndingBalanceReal`; `'future'` reads the nominal counterparts.
   *  Threaded from the page's "Today $ / Future $" toggle. */
  displayMode: DisplayMode;
  /** CBP validation against the active scenario. `null` until the
   *  household + scenario data is loaded. Consumers render the
   *  remediation banner when `!cbpValidation.ok`; the stress run is
   *  suppressed in that state. */
  cbpValidation: CbpValidationResult | null;
  /** Raw account + member lists used by the remediation banner so it
   *  can resolve owner names + deep-link targets. */
  cbpAccounts: ReadonlyArray<Aggregate<AccountPayload>>;
  cbpMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Replay ONE path's seed on the MAIN THREAD into a `RepresentativeRun`,
   *  reusing the engine's capture + RMD/tax post-passes. Backs the
   *  Balance Projection "show another likely path" reroll: the view model
   *  picks a band seed from `result.representativeBandsByBasis` and replays it
   *  here, swapping the basis line WITHOUT a worker round-trip or a new sample
   *  (the cards/percentiles never move). `null` when the input is invalid
   *  (no accounts / CBP-failed) or the capture is absent. */
  replayPath: (seed: number) => RepresentativeRun | null;
  /** The base plan's assembled Monte Carlo input, WITHOUT this hook's
   *  `pathCount`/`seed` call-site overrides. Feeds the market-stress
   *  comparison, which stamps the DISPLAYED run's own seed + path count so each
   *  stress draws the identical months. `null` when the input is invalid
   *  (no accounts / CBP-failed). */
  stressBaseInput: MonteCarloInput | null;
  /** Identity of the run the market-stress comparison may pair against: the
   *  content signature of the plan on screen folded with the DISPLAYED run's
   *  actual seed. `null` whenever no COMPLETED run for the plan on
   *  screen produced the summary being displayed — an edit still debouncing,
   *  or a superseded result. Settlement is the REQUEST's own completion, never
   *  "a run was asked for with this signature" (see `PrimaryRunState`). The
   *  comparison withholds itself on `null` rather than differencing a fresh
   *  input against a stale result. */
  stressPairSignature: string | null;
  /** Birth year of the household's youngest member (the latest birth year)
   *  — the anchor for the longevity stress's age-105 cap. `null` when no
   *  member has a usable birthdate, which WITHHOLDS the stress comparison
   *  rather than guessing an age. */
  longestLivedBirthYear: number | null;
  /** The member projected to die LAST — whose life the longevity stress
   *  actually lengthens, since the plan's horizon IS their death year. Feeds
   *  the row's "(John age 97)" reading. Deliberately NOT the cap anchor above:
   *  that one bounds how far the stress may run, this one names whose life it
   *  extends, and they differ when an older member outlives a younger one. */
  lastSurvivor: LastSurvivor | null;
  /** Seed-paired with/without-guardrails success-probability comparison
   *  Present only when the active scenario ENABLES the
   *  guardrail: the hook derives the forced-off (`enabled:false`) sibling input
   *  — same seed / pathCount / injected draws, only `enabled` differs — runs it
   *  via `createMcPool`, and exposes the paired delta. Absent (undefined) when
   *  guardrails are off. */
  guardrailComparison?: GuardrailComparisonVm;
}

/** Seed-paired with/without-guardrails comparison state. */
export interface GuardrailComparisonVm {
  /** `pending` while the forced-off sibling run is in flight; `error` on a
   *  worker failure; `ready` once both success probabilities are known. */
  readonly state: 'pending' | 'error' | 'ready';
  /** Success probability WITH guardrails (0..1) — the primary run's value.
   *  `null` until the primary run completes. */
  readonly withPct: number | null;
  /** Success probability WITHOUT guardrails (0..1) — the forced-off sibling.
   *  `null` until that run completes. */
  readonly withoutPct: number | null;
  /** `withPct − withoutPct` (0..1), or `null` when either side is absent. */
  readonly deltaPct: number | null;
  /** Conservative sampling standard-error bound on the delta (0..1) — the
   *  UNPAIRED two-proportion SE, an UPPER BOUND on the true (unobservable)
   *  paired SE (the summary-only engine retains no per-path outcomes).
   *  The delta is rendered as signal only when `|deltaPct| > se` — below that it
   *  is treated as sampling noise and the consumer renders "≈ no change".
   *  Erring high can only over-suppress a real delta, never show false signal. */
  readonly se: number | null;
}

/**
 * Page-derived presentation extras threaded into the hook. The runner
 * itself returns nominal marker data (memberId / fractionalYear / slot
 * label) — life-marker colors + the retirement fractional year are
 * presentation concerns owned by BPP, so they ride along in this
 * extras bag rather than getting re-derived inside the hook.
 */
export interface PlanStressTestExtras {
  readonly lifeMarkers: ReadonlyArray<{
    fractionalYear: number;
    label: string;
    color: string;
  }>;
  readonly retirementFractionalYear: number | null;
  /** Canonical `Retires <Mon YYYY>` marker label (page-derived). */
  readonly retirementLabel: string | null;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Who the plan's horizon belongs to — the member projected to die last.
   *  Page-derived because it needs the resolved scenario's life-expectancy
   *  override, which the raw member list above does not carry. */
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
 * Build the MC input via the shared runner helper.
 * Returns `null` only when `runArgs` is `null`; CBP-validation failure
 * is checked upstream via `cbpResolution`, so the runner's throw
 * is unreachable when the caller honors the contract.
 *
 * No catch-all. The runner's typed throws (`CbpUnconfiguredError`,
 * `NoPrimaryRetirementError`) MUST surface — swallowing them masks real
 * pipeline bugs. CBP-unconfigured short-circuits upstream via
 * `cbpResolution?.ok === false`; a `NoPrimaryRetirementError` here is a
 * call-site contract bug (caller passed args without a primary
 * retirement) and should fail loud.
 */
function buildMcInputFromArgs(
  runArgs: RunBalanceProjectionArgs | null,
): MonteCarloInput | null {
  if (!runArgs) return null;
  return runBalanceProjectionMc(runArgs);
}

/**
 * Birth year of the household's youngest member (the latest birth year) — the
 * anchor for the market-stress longevity cap. The youngest member is the anchor
 * because `birthYear + STRESS_MAX_AGE` is largest for them.
 *
 * A birthdate is usable only when it is a COMPLETE, real calendar date. A member
 * aggregate reaches this code straight off an IMPORTED payload, whose validation
 * covers the envelope and not the field shapes, so a bare `Number(...)` would
 * treat a blank birthdate as the year 0, and a four-leading-digit prefix test
 * would accept `9999-`, `1968-99-99` and a bare `1968` — each of which would
 * hand the stress a nonsense age-105 anchor and quietly change how far the
 * longevity comparison runs.
 *
 * So this reuses the repo's ONE strict ISO-date validator
 * (`db/rmd-fact-validation.ts`, the same one `tax-integration-helpers.ts` uses
 * for member birthdates): exact `YYYY-MM-DD` shape, a UTC round-trip that
 * rejects impossible days (Feb 30, Apr 31, non-leap Feb 29), and plausible year
 * bounds `[1900, 2200]`. Members without a usable birthdate contribute nothing;
 * when NONE is usable this returns `null`, which withholds the comparison
 * rather than guessing an age.
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

/**
 * Explicit request → completion identity for the ONE primary Monte Carlo run
 * this hook owns, held as TWO INDEPENDENT slots.
 *
 * Why an identity and not just "the last signature we asked to run": the
 * provider's `run`/`runToCompletion` do asynchronous work (cache-key hashing,
 * then an IndexedDB read) BEFORE they move `status` to `running`, and they keep
 * serving the PREVIOUS `result` for the whole request — cache work and worker
 * execution alike. Deriving settlement from the requested signature therefore
 * declared the run settled the instant it was kicked, so the market-stress
 * comparison could pair the NEW plan's input with the OLD plan's summary and
 * publish `new plan + stress − old plan` in dollars.
 *
 * `requested` is recorded synchronously in `kickRun`, before the provider is
 * called at all, and is never cleared: it is "the signature we last ASKED to
 * run", which is what the auto-run dedupe and the staleness comparison need
 * (cancelling a run must not re-arm the debounce and restart it).
 *
 * `settled` is written ONLY when that same request's own promise resolves with
 * a summary, and is deliberately kept ALONGSIDE a newer outstanding request
 * rather than being replaced by it. `runToCompletion` has THREE terminal paths
 * — resolve with a summary, resolve `null` (cancelled mid-flight), and reject
 * (worker error) — and only the first produces a settled run. Collapsing the
 * two slots into one pending/settled phase therefore left a cancelled or failed
 * Recalculate with no settled run at all, even though the summary on screen was
 * still the right one for the plan on screen: the guardrail with/without
 * callout sat on its indeterminate bar and the market-stress panel withheld the
 * comparison, permanently. Cross-plan pairing is prevented by comparing
 * `settled.signature` (and `settled.summary`) with what is on screen — after a
 * genuine plan EDIT the retained signature is the OLD one, so the pair stays
 * withheld for the whole cache-read + worker window — not by erasing the last
 * settled run.
 */
interface PrimaryRunState {
  readonly requested: { readonly id: number; readonly signature: string } | null;
  readonly settled: {
    readonly signature: string;
    readonly summary: MonteCarloSummary;
  } | null;
}

const NO_PRIMARY_RUN: PrimaryRunState = { requested: null, settled: null };

/**
 * Hook signature: takes `runArgs` + `cbpResolution` + `displayMode`
 * (page-derived presentation extras ride in the 4th arg). The MC card
 * builds its input via the shared `runBalanceProjectionMc()` helper —
 * the same input-builder the SS optimizer's MC consumes
 * (`optimizer-mc-runner.ts`), so there is exactly one MC
 * input-builder across both surfaces.
 *
 * The call-site spread at `void runToCompletion({ ...mcInput, pathCount:
 * PATH_COUNT, seed })` overrides the runner's stamped `pathCount: 1000` /
 * `seed: 1` defaults with BPP's 10_000 path count + a signature-derived
 * seed. `runToCompletion` rather than `run` because this hook needs
 * to know WHICH request produced the summary on screen (see `PrimaryRunState`);
 * both are cache-first and thread the same status/progress/result state.
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
  // The last REQUESTED primary run plus the last one that COMPLETED with a
  // summary. `runToCompletion` (not `run`) is the provider's completion-carrying
  // API: it resolves with the summary THIS request produced, which is what makes
  // the settled identity explicit rather than inferred from the provider's
  // shared `status` / `result`.
  const [primaryRun, setPrimaryRun] = useState<PrimaryRunState>(NO_PRIMARY_RUN);
  // Source of the monotonic request id. A ref, not state: bumping it is part of
  // kicking a run, and the accompanying `setPrimaryRun` already re-renders.
  const runIdRef = useRef(0);
  // "The signature we last ASKED to run" — the correct basis for the auto-run
  // dedupe (a request in flight must not be re-kicked, and a cancelled one must
  // not be restarted by the debounce) and for the staleness dimming, which
  // `isRunning` already covers for the in-flight window.
  const lastRunSignature = primaryRun.requested?.signature ?? null;
  // Monotonic counter that salts the forced-recalc seed so each manual
  // "Recalculate" yields a fresh sample (deterministic per call, but
  // distinct from the prior run). Kept in a ref — bumping it must not
  // re-trigger the debounced auto-run effect.
  const recalcCountRef = useRef(0);

  // CBP-unconfigured short-circuits BEFORE building the MC input.
  // The deterministic-side `cbpResolution` is the single source of
  // truth — the runner's throw is unreachable when the contract is
  // honored.
  const cbpFailed = cbpResolution !== null && !cbpResolution.ok;
  const mcInput = useMemo(
    () => (cbpFailed ? null : buildMcInputFromArgs(runArgs)),
    [runArgs, cbpFailed],
  );

  // Cache signature MUST reflect every field the kernel reads
  // from `mcInput`. `runArgs.scenarioId` alone is insufficient — a
  // same-scenario edit (e.g. balance / expense / income / anchor /
  // claim-age) leaves the scenarioId fixed but reshapes the runner
  // input, so a stale cached run would survive the change. Hash the
  // built `mcInput` (less progress callbacks) instead.
  //
  // When the CBP path flips invalid `mcInput` becomes `null`,
  // but `useMonteCarlo().result` can still hold the prior successful
  // run. Producing a `null` signature there masks `isStale` (which
  // requires a non-null current signature) and the success card
  // would render the prior percentiles next to the remediation
  // banner. Keep a stable non-null token for the invalid-input path
  // (CBP-failed or null-runArgs) so `isStale` compares cleanly
  // against the last successful signature — the success card then
  // dims correctly and reads `vm.result` only on a fresh run.
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
        // Auto-run / cache-keyed run: deterministic seed from the
        // content signature so an unchanged plan reuses the same sample.
        seed = seedFromString(currentSignature);
      } else if (kind === 'recalc') {
        // Manual "Recalculate": fold a monotonic counter into the
        // signature-derived seed so each forced run is a fresh sample
        // (deterministic per call, distinct from the prior run).
        recalcCountRef.current += 1;
        seed =
          (seedFromString(currentSignature) + recalcCountRef.current * 0x9e3779b1) >>>
          0;
      } else {
        // Error-retry reroll.
        seed = Date.now() & 0xffffffff;
      }
      // Record the request before the provider is called, so none of its
      // asynchronous pre-`running` work (cache key, cache read) can be mistaken
      // for a settled run against the new signature. The previously SETTLED run
      // is left in place — it is still the summary on screen, and after an edit
      // its now-stale signature is exactly what withholds the pair.
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setPrimaryRun((prev) => ({
        ...prev,
        requested: { id: runId, signature: currentSignature },
      }));
      // Call-site override stamps PATH_COUNT (10_000) + a
      // signature-derived seed on top of the runner's `{1000, 1}`
      // defaults. A `recalc` forces past the cache short-circuit.
      void runToCompletion(
        { ...mcInput, pathCount: PATH_COUNT, seed },
        kind === 'recalc' ? { force: true } : undefined,
      )
        .then((summary) => {
          // `null` = cancelled mid-flight (the provider settles the awaiter so a
          // caller cannot hang). Nothing new reached the screen, so the run that
          // IS on screen stays settled — a cancelled Recalculate leaves the plan
          // and its displayed summary exactly as they were.
          if (summary === null) return;
          setPrimaryRun((prev) =>
            prev.requested !== null && prev.requested.id === runId
              ? { ...prev, settled: { signature: currentSignature, summary } }
              : // A newer request already replaced this one — its own completion
                // is the only thing allowed to settle the pair.
                prev,
          );
        })
        .catch(() => {
          // A worker failure is already surfaced through the provider's `error`
          // (the retry button). It produces no new summary, so — as with a
          // cancel — the previously settled run stays settled; what withholds
          // the pair is a plan EDIT, via the signature comparison below.
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

  // Reroll replay: the call-site override stamps `pathCount: PATH_COUNT` +
  // a signature-derived seed on the run, so the worker's representative paths
  // were captured for THAT input. Mirror those two overrides here so the
  // main-thread replay reproduces the worker's path bit-for-bit (a divergent
  // `seed`/`pathCount` would replay a different sample). Returns null while the
  // input is invalid (no accounts / CBP-failed → `mcInput` is null).
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

  // Empty-state predicate: no accounts → render the empty card.
  // CBP-failing households fall through to the remediation banner,
  // never the empty card (the `cbpFailed` short-circuit on the chart
  // side handles that).
  // `AccountPayload` exposes `active` (boolean), not `isActive`; reading
  // `isActive` silently evaluates to `undefined` for every
  // household → `hasNoAccounts` always true → MC card never rendered.
  const hasNoAccounts =
    !runArgs ||
    extras.accounts.length === 0 ||
    runArgs.accounts.filter((a) => a.payload.active).length === 0;

  // A CBP flip valid→invalid (or any input that nulls `mcInput`)
  // must NOT leak the prior successful `useMonteCarlo()` result into
  // the success / stat cards — those cards don't gate on the
  // remediation banner. Null out the result locally when the current
  // input path is invalid so all derived fields read `—`.
  const result = mcInput === null ? null : rawResult;
  const isStale =
    result !== null &&
    lastRunSignature !== null &&
    currentSignature !== null &&
    lastRunSignature !== currentSignature;
  const isRunning = status === 'running';

  // Downturn-guardrail with/without comparison. The
  // hook owns the forced-off sibling run: when the active scenario ENABLES the
  // guardrail, derive the `enabled:false` sibling input (same seed / pathCount /
  // injected draws — only `enabled` differs, so the delta is a seed-paired
  // statistic), run it via `createMcPool`, and expose the paired delta. Absent
  // when guardrails are off. The effect owns pending/error/absent state and
  // disposes the pool on unmount / input change (bounded — one 1-worker pool).
  const guardrailEnabled = mcInput?.downturnGuardrails?.enabled === true;
  const [siblingResult, setSiblingResult] = useState<{
    pairKey: string;
    withoutPct: number | null;
    state: 'pending' | 'error' | 'ready';
  } | null>(null);
  // Dedupe guard: the PAIR KEY whose sibling run has already been STARTED. Kept
  // in a ref so the run-once check doesn't need `siblingResult` in the effect
  // deps (which would loop the effect on its own state write).
  const siblingStartedRef = useRef<string | null>(null);
  // Latest `mcInput`, read INSIDE the sibling effect but deliberately NOT a dep.
  // An mcInput identity churn that leaves the content-hash signature (and thus
  // pairKey) unchanged must not re-fire the effect and abort an in-flight run —
  // that would strand the comparison on its progress bar. The effect re-fires
  // only when pairKey genuinely changes; two hash-equal inputs build an
  // identical forced-off input, so reading the latest here is always correct.
  const mcInputRef = useRef(mcInput);
  mcInputRef.current = mcInput;
  // Settled = a request we ourselves kicked has COMPLETED, it was kicked for the
  // signature currently on screen, and the summary it produced is the one being
  // displayed. Each clause closes a distinct way the pair could otherwise
  // straddle two plans: `settled !== null` rejects the window before this hook's
  // own first run has ever completed (the provider may already hold another
  // surface's summary), `signature` rejects a summary produced for a superseded
  // plan — which is what withholds the pair across the whole cache-work + worker
  // window of an EDIT, since the retained settled signature is still the old
  // one — and `summary === result` rejects anything that replaced the provider's
  // result behind this hook's back.
  const primarySettled =
    result !== null &&
    primaryRun.settled !== null &&
    primaryRun.settled.signature === currentSignature &&
    primaryRun.settled.summary === result;
  // Pair the sibling on the PRIMARY run's ACTUAL seed, not the
  // signature-derived seed. A "Recalculate"/reroll diverges the primary seed
  // (recalc-counter- or Date.now()-derived) while the signature stays fixed —
  // re-deriving `seedFromString(currentSignature)` for the sibling would compare
  // two DIFFERENT MC samples. Keying on `{signature, seed}` both re-derives the
  // matched seed AND re-arms the effect after a recalc (new seed, same signature).
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
    // Only run the sibling once the PRIMARY run for this signature has settled,
    // so the comparison is seed-paired against the shown result.
    if (!primarySettled || primarySeed === null || pairKey === null) return;
    if (siblingStartedRef.current === pairKey) return;
    siblingStartedRef.current = pairKey;

    let disposed = false;
    let pool: ReturnType<typeof createMcPool> | null = null;
    setSiblingResult({ pairKey, withoutPct: null, state: 'pending' });
    const forcedOff: MonteCarloInput = {
      ...latestMcInput,
      pathCount: PATH_COUNT,
      // The primary run's ACTUAL seed — so the with/without pair is a true
      // within-path (seed-paired) comparison even after a recalc/reroll.
      seed: primarySeed,
      downturnGuardrails: { ...latestMcInput.downturnGuardrails!, enabled: false },
    };
    void (async () => {
      // Cache-first, mirroring the primary run (MonteCarloProvider). The key is
      // SEED-INCLUSIVE (unlike the primary's `mcCacheKey`, which strips the
      // seed): because `primarySeed === result.seed`, a cache hit is guaranteed
      // to be seed-paired with the primary's DISPLAYED result, and a manual
      // Recalculate (fresh seed) correctly misses and recomputes. Re-selecting an
      // UNCHANGED scenario now reuses the cached without-run instead of
      // recomputing this sibling MC pass on every scenario selection.
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
          // Fire-and-forget cache write (non-fatal on failure), like the primary.
          void putCached(key, reply.summary).catch(() => {});
          setSiblingResult({
            pairKey,
            withoutPct: reply.summary.successProbability,
            state: 'ready',
          });
        } else if (reply.kind === 'error') {
          setSiblingResult({ pairKey, withoutPct: null, state: 'error' });
        }
        // `aborted` → leave the pending state; the next effect run supersedes it.
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
    // `mcInput` is intentionally NOT a dep (read via `mcInputRef`): identity
    // churn with an unchanged pairKey must not re-fire this effect (see the ref).
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
  // `lifeMarkers` carry the integer death year (death = Dec 31 of
  // `deathYear`), so `Math.ceil` is the identity — `lastDeathYear`
  // equals the integer death year.
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
    // Reuses the guardrail sibling's pair key: non-null ONLY once a primary
    // REQUEST kicked for the current signature has completed and its summary is
    // the one on screen, so an edit still working its way through the debounce,
    // the cache read, or the worker withholds the comparison instead of pairing
    // across that edit.
    stressPairSignature: pairKey,
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
 * Build the seed-paired guardrail comparison VM.
 *
 * SE is a conservative UNPAIRED-SE UPPER BOUND, not a true paired SE.
 * The two runs ARE seed-paired (same seed / draws → a within-path delta), but
 * the MC engine is summary-only with NO per-path retention (full
 * reproducibility comes from the seed), so the per-path pass/fail
 * outcomes needed for a true paired SE are unavailable. We therefore gate the
 * delta with the INDEPENDENT two-proportion SE `sqrt(p(1−p)/n + q(1−q)/n)`
 * computed from the two marginal success rates. This is an UPPER BOUND on the
 * true paired SE (positive within-path correlation makes the paired SE
 * smaller), so the gate errs CONSERVATIVE — it can only over-suppress a real
 * delta, never manufacture false signal. The delta is rendered as signal only
 * when it exceeds this bound (else "≈ no change"). Returns pending/error states
 * when the sibling run has not settled. The SE formula and verdict live in
 * `lib/success-delta-noise.ts`; both runs share this path count.
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

/** Empty-state CTA — render in place of the stress-test cards/chart
 *  when the household has no accounts (or zero portfolio today). */
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

/** Running-indicator (determinate `McProgressBar` + Cancel) + error
 *  toast. Renders only when a run is in flight or errored; the progress
 *  bar replaced the prior "Crunching stress-test numbers…" text badge. */
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
 * Manual "Recalculate" control — forces a fresh MC run (bypassing the
 * cache, fresh seed) so the user can resample without changing the
 * plan. Available whenever a result is shown (idle/done); disabled while
 * a run is in flight or the input is invalid (no accounts / CBP-failed).
 * Renders in the "Stress-test outcomes" card header next to the status
 * row.
 *
 * `ariaLabel` defaults to "Recalculate plan stress test". The Balance
 * Projection chart-header instance overrides it ("Recalculate the
 * example projection") so the two on-page instances carry distinct
 * accessible names.
 */
export function PlanStressTestRecalcButton({
  vm,
  ariaLabel = 'Recalculate plan stress test',
}: {
  vm: PlanStressTestVm;
  ariaLabel?: string;
}) {
  // Hide entirely when there's nothing to recalculate yet (empty state
  // or CBP-failed → the remediation banner owns that surface).
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
