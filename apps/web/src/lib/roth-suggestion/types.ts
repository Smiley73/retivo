/**
 * Public types of the Roth conversion suggestion search: the request, the
 * per-candidate result and the typed unsupported / cancelled / error outcomes.
 * Pure data shapes, no React, so the search can run in a worker.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  MagiCapWindow,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import type { FilingStatus } from '../federal-tax';
import type { ScenarioAggregate } from '../scenario-resolution';
import type { TaxCalibrationBundle } from '../tax-integration-helpers';

/** The projection inputs the Roth conversion comparison page already assembles
 *  (the shape `buildRothBETRPageData` takes), so the page passes them as is. */
export interface RothSuggestionProjectionInput {
  readonly scenarios: readonly ScenarioAggregate[];
  readonly selectedScenarioId: string;
  readonly accounts: readonly Aggregate<AccountPayload>[];
  readonly balances: readonly Aggregate<AccountBalancePayload>[];
  readonly members: readonly Aggregate<HouseholdMemberPayload>[];
  readonly ssBenefits: readonly Aggregate<SocialSecurityBenefitPayload>[];
  readonly expenses: readonly Aggregate<ExpensePayload>[];
  readonly incomeStreams: readonly Aggregate<IncomeStreamPayload>[];
  /** Today as plain numbers; the search never reads the clock. */
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  /** Test seam: defaults to the production calibration bundle. */
  readonly bundle?: TaxCalibrationBundle;
}

/** Whole-year death age per household member, an explicit assumption. */
export interface RothSuggestionDeathAges {
  readonly primary: number;
  /** Required when the household has a secondary member. */
  readonly secondary?: number;
}

/** Progress of a running search. Ticks once per projection; the totals are
 *  candidate-level so a bar driven by `candidatesDone / candidatesTotal`
 *  reaches 100 % on the last projection. */
export interface RothSuggestionProgress {
  readonly projectionsRun: number;
  readonly candidatesDone: number;
  readonly candidatesTotal: number;
}

export interface RothSuggestionRequest {
  readonly projection: RothSuggestionProjectionInput;
  /** Roth IRA the Fill windows convert into. */
  readonly targetRothAccountId: string;
  /** Tax rate on money still pre-tax at the horizon, a fraction in [0, 1). */
  readonly leftoverTaxRate: number;
  readonly deathAges: RothSuggestionDeathAges;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RothSuggestionProgress) => void;
}

/** Which of the three per-year limits bound the ceiling. */
export type LimitKind = 'bracket' | 'irmaa' | 'aca';

/** Why the IRMAA or ACA limit does not constrain a year. */
type LimitSkipReason =
  | 'unguarded'
  | 'beyond-horizon'
  | 'no-medicare'
  | 'no-marketplace'
  | 'not-pre-arpa'
  | 'reference-over-line';

/**
 * Bracket top expressed as MAGI: the next bracket's floor (post-deduction
 * taxable ordinary income) plus the deductions the year takes. The senior
 * bonus is evaluated at the resulting ceiling because it phases out with MAGI.
 * `valueDollars = floor(bracketTopDollars + standardDeductionDollars +
 * age65AddOnDollars + seniorBonusDollars)`.
 */
export interface BracketLimit {
  readonly kind: 'bracket';
  readonly valueDollars: number;
  readonly bracketRate: number;
  readonly filingStatus: FilingStatus;
  readonly bracketTopDollars: number;
  readonly standardDeductionDollars: number;
  readonly age65AddOnDollars: number;
  readonly seniorBonusDollars: number;
}

/** Tier-1 IRMAA line of year Y+2, the year that reads year Y's MAGI.
 *  `valueDollars = floor(thresholdDollars * scalingFactor)`. */
export type IrmaaLimit =
  | {
      readonly kind: 'irmaa';
      readonly applies: true;
      readonly valueDollars: number;
      readonly lookbackYear: number;
      readonly filingStatus: FilingStatus;
      readonly thresholdDollars: number;
      readonly scalingFactor: number;
    }
  | { readonly kind: 'irmaa'; readonly applies: false; readonly reason: LimitSkipReason };

/** ACA 400 % FPL line, moved onto the federal MAGI line by subtracting the
 *  nontaxable Social Security the ACA MAGI adds back.
 *  `valueDollars = max(0, floor(multiple * fplDollars * scalingFactor -
 *  nontaxableSsDollars))`. */
export type AcaLimit =
  | {
      readonly kind: 'aca';
      readonly applies: true;
      readonly valueDollars: number;
      readonly multiple: number;
      readonly fplDollars: number;
      readonly householdSize: number;
      readonly scalingFactor: number;
      readonly grossSsDollars: number;
      readonly taxableSsDollars: number;
      readonly nontaxableSsDollars: number;
    }
  | { readonly kind: 'aca'; readonly applies: false; readonly reason: LimitSkipReason };

/**
 * One window year's limits and the ceiling written to the ladder.
 * `limitDollars` is the smallest applicable limit, the MAGI the plan means to
 * stay at or under. The Fill step sizes a conversion against the MAGI it can
 * see while it runs, which leaves out the interest and dividends the year's
 * taxable accounts throw off; `engineOffsetDollars` is that gap, measured from
 * the previous pass (0 on the first), so
 * `ceilingDollars = floor(limitDollars - engineOffsetDollars)` and the row's
 * MAGI lands at `limitDollars`.
 */
export interface YearLimits {
  readonly year: number;
  readonly bracket: BracketLimit;
  readonly irmaa: IrmaaLimit;
  readonly aca: AcaLimit;
  readonly limitDollars: number;
  /** Smallest limit; a tie is labelled bracket, then IRMAA, then ACA. */
  readonly binding: LimitKind;
  readonly engineOffsetDollars: number;
  readonly ceilingDollars: number;
}

