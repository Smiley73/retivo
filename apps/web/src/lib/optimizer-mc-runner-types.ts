/**
 * Shared types for `optimizer-mc-runner.ts` + its helper sibling.
 * Lives in a tiny sibling file so the helper module can import the
 * `OptimizerMcOutcome` / `OptimizerMcWinner` shapes without a circular
 * import on the main orchestrator.
 */
export interface OptimizerMcWinner {
  readonly primaryAgeYears: number;
  readonly secondaryAgeYears: number | null;
  readonly metricValue: number;
}

/**
 * Per-scenario outcome. Mirrors
 * the deterministic worker's `OptimizerWorkerOutbound` variants so the
 * page consumes one row shape across both metrics:
 *  - `result` — full row contract (winner + partial + missing PIA +
 *    alreadyAtOptimum); `winner: null` is past-window.
 *  - `empty` — `no-primary-member` / `no-retirement-date`.
 *    Surface the same EmptyReasonRow copy the deterministic path
 *    renders instead of wrapping the raw error message.
 *  - `unsupported` — only `cbp-unconfigured` reason.
 *  - `error` — per-scenario surface; other scenarios continue running.
 *  - `cancelled` — distinguishes "not computed due to abort"
 *    from `winner: null` (past-window). The page omits cancelled
 *    scenarios from the populated row map rather than rendering them
 *    with the past-window copy.
 */
export type OptimizerMcOutcome =
  | {
      readonly kind: 'result';
      readonly winner: OptimizerMcWinner | null;
      readonly partial: boolean;
      readonly missingPiaMembers: ReadonlyArray<string>;
      readonly alreadyAtOptimum: boolean;
      /** MC success probability at the scenario's current claim ages —
       *  drives the "current → recommended" metric cell. `undefined` when
       *  the current pair isn't a whole-year candidate in the grid. */
      readonly baselineMetricValue?: number;
      /** Disclosure only: the fixed primary death age the optimizer
       *  assumed for this scenario. */
      readonly assumedDeathAge?: number;
    }
  | {
      readonly kind: 'empty';
      readonly reason: 'no-primary-member' | 'no-retirement-date';
    }
  | { readonly kind: 'unsupported'; readonly reason: 'cbp-unconfigured' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' };

export type OptimizerMcResult = ReadonlyMap<string, OptimizerMcOutcome>;

/**
 * Smooth per-scenario progress (path units). Emitted as the in-flight
 * scenario's candidate grid simulates, so the page can drive a
 * per-row progress bar that climbs to 100 % before the row resolves.
 * `done`/`total` span the scenario's *entire* triple grid:
 * `total = triples × pathCount`, `done = completedTriples × pathCount +
 * currentTripleDonePaths`.
 */
export interface OptimizerMcScenarioProgress {
  readonly done: number;
  readonly total: number;
}
