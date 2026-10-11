/**
 * Row + bundle shapes for the Balance Projection page's basis-aware
 * safe-withdrawal-rate (SWR) comparison.
 * Lives in `lib/` (not a component or page file) so the chart wrapper's
 * `lazy()`-import of Inner and Inner's import of this type don't form a
 * cycle (`.dependency-cruiser.cjs` — `no-cycles`; mirrors
 * `lib/cashflow-chart-types.ts`'s split for the same lazy-wrapper/Inner
 * pattern).
 */
import type { SafeWithdrawalRuleFigures } from './safe-withdrawal-rate';

/**
 * One plotted year's four peer stack layers (bottom to top: guaranteed
 * income, other income, after-tax portfolio draw, tax on that draw) for the
 * Balance Projection page's basis-aware SWR comparison.
 * Every dollar field is already resolved to the
 * active basis and dollar mode; the chart plots this shape without re-deriving
 * anything. A layer with no dollars in a given year is a plain `0`, never
 * `null`/absent — the chart decides whether to omit the segment visually.
 */
export interface SwrComparisonYearRow {
  readonly year: number;
  /** Social Security + pension/annuity income, capped at the year's planned
   *  spend (see `guaranteedIncomeSurplus`) and floored at 0. Bottom layer. */
  readonly guaranteedIncome: number;
  /** Part-time wages / one-off windfalls — the rest of the year's spendable
   *  income beyond `guaranteedIncome`, capped so the four layers never sum
   *  past planned spend + tax. Second layer. `0` in a year with none. */
  readonly otherIncome: number;
  /** The portfolio draw net of the tax it funds, floored at 0. Third layer —
   *  the only layer the rule lines are compared against. */
  readonly afterTaxDraw: number;
  /** The tax `afterTaxDraw` funds (federal + IRMAA − ACA PTC, clamped ≥ 0).
   *  Top layer. `0` when the bundle's `noTaxFigures` flag is set. */
  readonly tax: number;
  /** `guaranteedIncome`'s own Social Security / pension split, summing to it
   *  exactly (proportionally scaled down together when capping shrinks the
   *  combined figure) — tooltip detail, not a fifth layer. */
  readonly guaranteedIncomeSplit: {
    readonly socialSecurity: number;
    readonly pension: number;
  };
  /** The amount by which UNCAPPED guaranteed income would have exceeded the
   *  year's planned spend, had it not been capped — a tooltip figure, never
   *  drawn as a negative segment. `0` in every year with no surplus. */
  readonly guaranteedIncomeSurplus: number;
  /** The 4% rule's implied first-year spend, re-expressed for THIS year's
   *  dollar mode (flat under Today's-dollars; inflated forward under
   *  Future-dollars) — `null` for a row the comparison excludes (the
   *  partial retirement-transition year, before the anchor). */
  readonly fourPercentRuleValue: number | null;
  /** Same as `fourPercentRuleValue`, for the 4.5% rule. */
  readonly fourPointFivePercentRuleValue: number | null;
  /** `true` only for the retirement TRANSITION year when it is not already
   *  a full year of retirement — a calendar-year total there is a
   *  partial-year figure, carried in the window but excluded from the rule
   *  comparison (both rule fields are `null` on this row). */
  readonly isPartialYear: boolean;
}

/** Every degenerate state this data shape represents distinctly (module
 *  docblock, `balance-projection-swr-derivation.ts`), plus `'ok'`.
 *  `'no-full-retirement-year'`: the window holds no full retirement year —
 *  the anchor year lies past `drawdownEndYear` (a mid-year retirement whose
 *  plan ends in the transition year itself, or a window that closes before
 *  it starts), so there is no first-year draw to compare and no bundle. */
export type SwrComparisonState =
  | 'ok'
  | 'no-runner-result'
  | 'no-retirement-year'
  | 'historical-unavailable'
  | 'mc-run-unavailable'
  | 'mc-index-out-of-range'
  | 'no-full-retirement-year';

/** Everything 02/03 need beyond the per-year rows — the anchor scalar both
 *  the rule deltas and 03's card spend figure read, the two rule figures
 *  (reused unchanged from `lib/safe-withdrawal-rate.ts`), and the two soft
 *  flags (`noTaxFigures`, `depletionYear`) that don't fail the whole bundle. */
export interface SwrComparisonBundle {
  readonly rows: ReadonlyArray<SwrComparisonYearRow>;
  /** Net portfolio at retirement, active basis + dollar mode. */
  readonly portfolioAtRetirement: number;
  /** The first FULL retirement year — the comparison's anchor. */
  readonly anchorYear: number;
  /** `rows.find(r => r.year === anchorYear).afterTaxDraw` — the one scalar
   *  both rule deltas and 03's card spend figure read (one source). */
  readonly anchorAfterTaxDraw: number;
  /** The 4% rule's figures, RE-EXPRESSED into the bundle's active display
   *  mode at `anchorYear` (unlike `SafeWithdrawalRuleFigures`'s own generic
   *  "today's dollars" doc, which describes the type as returned by
   *  `lib/safe-withdrawal-rate.ts` directly) — so `impliedFirstYearAnnualSpend`
   *  equals `rows.find(r => r.year === anchorYear).fourPercentRuleValue` and
   *  `plannedMinusRuleFirstYearDelta` is comparable to `anchorAfterTaxDraw`. */
  readonly fourPercentRule: SafeWithdrawalRuleFigures;
  /** Same re-expression as `fourPercentRule`, for the 4.5% rule. */
  readonly fourPointFivePercentRule: SafeWithdrawalRuleFigures;
  /** Carried through from the resolved drawdown/representative run so 02 can
   *  mark the post-depletion region; `null` when nothing depletes. */
  readonly depletionYear: number | null;
  /** State (5): no row in the window carries a tax figure (optional on
   *  `DrawdownYear`; an MC `successOnly` capture skips the replay that
   *  populates them) — every row's `tax` is `0` and 02/03 should omit that
   *  layer rather than draw a false zero-tax year. */
  readonly noTaxFigures: boolean;
  /** Whole calendar years between the portfolio's valuation point (December
   *  of the retirement transition year, deterministic; December of the year
   *  BEFORE, under MC) and the spend series' first point (the first full
   *  retirement year) — `0` for a January-1 retirement, the disclosure
   *  hook otherwise. */
  readonly valuationOffsetYears: number;
}

/** The basis-aware SWR data layer's one return shape — a degenerate-state
 *  marker with no bundle, or `'ok'` with one. */
export interface SwrComparisonResult {
  readonly state: SwrComparisonState;
  readonly bundle: SwrComparisonBundle | null;
}
