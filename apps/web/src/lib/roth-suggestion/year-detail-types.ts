/**
 * The shapes of the year-by-year table behind each plan: plain data, nominal
 * dollars, so the search can build it in a worker and the page only formats it.
 */
import type { DrawdownYear } from '../drawdown-engine-types';
import type { FilingStatus } from '../federal-tax';

/** What stopped a year's conversion. The first three name the limit that
 *  bound a conversion; the rest say why a year converted less than that. */
export type YearLimitKind =
  | 'bracket'
  | 'irmaa'
  | 'aca'
  /** No conversion was attempted: the year is past the window. */
  | 'outside-window'
  /** The RMD and spending withdrawals reached the ceiling (or went past it). */
  | 'already-over'
  /** All the pre-tax money converted and the income stayed under the ceiling. */
  | 'pre-tax-ran-out'
  /** The engine found no target Roth, so it converted $0. */
  | 'no-target'
  /** The current plan: its ceiling is the scenario's own, not one of ours. */
  | 'plan-setting'
  /** Income stayed under the ceiling for a reason the row does not record. */
  | 'under-ceiling';

/** The three limits on the one income line the plan is held to; null where a
 *  limit does not apply to the year (an unguarded plan, no Medicare, ...). */
export interface YearDetailLines {
  readonly bracketDollars: number;
  readonly irmaaDollars: number | null;
  readonly acaDollars: number | null;
}

/** What the next dollars over a cliff would have cost, for a year a cliff stopped. */
export interface YearCrossingNote {
  readonly line: 'irmaa' | 'aca';
  /** The extra conversion probed: what the plan without the guard would have added. */
  readonly extraConvertedDollars: number;
  /** Extra Medicare surcharge, paid two years later. */
  readonly medicareSurchargeDollars: number;
  /** Premium credit lost, at full value (the projection clips it, see the footnote). */
  readonly acaCreditLostDollars: number;
}

export interface YearDetailRow {
  readonly year: number;
  readonly inWindow: boolean;
  /** Null outside the window, where no limit or income line is worked out. */
  readonly filingStatus: FilingStatus | null;
  readonly limitKind: YearLimitKind;
  readonly amountDollars: number;
  /** Null on the current plan and outside the window. */
  readonly lines: YearDetailLines | null;
  /** The smallest line: the income the plan means to stay at or under. */
  readonly limitDollars: number | null;
  /** Income on that line before the conversion and after it. */
  readonly incomeBeforeDollars: number | null;
  readonly incomeAfterDollars: number | null;
  /** Social Security the conversion made taxable that was not before. */
  readonly extraTaxableSsDollars: number | null;
  /** Limit less income after: the search's few dollars of margin. */
  readonly keptUnderDollars: number | null;
  readonly reroutedDollars: number;
  readonly breachedDollars: number;
  readonly incomeTaxDollars: number;
  readonly taxableSsDollars: number;
  readonly ssTier: NonNullable<DrawdownYear['ssTaxationTier']>;
  /** Medicare surcharge paid this year, and the one this year's income sets. */
  readonly irmaaPaidDollars: number;
  readonly irmaaSetDollars: number | null;
  readonly acaCreditDollars: number;
  /** Months of Marketplace coverage in the year; the engine's tier below means
   *  something only when this is above 0. Null where the year's facts are not
   *  worked out (outside the window). */
  readonly marketplaceMonths: number | null;
  readonly acaTier: NonNullable<DrawdownYear['acaPtcTier']>;
  /** Pre-tax and mixed account money at year end. */
  readonly preTaxEndDollars: number;
  readonly crossingNote: YearCrossingNote | null;
}
