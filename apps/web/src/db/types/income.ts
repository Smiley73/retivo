/**
 * Income-stream aggregate payload (pension / part-time / one-off windfall).
 * Consumes the shared `ScheduleStart` / `ScheduleEnd` vocabulary from
 * `aggregate-base.ts`.
 */

import type { ScheduleEnd, ScheduleStart } from './aggregate-base';

/** A pension can pay out as a lifetime annuity or as a one-time
 *  lump-sum (typical Cash Balance Pension election). */
export type PensionPayoutType = 'annuity' | 'lumpSum';

/** Income kinds. `pension` covers traditional + cash-balance with the
 *  payoutType discriminator. `partTime` is recurring earned income.
 *  `oneOff` is a single-year windfall (inheritance, asset sale,
 *  pension lump-sum payout — model whichever the user prefers). */
export type IncomeStreamKind = 'pension' | 'partTime' | 'oneOff';

/** Joint-and-survivor election percentage on a pension annuity.
 *  After the pensioner dies, the surviving spouse receives this
 *  percentage of the original benefit (still COLA-adjusted) for life.
 *  `0` means single-life — pension dies with the pensioner. Federal
 *  and many private plans default to 50; 75 / 100 are upgrades the
 *  retiree elected (typically at the cost of a smaller initial
 *  benefit). */
export type JointAndSurvivorPct = 0 | 50 | 75 | 100;

/** One-off / windfall sub-category — for the user's own labeling.
 *  Engine treats every oneOff identically. */
export type OneOffIncomeSource = 'inheritance' | 'assetSale' | 'other';

/**
 * Income-source aggregate. One row per pension / part-time gig /
 * windfall the household expects. Attached to a single household
 * member (JOINT income isn't a thing — even a survivor benefit is
 * paid to a single surviving spouse). The drawdown engine reads
 * this list to compute per-year non-portfolio income; gross expense
 * minus that income is the net withdrawal need each year.
 *
 * Field set is conditional on `kind` (and `payoutType` when
 * `kind === 'pension'`). Form-level validation enforces the matrix:
 *
 * | kind / payoutType        | Required fields |
 * | ------------------------ | --------------- |
 * | pension / annuity        | monthlyBenefit, start, colaPct, jointAndSurvivorPct |
 * | pension / lumpSum        | lumpSumAmount, start, targetAccountId |
 * | partTime                 | annualAmount, start, end, colaPct |
 * | oneOff                   | oneOffAmount, start, targetAccountId |
 *
 * `start` (and `end` for partTime) uses the shared `ScheduleStart` /
 * `ScheduleEnd` vocabulary. `retirementStart` on income anchors to the
 * **owner's** retirement date (asymmetric vs expense's household-level
 * anchor). `age.memberId` is omitted on
 * income because the stream's `memberId` UUID already declares the
 * implicit owner; partTime may set it explicitly to anchor to the
 * non-owner spouse.
 */
export interface IncomeStreamPayload extends Record<string, unknown> {
  /** Required, max 60. Unique within household (case-folded, trimmed). */
  name: string;
  /** Optional, max 200. */
  notes?: string;
  /** Owning HouseholdMember id. */
  memberId: string;
  /** Top-level discriminator. */
  kind: IncomeStreamKind;

  /** When the income begins (or, for single-event kinds, when the
   *  payment / windfall is received). Annuity: payment-start anchor;
   *  lumpSum: receipt anchor; partTime: schedule-start anchor; oneOff:
   *  receipt anchor. */
  start?: ScheduleStart;
  /** End of recurring window. partTime only — annuity is lifetime
   *  (J&S governs survivor share), lumpSum + oneOff are single events. */
  end?: ScheduleEnd;

  // ---------- pension fields ----------
  /** Set on `kind === 'pension'`. */
  payoutType?: PensionPayoutType;
  /** USD/month. `kind === 'pension'` + `payoutType === 'annuity'`. */
  monthlyBenefit?: number;
  /** USD. `payoutType === 'lumpSum'`. */
  lumpSumAmount?: number;
  /** Joint-and-survivor election (annuity-only). */
  jointAndSurvivorPct?: JointAndSurvivorPct;
  /** Link to the Cash Balance Pension (CBP) account this pension
   *  stream is paid from. Valid on `kind === 'pension'` with either
   *  `payoutType === 'annuity'` (zero the source account at retirement
   *  and pay the monthly benefit from this stream) or
   *  `payoutType === 'lumpSum'` (rollover the account balance into
   *  `targetAccountId` at retirement). Renamed from the legacy
   *  annuity-only `sourceAccountId`. */
  linkedCbpAccountId?: string;
  /** Account that receives a lump-sum or one-off deposit at receipt
   *  year. Required on `payoutType === 'lumpSum'` and `kind === 'oneOff'`. */
  targetAccountId?: string;

  // ---------- partTime fields ----------
  /** USD/year. `kind === 'partTime'`. */
  annualAmount?: number;

  // ---------- oneOff fields ----------
  /** USD. `kind === 'oneOff'`. */
  oneOffAmount?: number;
  /** User-chosen sub-category label. */
  source?: OneOffIncomeSource;

  // ---------- shared optional fields ----------
  /** Annual COLA on this stream's benefit. Used by pension/annuity
   *  and partTime. Present and meaningful only when `tracksInflation`
   *  is absent or `false`. When `tracksInflation === true` this key
   *  must be absent (persistence rule — never store `0` or `null`
   *  alongside `tracksInflation: true`). SS COLA is on the scenario,
   *  not here. */
  colaPct?: number;
  /** When `true`, this stream's growth rate follows the scenario
   *  inflation rate (`scenario.inflation.ratePct`) rather than a fixed
   *  `colaPct`. Absent / `false` → use `colaPct ?? 0`. Present on the
   *  initial v1 payload at creation; no migration (pre-launch v1 reset). */
  tracksInflation?: boolean;
  /** Future-tax-engine scaffolding: whether this income is taxable as
   *  ordinary income. Defaults to true. Not consumed by the v1
   *  drawdown engine (no tax modeling). */
  taxable?: boolean;
}
