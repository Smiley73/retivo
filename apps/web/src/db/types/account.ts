/**
 * Account + account-balance aggregate payloads, plus the asset-mix vocabulary
 * and per-type default helpers.
 */

// Beneficiary-category vocabulary for an INHERITED account.
// The SSOT union + validator live in `db/rmd-fact-validation.ts` so the
// migration sanitiser and any runtime boundary share one definition.
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

// CBP payout elections live on the linked IncomeStream via
// `IncomeStreamPayload.linkedCbpAccountId`. The
// former `CashBalancePayoutAtRetirement` discriminated union and the
// `ScenarioOverrides.cashBalancePayouts` section were removed in the
// same remodel. No migration is provided — old IndexedDB rows /
// import-file rows that still carry `cashBalancePayouts` or
// `sourceAccountId` simply parse with those fields as unknown extras;
// they're never read by the new code. Re-configure linked elections
// via the Income form's "Linked CBP account" dropdown.

/**
 * Asset allocation for the account, in percent. Each value 0–100 with
 * one-decimal precision; the three must sum to 100.0 ± 0.05 (the
 * tolerance window covers float-rounding from one-decimal inputs).
 *
 * Drives the Monte Carlo projection's per-year return draw via the
 * historical bootstrap: blended return for year y =
 * `stocksPct·rStock[y] + bondsPct·rBond[y] + cashPct·rCash[y]` (each
 * divided by 100). Annual rebalance is implicit — sub-balances are not
 * tracked.
 *
 * Cash Balance Pension (`RETIREMENT_CASH_BALANCE`) accounts store a
 * placeholder `{ 0, 0, 100 }` because the engine ignores their mix in
 * favour of the account's existing `planningReturnPct` deterministically
 * applied every year of every path. The form hides the section for CBP.
 *
 * Defaults applied at new-account creation by the AccountForm; no
 * migration (pre-launch v1 reset):
 *   - `SAVINGS` / `MONEY_MARKET` / `CD`        → `{ 0, 0, 100 }`
 *   - `RETIREMENT_CASH_BALANCE`                → `{ 0, 0, 100 }` (ignored)
 *   - `RETIREMENT_*` / `BROKERAGE` / `HSA`     → `{ 70, 25, 5 }`
 *   - `OTHER`                                  → `{ 70, 25, 5 }`
 */
export interface AssetMix {
  stocksPct: number;
  bondsPct: number;
  cashPct: number;
}

export const ASSET_MIX_SUM_TOLERANCE = 0.05;

