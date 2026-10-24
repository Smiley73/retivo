// Typed contract for year-keyed financial calibration constants. The yearly refresh steps are in `docs/yearly-tax-refresh.md`.

type CalibrationYear = number;

type Jurisdiction = string;

/** Year-keyed table of `T` with one source and as-of date; one federal domain combining several agencies' values for a year (ACA PTC) is one composite snapshot, unrelated domains stay separate. */
export interface CalibrationSnapshot<T> {
  readonly values: Readonly<Record<CalibrationYear, T>>;

  readonly metadata: {
    readonly source: string;

    readonly asOfDate: string;

    /** Defaults to `"US-federal"`; `"US-<state-code>"` for a state. */
    readonly jurisdiction?: Jurisdiction;
  };
}
