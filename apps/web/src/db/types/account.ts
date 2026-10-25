// Account and account-balance aggregate payloads, the asset-mix vocabulary and per-type default helpers.

// The beneficiary-category union and validator live in `db/rmd-fact-validation.ts`, shared by migration and runtime.
import type { RmdBeneficiaryType, RmdBeneficiaryElection } from '../rmd-fact-validation';

export type AccountType =
  | 'RETIREMENT_401K'
  | 'RETIREMENT_IRA'
  | 'RETIREMENT_ROTH_IRA'
  | 'RETIREMENT_ROTH_401K'
  | 'RETIREMENT_ROTH_403B'
  | 'RETIREMENT_ROTH_457B'
  | 'RETIREMENT_ROTH_TSP'
  | 'RETIREMENT_CASH_BALANCE'
  | 'RETIREMENT_403B'
  | 'RETIREMENT_457B'
  | 'RETIREMENT_TSP'
  | 'SAVINGS'
  | 'MONEY_MARKET'
  | 'BROKERAGE'
  | 'CD'
  | 'HSA'
  | 'OTHER';

export type AccountOwnershipType = 'INDIVIDUAL' | 'JOINT';
export type AccountTaxTreatment =
  | 'PRE_TAX'
  | 'POST_TAX'
  | 'MIXED'
  | 'HSA'
  | 'ROTH';

// CBP payout elections live on the linked IncomeStream (`IncomeStreamPayload.linkedCbpAccountId`); old rows carrying
// `cashBalancePayouts` or `sourceAccountId` parse as unknown extras that nothing reads.

/**
 * Asset allocation in percent: each 0-100 with one decimal, summing to 100.0 ± 0.05 (covers float rounding). Drives the
 * Monte Carlo per-year return draw via the historical bootstrap: blended return = `stocksPct·rStock + bondsPct·rBond +
 * cashPct·rCash` (each /100), with an implicit annual rebalance. Cash Balance Pension accounts store a placeholder `{
 * 0, 0, 100 }` because the engine applies the account's `planningReturnPct` deterministically instead; the form hides
 * the section for CBP. The AccountForm sets defaults at creation via `defaultAssetMixForAccountType`.
 */
export interface AssetMix {
  stocksPct: number;
  bondsPct: number;
  cashPct: number;
}

export const ASSET_MIX_SUM_TOLERANCE = 0.05;

/** Default asset mix per account type, applied by the form at creation. */
export function defaultAssetMixForAccountType(t: AccountType): AssetMix {
  switch (t) {
    case 'SAVINGS':
    case 'MONEY_MARKET':
    case 'CD':
    case 'RETIREMENT_CASH_BALANCE':
      return { stocksPct: 0, bondsPct: 0, cashPct: 100 };
    case 'RETIREMENT_401K':
    case 'RETIREMENT_IRA':
    case 'RETIREMENT_ROTH_IRA':
    case 'RETIREMENT_ROTH_401K':
    case 'RETIREMENT_ROTH_403B':
    case 'RETIREMENT_ROTH_457B':
    case 'RETIREMENT_ROTH_TSP':
    case 'RETIREMENT_403B':
    case 'RETIREMENT_457B':
    case 'RETIREMENT_TSP':
    case 'BROKERAGE':
    case 'HSA':
    case 'OTHER':
      return { stocksPct: 70, bondsPct: 25, cashPct: 5 };
  }
}