/** Built-in AccountType → AssetMix defaults. Pure function — applied at
 *  new-account creation in the form; no migration (pre-launch v1 reset). */
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
  /** Optional per-account annual-increase rate for the planned
   *  contribution (percent, e.g. 3 for 3 %/yr). The configured
   *  contribution figure is interpreted as a TODAY'S-dollars amount that
   *  grows across accumulation steps so it holds its real value in the
   *  default Today's-dollars projection view.
   *
   *  Presence is the mode flag (mirrors income's `tracksInflation` vs
   *  explicit `colaPct`):
   *  - **absent** → "tracks inflation": grows at the resolved scenario
   *    general inflation rate (per-path CPI in Monte Carlo → flat-real).
   *  - **explicit number (incl. `0`)** → fixed COLA at that percent
   *    (`0` = flat-nominal/old behavior, `>inflation` = real raises).
   *
   *  Accepted domain: finite and `-100 < pct ≤ 25`. An out-of-band
   *  / non-finite stored value (corrupt import) degrades to the
   *  tracks-inflation default at the resolver/engine boundary. Resolved
   *  per-account first-ancestor-wins (override → baseline → absent) by
   *  `resolveContributionGrowth` in `scenario-resolution.ts`. */
  contributionGrowthPct?: number;
  /** Per-account stocks/bonds/cash mix in percent. Drives Monte Carlo
   *  return sampling. CBP accounts ignore the field; engine consults
   *  `planningReturnPct` directly for them. See `AssetMix`. */
  assetMix: AssetMix;
  /** The tax year of the account owner's first Roth-IRA
   *  contribution, starting the §408A five-tax-year qualification clock. On an
   *  INHERITED account (`rmdInheritedAccount`) the year asked for is the
   *  DECEDENT's, but no engine consults it: an inherited Roth IRA forms no
   *  §408A pool, no clock is resolved for it, and its withdrawals are assumed
   *  fully qualified. The field itself is unchanged — still collected,
   *  stored, and scoring completeness. **Absent → the five-year rule is treated
   *  as NOT satisfied** (conservative — earnings are taxed). */
  rothIraFirstContributionTaxYear?: number;
  // Roth-IRA conversions are NOT stored here. A conversion happens in one tax
  // year, so it is recorded on that year's row on the Account Balances page
  // (`AccountBalancePayload.rothConversionTaxableAmount` /
  // `rothConversionNontaxableAmount`) and the engine reads its lots from there.
  // The former `rothIraConversionLots` field was dropped outright — no schema
  // bump and no migration, because nothing reads the key. The
  // designated-Roth IN-PLAN ROLLOVER lots went the same way — see the note
  // further down.
  /** The tax year this designated-Roth account's OWN
   *  applicable five-taxable-year period begins. This is normally the year the
   *  owner first participated in THIS account, but per IRS designated-Roth rules
   *  it must reflect any EARLIER start date carried over from a qualifying DIRECT
   *  ROLLOVER from a distributing designated-Roth plan — the receiving account
   *  inherits the distributing plan's participation-start year, so the recorded
   *  value is the account's own applicable clock start, not merely first
   *  participation in the receiving account itself. **Absent → not
   *  satisfied** (conservative). (No rollover-carryover
   *  STORAGE mechanism is added here; the separate in-plan-rollover concept is
   *  recorded per year on the balance rows — this field's value is simply the
   *  correct clock-start year including any such carryover.) */
  designatedRothFirstParticipationTaxYear?: number;
  // Designated-Roth IN-PLAN ROLLOVERS are NOT stored here. Like a Roth-IRA
  // conversion, an in-plan rollover happens in one tax year, so it is recorded on
  // that year's row on the Account Balances page
  // (`AccountBalancePayload.rothInPlanRolloverTaxableAmount` /
  // `rothInPlanRolloverNontaxableAmount`) and the engine reads its lots from
  // there. The former `designatedRothInPlanRolloverLots` field was dropped
  // outright — no schema bump and no migration, because nothing reads the key.

  // -------------------------------------------------------------------------
  // Required-Minimum-Distribution profile facts.
  // Sparse-optional and additive; the fact-based RMD engine reads them in
  // projection output. Every field's ABSENCE resolves to the
  // one-sided conservative default at the engine boundary — the migration
  // never invents a stored value, and an INHERITED account with incomplete
  // beneficiary facts WITHHOLDS its RMD (never guesses a rule). Facts flow into
  // the account-level RMD-rule selector (`resolveRmdRule` in `rmd.ts`) and its
  // still-working / first-year-deferral helpers; `rmd-life-expectancy-tables.ts`
  // holds only the table/divisor selector (`selectRmdTableDivisor`) that
  // `resolveRmdRule` calls.
  // -------------------------------------------------------------------------

  /** This account was INHERITED (the member is a beneficiary, not the
   *  original owner). **Absent → owner account** (owner RMD rules: Uniform
   *  Lifetime Table III by default). When `true`, the inherited-account facts
   *  below become required to compute an RMD; incomplete facts WITHHOLD the
   *  result. */
  rmdInheritedAccount?: boolean;
  /** The plan is the owner's CURRENT employer's plan (a precondition of the
   *  §401(a)(9)(C) still-working exception). **Absent → not a current-employer
   *  plan** → no still-working deferral → the RMD is required (conservative).
   *  Meaningful only on employer plans (401(k)/403(b)/457(b)/TSP/cash-balance);
   *  the exception never applies to IRAs. */
  rmdCurrentEmployerPlan?: boolean;
  /** The owner is a >5% owner of the employer sponsoring the plan. A 5%
   *  owner CANNOT use the still-working exception (§401(a)(9)(C)(ii)). **Absent
   *  → treated as a 5% owner WHEN the still-working exception is otherwise
   *  claimed** → the exception is denied and the RMD is required (conservative;
   *  never optimistically defers). */
  rmdFivePercentOwner?: boolean;
  /** The plan's own terms force distributions at the statutory RMD age
   *  regardless of continued employment (some plans do). The still-working
   *  exception is granted ONLY when this is explicitly `false` (an affirmative
   *  "the plan does NOT force distribution"); **absent/unknown → the exception is
   *  DENIED**, never granted on missing plan terms. `true` also denies
   *  it. */
  rmdPlanRequiresDistributionAtStatutoryAge?: boolean;
  /** The owner ELECTS to defer their FIRST RMD to April 1 of the year after
   *  the trigger year (the required-beginning-date grace), taking two RMDs in
   *  that second year. **Absent → false** (the engine's default calendar-year
   *  RMD is taken in the trigger year). Modeled as a timing/tax-and-IRMAA
   *  consequence, not a change to the annual amount. */
  rmdFirstYearDeferralElected?: boolean;
  /** Records that the owner's SOLE beneficiary is a spouse. Whether the
   *  Joint Life and Last Survivor Table (Table II) applies is DERIVED from the
   *  owner + spouse birthdates (the anniversary-safe ">10 years younger" test) —
   *  this boolean is never trusted alone for the age gap. **Absent →
   *  Uniform Lifetime Table III** (larger-RMD default; conservative). When set,
   *  missing/malformed owner or spouse birthdates WITHHOLD (never a silent Table
   *  III downgrade); a birthdate-derived "not more than 10 years younger"
   *  uses Table III. */
  rmdSoleSpouseBeneficiary?: boolean;
  /** ISO `YYYY-MM-DD` birthdate of the sole spouse beneficiary. When the
   *  sole-spouse designation is set it both VERIFIES the ">10 years younger" gap
   *  and supplies the spouse's attained age for the Table II divisor lookup
   *  (derived from this birthdate + the tax year — no separate age fact). A missing
   *  or malformed value with the designation set WITHHOLDS (never a silent Table
   *  III fallback). Unused when the designation is absent. */
  rmdSpouseBeneficiaryBirthdate?: string;
  /** Beneficiary category of an INHERITED account, selecting the applicable
   *  10-year / life-expectancy / 5-year post-death rule. **Absent on an inherited
   *  account → the RMD is WITHHELD** and the missing fact is listed.
   *  Ignored on owner accounts. */
  rmdBeneficiaryType?: RmdBeneficiaryType;
  /** ISO `YYYY-MM-DD` date the ORIGINAL owner of an inherited account died,
   *  which (with `rmdInheritedOwnerDiedOnOrAfterRbd`) determines the applicable
   *  post-death schedule. **Absent on an inherited account → WITHHELD**. */
  rmdInheritedOwnerDeathDate?: string;
  /** Whether the original owner of an inherited account died ON OR AFTER
   *  their required beginning date (RBD). Governs whether annual life-expectancy
   *  distributions are required within the 10-year window. **Absent on an
   *  inherited account → WITHHELD**. */
  rmdInheritedOwnerDiedOnOrAfterRbd?: boolean;
  /** ISO `YYYY-MM-DD` birthdate of the ORIGINAL account owner (the decedent).
   *  Needed for the decedent's-remaining-life "longer-of" comparison when the
   *  owner died on/after their RBD, and for the surviving-spouse delayed-start year
   *  (the year the owner would have reached their RBD). **Absent when a result
   *  depends on it → WITHHELD**. */
  rmdOriginalOwnerBirthdate?: string;
  /** ISO `YYYY-MM-DD` birthdate of the BENEFICIARY (this member), needed for
   *  the Single Life Table (Table I) life-expectancy lookup when a stretch
   *  distribution applies. **Absent when a life-expectancy stretch applies →
   *  WITHHELD**. */
  rmdBeneficiaryBirthdate?: string;
  /** The post-death distribution ELECTION an ELIGIBLE DESIGNATED beneficiary
   *  of an inherited account affirmatively made: the life-expectancy stretch or
   *  the 10-year rule. The engine must never INVENT this choice — **absent on an
   *  eligible-designated-beneficiary inherited account → WITHHELD**.
   *  Ignored for a non-eligible designated beneficiary (10-year rule applies) and
   *  a non-person beneficiary. */
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
  /** Roth engine — the part of this year's Roth conversion that was TAXED when
   *  it was converted, in **dollars with cents** (like every other money field
   *  on this payload — not whole dollars, not cents). Only the taxed portion
   *  enters the IRC §72(t) recapture base, which is why the taxable and
   *  nontaxable halves are stored apart rather than as one total.
   *
   *  Sparse-optional: the key is OMITTED when nothing was converted that year.
   *  **Absent means "nothing recorded"**, which is a weaker claim than a stored
   *  `0` — a `0` asserts the user recorded a year with no conversion. */
  rothConversionTaxableAmount?: number;
  /** Roth engine — the part of this year's Roth conversion that came from
   *  after-tax money and was NOT taxed at conversion, in **dollars with cents**.
   *  Sparse-optional with the same absent-means-nothing-recorded semantics as
   *  {@link AccountBalancePayload.rothConversionTaxableAmount}. */
  rothConversionNontaxableAmount?: number;
  /** Roth engine — the part of this year's designated-Roth IN-PLAN ROLLOVER that
   *  WAS included in income when it moved, in **dollars with cents**.
   *
   *  An in-plan Roth rollover moves money from an employer plan's pre-tax side
   *  into its own Roth side (IRC §402A(c)(4)). It is NOT a Roth-IRA conversion:
   *  it lands inside the same plan and starts its own separate five-tax-year
   *  §402A(c)(4)(D) recapture clock. Recorded here rather than on the account so
   *  it sits on the year it happened, like every other yearly figure — and so a
   *  plan's Roth history has exactly one home, matching the conversion fields
   *  above.
   *
   *  Meaningful on designated-Roth employer accounts (pure Roth
   *  401(k)/403(b)/457(b)/TSP, or the Roth-designated side of a MIXED
   *  401(k)/403(b)/457(b)/TSP). Sparse-optional with the same
   *  absent-means-nothing-recorded semantics as the conversion pair. */
  rothInPlanRolloverTaxableAmount?: number;
  /** Roth engine — the already-after-tax part of this year's designated-Roth
   *  in-plan rollover, in **dollars with cents**. Never taxed and never
   *  penalized, but still basis. Same absent semantics as
   *  {@link AccountBalancePayload.rothInPlanRolloverTaxableAmount}. */
  rothInPlanRolloverNontaxableAmount?: number;
}
