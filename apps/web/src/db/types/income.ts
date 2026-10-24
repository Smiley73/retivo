// Income-stream payload (pension, part-time, one-off windfall), using `ScheduleStart`/`ScheduleEnd` from `aggregate-base.ts`.

import type { ScheduleEnd, ScheduleStart } from './aggregate-base';

/** A pension pays as a lifetime annuity or a one-time lump sum (a typical Cash Balance Pension election). */
export type PensionPayoutType = 'annuity' | 'lumpSum';

/**
 * Income kinds: `pension` (traditional or cash-balance, split by `payoutType`), recurring `partTime`, and single-year
 * `oneOff` windfall (inheritance, asset sale, pension lump-sum payout).
 */
export type IncomeStreamKind = 'pension' | 'partTime' | 'oneOff';

/**
 * Joint-and-survivor election: the percentage of the benefit (still COLA-adjusted) the surviving spouse gets for life;
 * `0` is single-life.
 */
export type JointAndSurvivorPct = 0 | 50 | 75 | 100;

/** Sub-category label for a one-off windfall; the engine treats every `oneOff` identically. */
export type OneOffIncomeSource = 'inheritance' | 'assetSale' | 'other';

/**
 * One pension, part-time gig or windfall, attached to a single household member (a survivor benefit is paid to one
 * spouse); the drawdown engine nets these against gross expense for each year's withdrawal need. Required fields depend
 * on `kind` (and `payoutType` for pensions), enforced at form level:
 *
 * | kind / payoutType        | Required fields |
 * | ------------------------ | --------------- |
 * | pension / annuity        | monthlyBenefit, start, colaPct, jointAndSurvivorPct |
 * | pension / lumpSum        | lumpSumAmount, start, targetAccountId |
 * | partTime                 | annualAmount, start, end, colaPct |
 * | oneOff                   | oneOffAmount, start, targetAccountId |
 *
 * `retirementStart` anchors to the owner's retirement date (expense anchors at household level). `age.memberId` is
 * omitted because `memberId` already names the owner; partTime may set it to anchor to the non-owner spouse.
 */
export interface IncomeStreamPayload extends Record<string, unknown> {
  /** Required, max 60. Unique within household (case-folded, trimmed). */
  name: string;
  /** Optional, max 200. */
  notes?: string;
  /** Owning HouseholdMember id. */
  memberId: string;
  kind: IncomeStreamKind;

  /**
   * When the income begins, or for single-event kinds when it is received (annuity payment start, lump-sum receipt,
   * partTime schedule start, oneOff receipt).
   */
  start?: ScheduleStart;
  /** End of the recurring window; partTime only (an annuity is lifetime, lump sum and one-off are single events). */
  end?: ScheduleEnd;

  /** Set on `kind === 'pension'`. */
  payoutType?: PensionPayoutType;
  /** USD/month. `kind === 'pension'` + `payoutType === 'annuity'`. */
  monthlyBenefit?: number;
  /** USD. `payoutType === 'lumpSum'`. */
  lumpSumAmount?: number;
  /** Joint-and-survivor election (annuity-only). */
  jointAndSurvivorPct?: JointAndSurvivorPct;
  /**
   * The Cash Balance Pension account this pension is paid from: on an annuity it is zeroed at retirement and the stream
   * pays the benefit; on a lump sum its balance rolls into `targetAccountId`.
   */
  linkedCbpAccountId?: string;
  /** Account receiving a lump sum or one-off deposit; required for `lumpSum` and `oneOff`. */
  targetAccountId?: string;

  /** USD/year. `kind === 'partTime'`. */
  annualAmount?: number;

  /** USD. `kind === 'oneOff'`. */
  oneOffAmount?: number;
  /** User-chosen sub-category label. */
  source?: OneOffIncomeSource;

  /**
   * Annual COLA for pension/annuity and partTime, meaningful only when `tracksInflation` is absent or false; when
   * `tracksInflation === true` this key must be absent (never store `0` or `null` beside it). SS COLA is on the
   * scenario.
   */
  colaPct?: number;
  /**
   * When true, growth follows the scenario inflation rate (`scenario.inflation.ratePct`) instead of `colaPct`; absent
   * or false uses `colaPct ?? 0`.
   */
  tracksInflation?: boolean;
  /**
   * Scaffolding for a future tax engine: taxable as ordinary income (default true); not consumed by the v1 drawdown
   * engine.
   */
  taxable?: boolean;
}