export interface AccountPayload extends Record<string, unknown> {
  name: string;
  type: AccountType;
  ownershipType: AccountOwnershipType;
  taxTreatment: AccountTaxTreatment;
  ownerId: string;
  institution: string;
  notes: string;
  planningReturnPct: number;
  active: boolean;
  plannedContributionPreTax: number;
  plannedContributionPostTax: number;
  /**
   * Annual-increase rate for the planned contribution (percent), read in today's dollars so it holds its real value in
   * the default projection view. Presence is the mode flag (like income's `tracksInflation` vs `colaPct`): absent
   * tracks the scenario's general inflation (per-path CPI in Monte Carlo); an explicit number, `0` included, is a fixed
   * COLA (`0` flat-nominal, above inflation real raises). Domain: finite and `-100 < pct <= 25`; an out-of-band or
   * non-finite stored value (corrupt import) degrades to tracks-inflation at the resolver/engine boundary. Resolved
   * first-ancestor-wins by `resolveContributionGrowth` in `scenario-resolution.ts`.
   */
  contributionGrowthPct?: number;
  /** Stocks/bonds/cash mix in percent driving Monte Carlo return sampling; CBP accounts ignore it (see `AssetMix`). */
  assetMix: AssetMix;
  /**
   * Tax year of the owner's first Roth-IRA contribution, starting the §408A five-tax-year qualification clock. On an
   * inherited account the year asked for is the decedent's, but no engine consults it (an inherited Roth IRA forms no
   * §408A pool; withdrawals are assumed fully qualified); it is still collected and scored for completeness. Absent:
   * the five-year rule is treated as not satisfied (conservative, earnings are taxed).
   */
  rothIraFirstContributionTaxYear?: number;
  // Roth-IRA conversions and designated-Roth in-plan rollovers happen in one tax year, so they are recorded on that
  // year's balance row (`AccountBalancePayload.rothConversion*` / `rothInPlanRollover*`), where the engine reads its
  // lots, not here.
  /**
   * Tax year this designated-Roth account's own five-taxable-year period begins: normally the owner's first
   * participation, but per IRS rules an earlier start carried over from a qualifying direct rollover from a
   * distributing designated-Roth plan, so the value is the correct clock start including any carryover. Absent: not
   * satisfied (conservative).
   */
  designatedRothFirstParticipationTaxYear?: number;

  // Required-Minimum-Distribution profile facts: sparse-optional and additive, read by the fact-based RMD engine
  // (`resolveRmdRule` in `rmd.ts`; `rmd-life-expectancy-tables.ts` holds only the divisor selector). Absence resolves
  // to the one-sided conservative default at the engine boundary; migration never invents a value, and an inherited
  // account with incomplete beneficiary facts withholds its RMD rather than guess a rule.

  /**
   * Inherited account (the member is a beneficiary). Absent: owner account (Uniform Lifetime Table III). When true, the
   * inherited-account facts below are required; incomplete facts withhold the RMD.
   */
  rmdInheritedAccount?: boolean;
  /**
   * The plan is the owner's current employer's, a precondition of the §401(a)(9)(C) still-working exception (employer
   * plans only, never IRAs). Absent: not current-employer, so no deferral and the RMD is required (conservative).
   */
  rmdCurrentEmployerPlan?: boolean;
  /**
   * The owner is a >5% owner of the sponsoring employer, which bars the still-working exception (§401(a)(9)(C)(ii)).
   * Absent: treated as a 5% owner when the exception is otherwise claimed, so the RMD is required (never optimistically
   * defers).
   */
  rmdFivePercentOwner?: boolean;
  /**
   * The plan's terms force distributions at the statutory RMD age regardless of employment. The still-working exception
   * is granted only when this is explicitly `false`; absent or `true` denies it.
   */
  rmdPlanRequiresDistributionAtStatutoryAge?: boolean;
  /**
   * The owner elects to defer the first RMD to April 1 of the year after the trigger year (taking two RMDs that year).
   * Absent: false. A timing/tax-and-IRMAA consequence, not a change to the annual amount.
   */
  rmdFirstYearDeferralElected?: boolean;
  /**
   * The owner's sole beneficiary is a spouse. Whether Table II (Joint Life and Last Survivor) applies is derived from
   * the owner and spouse birthdates (the anniversary-safe ">10 years younger" test); this boolean alone is never
   * trusted for the gap. Absent: Uniform Lifetime Table III (larger RMD, conservative). When set, missing or malformed
   * birthdates withhold rather than silently downgrade to Table III; a gap of not more than 10 years uses Table III.
   */
  rmdSoleSpouseBeneficiary?: boolean;
  /**
   * Birthdate (ISO `YYYY-MM-DD`) of the sole spouse beneficiary: verifies the ">10 years younger" gap and supplies the
   * attained age for the Table II divisor. Missing or malformed with the designation set withholds. Unused when the
   * designation is absent.
   */
  rmdSpouseBeneficiaryBirthdate?: string;
  /**
   * Beneficiary category of an inherited account, selecting the 10-year, life-expectancy or 5-year post-death rule.
   * Absent on an inherited account withholds the RMD and lists the missing fact; ignored on owner accounts.
   */
  rmdBeneficiaryType?: RmdBeneficiaryType;
  /**
   * Death date (ISO `YYYY-MM-DD`) of the original owner of an inherited account; with
   * `rmdInheritedOwnerDiedOnOrAfterRbd` it determines the post-death schedule. Absent on an inherited account:
   * withheld.
   */
  rmdInheritedOwnerDeathDate?: string;
  /**
   * Whether the original owner died on or after their required beginning date (RBD), governing whether annual
   * life-expectancy distributions are required within the 10-year window. Absent on an inherited account: withheld.
   */
  rmdInheritedOwnerDiedOnOrAfterRbd?: boolean;
  /**
   * Birthdate (ISO `YYYY-MM-DD`) of the original owner (decedent), needed for the remaining-life "longer-of" comparison
   * when death was on or after the RBD and for the surviving-spouse delayed-start year. Absent when a result depends on
   * it: withheld.
   */
  rmdOriginalOwnerBirthdate?: string;
  /**
   * Birthdate (ISO `YYYY-MM-DD`) of the beneficiary (this member), needed for the Single Life Table (Table I) lookup
   * when a stretch applies. Absent then: withheld.
   */
  rmdBeneficiaryBirthdate?: string;
  /**
   * The post-death election an eligible designated beneficiary of an inherited account made: life-expectancy stretch or
   * the 10-year rule. The engine never invents it, so absent on such an account withholds. Ignored for a non-eligible
   * designated beneficiary (10-year rule) and a non-person beneficiary.
   */
  rmdBeneficiaryElection?: RmdBeneficiaryElection;
}

