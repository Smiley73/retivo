/**
 * Typed contract for year-keyed financial calibration constants
 * (tax brackets, IRMAA tiers, RMD divisors, ACA FPL thresholds, etc.).
 *
 * The yearly refresh steps (and the checked-answer fixtures that pin each
 * year) are in `docs/yearly-tax-refresh.md`.
 */

/**
 * A calendar year used as the index key in a {@link CalibrationSnapshot}.
 *
 * Consumers narrow this to their own valid range (e.g. federal-tax narrows
 * to the years whose bracket tables have been shipped). At the schema layer
 * it is kept as `number` so the shape scales without code changes as new
 * years are added.
 */
type CalibrationYear = number;

/**
 * A jurisdiction tag attached to a {@link CalibrationSnapshot}.
 *
 * Convention: `"US-federal"` for federal tables; `"US-<state-code>"` for a
 * state (e.g. `"US-CA"`). Other forms are allowed for future jurisdictions.
 * When absent the consumer defaults to US-federal. Consumers wanting both
 * federal and state tables use two separate snapshot constants distinguished
 * by this field — no nested-jurisdiction nesting inside a single snapshot.
 */
type Jurisdiction = string;

/**
 * Snapshot of a year-keyed calibration table for a single data type `T`.
 *
 * One source URL and as-of date are recorded once per snapshot. Multi-year
 * snapshots citing sequential annual publications of the same series (e.g.
 * successive IRS Rev Procs) may use a comma-separated `metadata.source`
 * listing each publication's stable permalink, with `metadata.asOfDate` set
 * to the most-recent publication's publish date.
 *
 * **Consumer-domain composite snapshots** are also permitted: where a single
 * federal domain lookup (e.g. ACA PTC under IRC §36B) naturally combines
 * values published by separate federal agencies for the same tax year (IRS
 * applicable-figure bands + HHS FPL parameters), bundle them in one snapshot
 * rather than splitting — the domain boundary is the lookup, not the agency.
 * For such composites `metadata.source` lists all contributing URLs
 * chronologically and `metadata.asOfDate` is the most-recent publication.
 * `ACA_PTC_PARAMETERS` is the canonical
 * example. Arbitrary cross-domain bundling (e.g. tax brackets + IRMAA tiers)
 * remains out of scope — use two separate snapshots composed at the call site.
 *
 * @example
 * ```ts
 * // Federal tax config snapshot spanning two Rev Proc years (type narrowed by the consumer)
 * const FEDERAL_TAX_CONFIG: CalibrationSnapshot<TaxConfig> = {
 *   values: {
 *     2024: { brackets: [...], standardDeduction: { Single: 14600, MFJ: 29200 } },
 *     2025: { brackets: [...], standardDeduction: { Single: 15000, MFJ: 30000 } },
 *   },
 *   metadata: {
 *     source: 'https://www.irs.gov/pub/irs-drop/rp-23-34.pdf, https://www.irs.gov/pub/irs-drop/rp-24-40.pdf',
 *     asOfDate: '2024-11-01',
 *     jurisdiction: 'US-federal',
 *   },
 * };
 * ```
 *
 * Snapshot pinning: a projection run resolves the snapshot once at the start
 * and passes it through every engine call. Engines never read calibration
 * config directly — they accept `CalibrationSnapshot<T>` as a parameter.
 */
export interface CalibrationSnapshot<T> {
  /**
   * Year-keyed values. Each key is a {@link CalibrationYear}; the value is
   * the fully-typed constant for that year. Consumers look up by the
   * projection year and are responsible for handling years outside the
   * supplied range (throw or clamp — their call, documented in each
   * consumer).
   */
  readonly values: Readonly<Record<CalibrationYear, T>>;

  /** Source and currency metadata for the whole snapshot. */
  readonly metadata: {
    /**
     * Citation for the data source (IRS Rev Proc, SSA publication,
     * CMS announcement, etc.). For single-year snapshots: a stable permalink,
     * not a landing page. For multi-year snapshots: comma-separated stable
     * permalinks or statutory citations, one per year in chronological order
     * (e.g. `"https://…/rp-23-34.pdf, https://…/rp-24-40.pdf, 26 U.S.C. §1(j)"`).
     */
    readonly source: string;

    /**
     * ISO 8601 date (`YYYY-MM-DD`) when the source was published or last
     * verified. Used by maintainers during the annual IRS Rev Proc refresh
     * (typically October–November) to identify stale snapshots.
     */
    readonly asOfDate: string;

    /**
     * Optional jurisdiction tag. Defaults to `"US-federal"` when absent.
     * See {@link Jurisdiction} for the naming convention.
     */
    readonly jurisdiction?: Jurisdiction;
  };
}
