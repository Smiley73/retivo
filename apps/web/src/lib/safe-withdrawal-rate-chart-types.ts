// Row and bundle shapes for the safe-withdrawal-rate comparison; in `lib/` so the lazy chart wrapper and its Inner component do not form an import cycle (`no-cycles`).

import type { SafeWithdrawalRuleFigures } from './safe-withdrawal-rate';

/** One plotted year's four stack layers (guaranteed income, other income, after-tax portfolio draw, tax on that draw), resolved to the active basis and dollar mode; an empty layer is `0`, never `null`. */
export interface SwrComparisonYearRow {
  readonly year: number;
  /** Social Security plus pension/annuity income, capped at planned spend. */
  readonly guaranteedIncome: number;
  /** Wages and windfalls beyond `guaranteedIncome`, capped so the layers never sum past planned spend plus tax. */
  readonly otherIncome: number;
  /** The portfolio draw net of its tax; the only layer the rule lines are compared against. */
  readonly afterTaxDraw: number;
  readonly tax: number;
  readonly guaranteedIncomeSplit: {
    readonly socialSecurity: number;
    readonly pension: number;
  };
  readonly guaranteedIncomeSurplus: number;
  /** The 4% rule's implied first-year spend in this year's dollar mode; `null` for a row the comparison excludes. */
  readonly fourPercentRuleValue: number | null;
  readonly fourPointFivePercentRuleValue: number | null;
  /** A partial transition year: carried in the window, excluded from the rule comparison. */
  readonly isPartialYear: boolean;
}

/** Every degenerate state plus `'ok'`; `'no-full-retirement-year'` means the anchor year lies past `drawdownEndYear`, so there is no first-year draw and no bundle. */
export type SwrComparisonState =
  | 'ok'
  | 'no-runner-result'
  | 'no-retirement-year'
  | 'historical-unavailable'
  | 'mc-run-unavailable'
  | 'mc-index-out-of-range'
  | 'no-full-retirement-year';

/** Per-year rows, the anchor scalar, the two rule figures, and the soft flags that do not fail the whole bundle. */
export interface SwrComparisonBundle {
  readonly rows: ReadonlyArray<SwrComparisonYearRow>;
  readonly portfolioAtRetirement: number;
  readonly anchorYear: number;
  readonly anchorAfterTaxDraw: number;
  /** Re-expressed into the bundle's display mode at `anchorYear`, unlike the today's-dollars figures `lib/safe-withdrawal-rate.ts` returns. */
  readonly fourPercentRule: SafeWithdrawalRuleFigures;
  readonly fourPointFivePercentRule: SafeWithdrawalRuleFigures;
  /** From the resolved drawdown run, to mark the post-depletion region; `null` when nothing depletes. */
  readonly depletionYear: number | null;
  /** No row carries a tax figure (an MC `successOnly` capture skips the replay): every `tax` is `0` and the layer is omitted, not drawn as a zero-tax year. */
  readonly noTaxFigures: boolean;
  /** Years between the portfolio's valuation point (December of the transition year; the year before, under MC) and the first full retirement year. */
  readonly valuationOffsetYears: number;
}

export interface SwrComparisonResult {
  readonly state: SwrComparisonState;
  readonly bundle: SwrComparisonBundle | null;
}