/** Why a year converted what it did, read off the engine's row. */
export type YearStop =
  /** Conversion filled the ceiling; `binding` names the limit. */
  | 'limit'
  /** Withdrawals alone already reached the ceiling, nothing left to convert. */
  | 'withdrawals-at-ceiling'
  /** Pre-tax money ran out before the ceiling. */
  | 'pre-tax-exhausted'
  /** The ceiling could not be honoured (see `breachedDollars`). */
  | 'breach'
  /** MAGI stayed under the ceiling for a reason the row does not name. */
  | 'unused-headroom'
  /** The year after the window: no cap, no Fill conversion. */
  | 'window-ended';

/** One year's record, nominal cents (the tax tables a person checks against
 *  are nominal). Ceiling, binding limit, limits and stop are null on the
 *  reference candidate, which carries the scenario's own ladder. */
export interface YearRecord {
  readonly year: number;
  readonly inWindow: boolean;
  readonly ceilingDollars: number | null;
  readonly binding: LimitKind | null;
  readonly limits: YearLimits | null;
  readonly stop: YearStop | null;
  readonly convertedCents: number;
  readonly magiCents: number;
  readonly taxableSsCents: number;
  readonly ssTaxationTier: NonNullable<DrawdownYear['ssTaxationTier']>;
  readonly federalTaxCents: number;
  readonly irmaaSurchargeCents: number;
  readonly irmaaTier: NonNullable<DrawdownYear['irmaaTier']>;
  /** IRMAA of year Y+2, the surcharge year this year's MAGI sets. */
  readonly lookbackIrmaaTier: NonNullable<DrawdownYear['irmaaTier']> | null;
  readonly lookbackIrmaaSurchargeCents: number | null;
  readonly acaPtcSubsidyCents: number;
  readonly acaPtcTier: NonNullable<DrawdownYear['acaPtcTier']>;
  /** Spending withdrawals the cap moved to a later taxable tier, dollars. */
  readonly reroutedDollars: number;
  /** Pre-tax dollars above the cap the engine could not move, dollars. */
  readonly breachedDollars: number;
}

/** Lifetime totals in today's dollars, each year deflated at December. */
export interface CandidateTotals {
  readonly yearsConverted: number;
  readonly totalConvertedTodayDollars: number;
  readonly incomeTaxTodayDollars: number;
  readonly irmaaTodayDollars: number;
  readonly acaCreditTodayDollars: number;
}

export interface CandidateAfterTax {
  /** Last row's balance in today's dollars. */
  readonly endingTodayDollars: number;
  /** Part of it still in pre-tax and mixed accounts, today's dollars. */
  readonly preTaxTodayDollars: number;
  /** `endingTodayDollars - preTaxTodayDollars * leftoverTaxRate`. */
  readonly afterTaxTodayDollars: number;
  readonly deltaVsReferenceTodayDollars: number;
}

export type UnrankedReason =
  | { readonly kind: 'cap-breached'; readonly years: readonly number[] }
  | {
      readonly kind: 'guard-crossed';
      readonly crossings: readonly { readonly year: number; readonly line: 'irmaa' | 'aca' }[];
    }
  | { readonly kind: 'bracket-exceeded'; readonly years: readonly number[] };

export interface RothCandidate {
  /** Stable id: `current-plan` or `bracket-<pct>-<guarded|unguarded>`. */
  readonly id: string;
  readonly isReference: boolean;
  /** Target bracket as a fraction; null on the reference. */
  readonly bracketRate: number | null;
  /** Null on the reference. */
  readonly guarded: boolean | null;
  /** The ladder as persisted (the scenario's own resolved ladder on the
   *  reference), so saving it stores exactly what was ranked. */
  readonly ladder: readonly MagiCapWindow[];
  readonly drawdownYears: readonly DrawdownYear[];
  readonly years: readonly YearRecord[];
  readonly totals: CandidateTotals;
  readonly deltaVsReference: CandidateTotals;
  readonly afterTax: CandidateAfterTax;
  /** 1 = best after-tax balance; null when the cap was not met. */
  readonly rank: number | null;
  readonly unranked: readonly UnrankedReason[];
  /** Ranked, but spending withdrawals were moved to a later taxable tier in
   *  these years, so part of the result is a withdrawal-order change. */
  readonly reroutedYears: readonly number[];
  readonly passes: number;
  /** False when the pass cap stopped the loop before ceilings settled. */
  readonly converged: boolean;
}

export type RothSuggestionUnsupportedReason =
  | 'no-primary-retirement'
  | 'cbp-unconfigured'
  | 'no-roth-ira'
  | 'no-retirement-window'
  | 'separate-filing-plan'
  | 'filing-unresolved'
  | 'no-projection';

export interface RothSuggestionOk {
  readonly kind: 'ok';
  /** The reference first, then the grid in bracket order, guarded first. */
  readonly candidates: readonly RothCandidate[];
  /** Candidate ids from best to worst after-tax balance. */
  readonly rankedIds: readonly string[];
  readonly window: { readonly startYear: number; readonly endYear: number };
  readonly horizonYear: number;
  readonly leftoverTaxRate: number;
  readonly deathAges: RothSuggestionDeathAges;
  readonly projectionsRun: number;
}

export type RothSuggestionResult =
  | RothSuggestionOk
  | { readonly kind: 'unsupported'; readonly reason: RothSuggestionUnsupportedReason }
  | { readonly kind: 'cancelled'; readonly projectionsRun: number }
  | { readonly kind: 'error'; readonly message: string };
