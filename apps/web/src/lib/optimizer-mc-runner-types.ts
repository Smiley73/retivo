// Shared types for `optimizer-mc-runner.ts` and its helpers, in a sibling file to avoid a circular import.

export interface OptimizerMcWinner {
  readonly primaryAgeYears: number;
  /** Absent or 0 is a whole year; see `Winner` in `pick-winner.ts`. */
  readonly primaryAgeMonths?: number;
  readonly secondaryAgeYears: number | null;
  readonly secondaryAgeMonths?: number;
  readonly metricValue: number;
}

/**
 * Per-scenario outcome, mirroring the deterministic worker's variants so the page consumes one row shape. `result` with `winner: null` is past-window;
 * `empty` surfaces the same EmptyReasonRow copy as the deterministic path; `cancelled` (aborted, not computed) is omitted from the page's row map.
 */
export type OptimizerMcOutcome =
  | {
      readonly kind: 'result';
      readonly winner: OptimizerMcWinner | null;
      readonly partial: boolean;
      readonly missingPiaMembers: ReadonlyArray<string>;
      readonly alreadyAtOptimum: boolean;
      /** MC success probability at the current claim ages; undefined when the current pair is not a candidate (the 1-D fallback). */
      readonly baselineMetricValue?: number;
      /** The fixed primary death age assumed, for disclosure only. */
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

/** Per-scenario progress in path units: `total = triples × pathCount`, `done` counts completed triples plus in-flight paths. */
export interface OptimizerMcScenarioProgress {
  readonly done: number;
  readonly total: number;
}