export interface AccountBalancePayload extends Record<string, unknown> {
  accountId: string;
  year: number;
  lastUpdated: string;
  startingBalance: number;
  startingBalancePreTax: number | null;
  startingBalancePostTax: number | null;
  contributionsPreTax: number | null;
  contributionsPostTax: number | null;
  companyContributions: number;
  companyContributionsPreTax: number | null;
  companyContributionsPostTax: number | null;
  rollover: number;
  distributions: number;
  endingBalance: number;
  endingBalancePreTax: number | null;
  endingBalancePostTax: number | null;
  totalContributions: number;
  comment: string | null;
  /**
   * Roth engine: the part of this year's Roth conversion that was taxed when converted, in dollars with cents like
   * every money field here. Only the taxed part enters the IRC §72(t) recapture base, hence taxable and nontaxable are
   * stored apart. Sparse-optional: omitted when nothing was converted; absent means "nothing recorded", a weaker claim
   * than a stored `0` (a year recorded with no conversion).
   */
  rothConversionTaxableAmount?: number;
  /**
   * Roth engine: the part of this year's conversion that came from after-tax money and was not taxed at conversion, in
   * dollars with cents. Sparse-optional, absent-means-nothing-recorded like {@link
   * AccountBalancePayload.rothConversionTaxableAmount}.
   */
  rothConversionNontaxableAmount?: number;
  /**
   * Roth engine: the part of this year's designated-Roth in-plan rollover that was included in income, in dollars with
   * cents. An in-plan rollover moves an employer plan's pre-tax side into its own Roth side (IRC §402A(c)(4)); it is
   * not a Roth-IRA conversion and starts its own five-tax-year §402A(c)(4)(D) recapture clock. Recorded here, on the
   * year it happened, so a plan's Roth history has one home. Meaningful on designated-Roth employer accounts (pure Roth
   * 401(k)/403(b)/457(b)/TSP or the Roth side of a MIXED one); sparse-optional like the conversion pair.
   */
  rothInPlanRolloverTaxableAmount?: number;
  /**
   * Roth engine: the already-after-tax part of this year's in-plan rollover, in dollars with cents; never taxed or
   * penalized but still basis. Absent semantics as {@link AccountBalancePayload.rothInPlanRolloverTaxableAmount}.
   */
  rothInPlanRolloverNontaxableAmount?: number;
}
