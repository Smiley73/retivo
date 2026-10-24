// Typed contract for year-keyed financial calibration constants. The yearly refresh steps are in `docs/yearly-tax-refresh.md`.

type CalibrationYear = number;

type Jurisdiction = string;

/**
 * Year-keyed calibration table for one data type `T`, with one source and as-of
 * date per snapshot (a multi-year snapshot lists each publication's permalink,
 * comma-separated, with the latest publish date). One federal domain lookup that
 * combines agencies' values for the same year (ACA PTC: IRS bands plus HHS FPL)
 * is a single composite snapshot, e.g. `ACA_PTC_PARAMETERS`; unrelated domains
 * stay separate snapshots composed at the call site. A projection run resolves
 * the snapshot once and passes it to every engine call; engines never read
 * calibration config directly.
 */
export interface CalibrationSnapshot<T> {
  /** Handling of years outside the supplied range (throw or clamp) is each consumer's call. */
  readonly values: Readonly<Record<CalibrationYear, T>>;

  readonly metadata: {
    /** Stable permalinks or statutory citations; one per year, in chronological order, for a multi-year snapshot. */
    readonly source: string;

    /** ISO date the source was published or last verified; maintainers use it to spot stale snapshots at the yearly refresh. */
    readonly asOfDate: string;

    /** Defaults to `"US-federal"`; `"US-<state-code>"` for a state. */
    readonly jurisdiction?: Jurisdiction;
  };
}
