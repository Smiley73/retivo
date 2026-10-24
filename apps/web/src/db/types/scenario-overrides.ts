// Per-scenario override shapes converging into `ScenarioOverrides`; shared vocabulary is in `aggregate-base.ts`.
// Type-only imports (`TaxFilingPlan`, `AcaFplRegion`) avoid cycles; the only runtime code is `isMagiCapDisabled`.

import type { AcaFplRegion } from '../../lib/aca-ptc';
import type { FilingStatusOverride, TaxFilingPlan } from '../../lib/filing-status';

import type { AssetMix } from './account';
import type { ExpensePayload } from './expense';
import type { IncomeStreamPayload } from './income';
import type {
  PatchWithClears,
  ScheduleEnd,
  ScheduleStart,
} from './aggregate-base';

export interface RetirementAgePerMember {
  ageYears: number;
  ageMonths: number;
}

/**
 * Retirement-age override. Independent mode (`sameDateAnchor` undefined): each member sets their own age. Same-date
 * mode (`'primary'` or `'secondary'`): only the anchor's age is editable and the other's is derived from the birthdates
 * so both retire on one date; the derived age is still persisted into `primary`/`secondary`, since calculations read
 * those directly. `sameDateAnchor` is UI metadata preserving intent across edits.
 */
export interface RetirementAgeOverride {
  primary: RetirementAgePerMember;
  secondary?: RetirementAgePerMember;
  sameDateAnchor?: 'primary' | 'secondary';
}

/**
 * Social Security override: claim ages plus scenario-level forward assumptions. Each member sets their own claim age
 * (no "same as primary" shortcut; couples claim at different ages for spousal/survivor benefits); `secondary` is stored
 * only once explicitly set, and the UI defaults it to 67y 0m. `benefitReductionPct` (0 / 10 / 25 / 50) models an
 * across-the-board cut (SSA trust-fund exhaustion scenarios); `0` is none. `colaPct` is the annual COLA, compounded
 * after each member's SSA statement anchor year (the `piaAsOfDate` year, else the age-62 eligibility year) regardless
 * of claim age; defaults 0 and 2 when absent in the chain. `colaTracksInflation` is default-on (product decision):
 * absent or `true` grows the benefit at the scenario inflation rate, keeping the real-dollar SS line flat (SS COLA is
 * CPI-indexed); only an explicit `false` falls back to `colaPct`. Resolve via `resolveSsColaPct`, the one read point
 * all engines share.
 */
export interface SocialSecurityOverride {
  primary: RetirementAgePerMember;
  secondary?: RetirementAgePerMember;
  /**
   * Per-member survivor-benefit claim age, a decision separate from the member's own claim age (42 USC 402(e)/(f):
   * payable from 60 with its own reduction schedule; delaying past the survivor's FRA earns nothing). Sparse at both
   * levels. Absent means the member's survivor-dependent results are withheld: the projection pays only their own
   * benefit after the spouse's death, flags `survivorWithheld` on the affected years, and the UI prompts; never
   * silently defaulted, since an early-claim default would not be one-sided.
   */
  survivor?: {
    primary?: RetirementAgePerMember;
    secondary?: RetirementAgePerMember;
  };
  benefitReductionPct?: number;
  colaPct?: number;
  colaTracksInflation?: boolean;
}

/** @deprecated alias of `SocialSecurityOverride`. */
export type SocialSecurityClaimAgeOverride = SocialSecurityOverride;

/**
 * Future-contributions override: when `stopContributionsToday` is true the projection skips every contribution (planned
 * and extrapolated company) and coasts on compound growth ("what if I lose my job tomorrow"). Absent in the chain:
 * contributions continue until each account's owner retires. A global short-circuit that wins over the separate
 * per-account `accountContributions` amounts.
 */
export interface ContributionsOverride {
  stopContributionsToday: boolean;
}

// Per-account planned-contribution targets, sparse: `perAccount` holds only overridden accounts, others fall through to
// the account's `plannedContributionPreTax`/`PostTax`. `preTax`, `postTax` and `contributionGrowthPct` are each
// independently optional. Resolved per account first-ancestor-wins (`resolveAccountContributionsForScenario` amounts,
// `resolveContributionGrowth` rate, in `scenario-resolution.ts`). `stopContributionsToday` still short-circuits above
// this.
interface AccountContributionsOverride {
  perAccount: Record<
    string,
    {
      plannedContributionPreTax?: number;
      plannedContributionPostTax?: number;
      /**
       * Per-scenario annual-increase rate (percent): absent inherits the baseline or ancestor (tracks-inflation if
       * none), an explicit number incl. `0` is a fixed COLA. Same domain and sanitisation as
       * `AccountPayload.contributionGrowthPct`.
       */
      contributionGrowthPct?: number;
    }
  >;
}

// Per-account minimum-balance floor, sparse: `perAccount` holds only floored accounts; missing means no floor. A floor
// protects an eligible account (`taxTreatment` POST_TAX or HSA) from discretionary depletion: the drawdown engine never
// takes a discretionary withdrawal that would drop it below `floorDollars`. Floors are nominal dollars and do not
// inflation-adjust, so their real value erodes over long horizons (disclosed in the UI). `floorDollars` and `hsaMode`
// resolve independently first-ancestor-wins. CWE-20 contract, sanitised by `resolveAccountFloorsForScenario` in
// `lib/scenario-resolution.ts` (import bundles are the threat surface): a non-finite or negative `floorDollars` reads
// as no floor, and any `hsaMode` not strictly `'strict'` reads as `'emergencyOnly'`; `null` clears the inherited value,
// absent inherits.
interface AccountFloorsOverride {
  perAccount: Record<
    string,
    {
      /**
       * Minimum balance to protect, nominal dollars; finite and `>= 0`, otherwise no floor. `null` clears the inherited
       * floor.
       */
      floorDollars?: number | null;
      /**
       * HSA-only mode. `'emergencyOnly'` (default): the floor blocks only the emergency-reserve draw (PASS B);
       * medical-qualified draws (PASS A) proceed. `'strict'`: blocks all draws including medical. `null` clears the
       * inherited mode; ignored for POST_TAX.
       */
      hsaMode?: 'emergencyOnly' | 'strict' | null;
    }
  >;
}

// Per-account planned return rate, sparse (missing falls through to `Account.payload.planningReturnPct`),
// first-ancestor-wins via `resolveAccountReturnsForScenario`. Affects only the Planned projection method: the TWR
// method is empirical from each account's balance history, and overriding it would misstate delivered returns.
interface AccountReturnsOverride {
  perAccount: Record<
    string,
    {
      planningReturnPct?: number;
    }
  >;
}

// Per-account asset mix, sparse (missing falls through to `Account.payload.assetMix`); an entry replaces the whole `{
// stocksPct, bondsPct, cashPct }` triple (the form validator ensures it sums to 100.0 ± 0.05). Monte Carlo only;
// first-ancestor-wins via `resolveAccountAssetMixForScenario`.
interface AccountAssetMixOverride {
  perAccount: Record<string, AssetMix>;
}

/**
 * Per-member life expectancy in whole years, sparse; absent in the chain falls back to `DEFAULT_LIFE_EXPECTANCY_AGE`. A
 * scenario-level assumption, not a household-member field, so "what if I live to 100" stays per-scenario.
 */
export interface LifeExpectancyOverride {
  primary?: number;
  secondary?: number;
}

/**
 * Inflation override driving the annual escalation of expense amounts; default 3% when absent in the chain. Sparse
 * `categoryRates` gives a per-category effective rate (percent) keyed by ExpenseCategory id: an absent category
 * inflates at `ratePct`, except the seeded Medical (`cat-medical`) at `ratePct + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT`.
 * Stored only where a rate differs from its default; orphan keys are kept verbatim and inert. Resolved per key by
 * `resolveInflationForScenario` (prototype-safe `Map`, dropping dangerous keys and non-finite or out-of-`[0,10]`
 * values).
 */
export interface InflationOverride {
  ratePct: number;
  categoryRates?: Record<string, number>;
}

/**
 * Discretionary adjustment: `bumpPct` scales every `discretionary` expense by `(1 + bumpPct/100)` inside the window
 * (`durationYears` null is all of retirement, a positive integer the first N retirement years). Integer in [-100, +100]
 * (the editor uses 5% steps); stored values outside it are clamped at the math layer.
 */
export interface DiscretionarySpendingOverride {
  bumpPct: number;
  durationYears: number | null;
}

/**
 * Downturn guardrails: a risk-based dynamic-spending rule applied per Monte Carlo path per year, cutting spending in
 * bad markets and raising it in good ones, keyed off the funded ratio (portfolio ÷ present value of remaining net
 * spending need). Opt-in (`enabled` defaults false); absent or disabled leaves the projection unchanged. Monte Carlo
 * only (the fixed-return engine has no downturn). See "Spending guardrails" in docs/math-projections.md. Percent
 * fields: `lowerBandPct` funded ratio at/below which spending is cut one step (default 85); `upperBandPct` at/above
 * which it is raised one step (115); `stepPct` the adjustment as a % of the fixed real baseline (10); `maxRaisePct` the
 * raise ceiling as a % of that baseline (100, so guardrails only recover spending to the planned baseline and can only
 * protect against running out; the user raises it to opt into spending more). Cuts are floored at essential spending.
 * Editor validation: `0 <= lowerBandPct < upperBandPct`, `0 < stepPct <= 100`, `maxRaisePct >= 100`; these are
 * behavioral parameters, not calibration-snapshot values. Resolved first-ancestor-wins by
 * `resolveDownturnGuardrailsForScenario`.
 */
export interface DownturnGuardrailsOverride {
  enabled: boolean;
  lowerBandPct: number;
  upperBandPct: number;
  stepPct: number;
  maxRaisePct: number;
  /**
   * Percent in `[0, 100]` of a year's discretionary spending preserved even at the deepest cut; essentials are never
   * cut, so this only lifts the cut floor within the discretionary band (`0` cuts all discretionary, `100` protects
   * it). Sparse-optional: `resolveDownturnGuardrailsForScenario` materializes an absent value to `50` (the `?? 0` in
   * `applyGuardrailStep` is only a fallback for a raw, unresolved config).
   */
  discretionaryFloorPct?: number;
}

/** Default guardrail knobs shared by the editor + the engine resolver. */
export const DEFAULT_DOWNTURN_GUARDRAILS: DownturnGuardrailsOverride = {
  enabled: false,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  // 100 = never spend above the planned baseline: on a healthy plan the funded ratio sits in the raise band most of
  // retirement, so a higher cap would make default guardrails mostly a spend-more rule that can lower the success
  // probability. Raise it to opt into spending more.
  maxRaisePct: 100,
  // 50 = a freshly enabled guardrail keeps half of each year's discretionary spending at its deepest cut (essentials
  // are never cut); mirrors DEFAULT_GUARDRAIL_CONFIG in guardrails.ts.
  discretionaryFloorPct: 50,
};

// Default annual inflation (3%) when no scenario in the chain sets `overrides.inflation`; used by both projection
// engines and the expense charts' Future-dollars mode.
export const DEFAULT_INFLATION_PCT = 3;
/**
 * Percentage-point spread added to the general inflation rate for the seeded Medical category's default (the long-run
 * gap between BLS Medical-care CPI and CPI-U, about 2 points). A plain scenario-assumption constant outside the
 * calibration snapshot layer (which governs IRS/CMS/SSA year-keyed tables). Applies to every category with `isMedical
 * === true` (via `medicalCategoryIdsFrom`), so a recreated Medical category also gets +2pp.
 */
export const DEFAULT_MEDICAL_INFLATION_SPREAD_PCT = 2;

export const DEFAULT_COLA_PCT = 2;
export const DEFAULT_DISCRETIONARY_DURATION_YEARS = 10;

/**
 * Sparse override of the household's canonical expense list. Ids in `disabledIds` / `patches` / `reEnabledIds` carry a
 * collision-safe prefix, `aggregate:<uuid>` or `local:<uuid>` (scenario-only `added` `_localId`s); the resolvers in
 * `expense-override-resolution.ts` also accept raw ids and normalize them to `aggregate:<raw>`.
 * - `disabledIds`: hidden when this scenario is active; the first ancestor's disable wins.
 * - `added`: scenario-only expenses, each with a stable `_localId` used as the handle by "Move to household list".
 * - `patches`: per-id partial payloads, top-level replace per key (no deep merge), first ancestor's patch per id wins;
 * a `null` value
 *   clears that inherited optional key (see `PatchWithClears`).
 * - `reEnabledIds`: overrules an ancestor's `disabledIds` entry; within one scenario, disable wins over re-enable.
 */
export interface ExpensesOverride {
  disabledIds?: string[];
  added?: Array<ExpensePayload & { _localId: string }>;
  patches?: Record<string, PatchWithClears<ExpensePayload>>;
  reEnabledIds?: string[];
}

/**
 * Sparse override of the canonical IncomeStream list, shaped like {@link ExpensesOverride} (disable, patch, add with a
 * `_localId`, re-enable) with the same id-prefix convention.
 */
export interface IncomeOverride {
  disabledIds?: string[];
  added?: Array<IncomeStreamPayload & { _localId: string }>;
  patches?: Record<string, PatchWithClears<IncomeStreamPayload>>;
  reEnabledIds?: string[];
}

/**
 * Withdrawal strategy. `taxEfficient` (default; an absent strategy migrates to it in scenario v8 -> v9): taxable, then
 * pre-tax, then Roth. `proportional`: drain all accounts proportionally. `rothFirst`: Roth, taxable, pre-tax.
 * `customOrder`: user-authored tiers (see {@link CustomDrawdownOrder}). The tax-integration layer runs per year in all
 * of them.
 */
export type WithdrawalStrategy =
  | { kind: 'taxEfficient' }
  | { kind: 'proportional' }
  | { kind: 'rothFirst' }
  | { kind: 'customOrder' };

/**
 * Custom drawdown sequence: 0-indexed tiers drawn sequentially within a tier (`tier[0]` fully drained before
 * `tier[1]`); accounts in `excludedAccountIds` are never drawn from. Validated at save: no duplicate ids across tiers
 * or excluded, every opted-in household account in exactly one tier or excluded, and at least one non-empty tier. HSAs
 * default to excluded on first open; stale entries (deleted accounts) are pruned silently on load and dirty-flagged.
 */
export interface CustomDrawdownOrder {
  /** Ordered tiers of account IDs; tier[0] drained first. */
  tiers: string[][];
  /** Account IDs never drawn from (e.g. HSA reserve, future inheritance). */
  excludedAccountIds: string[];
}

/** Cap behavior: `minimize` draws minimal pre-tax and converts $0; `fill` auto-converts leftover cap room to Roth. */
export type MagiCapMode = 'minimize' | 'fill';

/**
 * MAGI line the cap targets: `irmaa` is federal/IRMAA MAGI (taxable SS only), `aca` is ACA-PTC MAGI (full SS add-back).
 */
export type MagiCapLine = 'irmaa' | 'aca';

/**
 * One rung of the user-authored conversion ladder: its own start, end, ceiling, mode, MAGI line and target Roth. Active
 * in calendar year `startYear <= year < endYear`, resolved from `start`/`end` against the scenario's retirement year
 * and member birthdates (month-resolved anchors collapse to whole tax years; `end{kind:'age',years:N}` is exclusive,
 * the year the member turns N, matching the legacy `year < birthYear+endAge`). Anchors are restricted to static
 * whole-year kinds (`start`: retirementStart | age | year; `end`: age | year); the migration and engine normalize or
 * reject others defensively.
 */
export interface MagiCapWindow {
  /** When the cap turns on (inclusive). */
  start: Extract<ScheduleStart, { kind: 'retirementStart' | 'age' | 'year' }>;
  /** When the cap turns off (exclusive). */
  end: Extract<ScheduleEnd, { kind: 'age' | 'year' }>;
  /**
   * Maximum pre-tax taxable income (withdrawals + Roth conversions) per year, whole non-negative dollars. `0` means no
   * pre-tax income while active (draw only from taxable/Roth, convert nothing); a positive value allows up to that many
   * pre-tax dollars before routing the remainder to later taxable tiers (skip-ahead) or recording a breach if none
   * exists. In Fill mode, leftover headroom is auto-converted to the target Roth. Required on a persisted window: the
   * engine boundary is non-nullable and the UI blocks save until set.
   */
  magiCeilingAnnualDollars: number;
  capMode: MagiCapMode;
  capMagiLine: MagiCapLine;
  /**
   * Target Roth account for Fill-mode conversions; absent, dangling or non-Roth degrades Fill to withdrawal-only fill
   * with a per-window notice.
   */
  targetRothAccountId?: string;
}

/**
 * MAGI-ceiling overlay for ACA-subsidy/IRMAA management: a schedule of non-overlapping windows, orthogonal to the
 * withdrawal strategy. Each window holds the year's total pre-tax taxable income (withdrawals + conversions) under its
 * own ceiling while active. Overlap is UI-validated (the engine picks the earliest-start window on a residual overlap);
 * gaps mean no cap that year. `{ windows: [] }` is no cap. The whole `windows` array is one inheritable key,
 * first-ancestor-wins with no per-window merge; the `MagiCapDisabled` sentinel turns the ladder off for a child. The
 * legacy single-window cap migrates to a one-window ladder with identical output (scenario v4 -> v5).
 */
export interface MagiCapOverride {
  windows: MagiCapWindow[];
}

/**
 * Explicit-disable sentinel for a child's `magiCap`: because resolution is first-ancestor-wins, `{ disabled: true }`
 * shadows an inherited cap. Read sites coerce it to "no cap" (`isMagiCapDisabled`), so the engine never sees it.
 * Additive, no schemaVersion bump: existing data never carries it and no validator rejects unknown union members.
 */
export interface MagiCapDisabled {
  disabled: true;
}

/** True when a resolved `magiCap` is the `{ disabled: true }` sentinel rather than a real cap. */
export function isMagiCapDisabled(
  v: MagiCapOverride | MagiCapDisabled | undefined,
): v is MagiCapDisabled {
  return v !== undefined && 'disabled' in v;
}

// ACA benchmark SLCSP override for one calendar year, replacing the engine's age-based formula. It is also the annual
// SLCSP override the month-aware health engine reuses (`roughHouseholdAnnualBenchmarkCents`), keyed by tax year.
interface AcaPtcBenchmarkOverride {
  taxYear: number;
  /**
   * Whole-year benchmark SLCSP premium for the household, in dollars (not cents). §36B(b)(2) sums the credit over
   * Marketplace coverage months, so the integration layer prorates this to the covered months
   * (`overrideBenchmarkCentsForCoverageMonths`); storing a part-year figure here would be charged twice.
   */
  annualSlcspDollars: number;
}

/**
 * One member's Medicare/Marketplace coverage months for one tax year, each a whole count 0..12. Part B and Part D are
 * independent (a member may enroll in one, or start each in a different month in a mid-year ACA -> Medicare
 * transition). Every field is sparse-optional: absent means the operational default (see
 * `HealthCoverageMonthsOverride`), never zero.
 */
export interface MemberCoverageMonths {
  partBMonths?: number;
  partDMonths?: number;
  marketplaceMonths?: number;
}

/**
 * Per-member, per-year coverage months: `perMember[memberId][taxYear]` (member ids as in
 * `acaMarketplaceOptOutMemberIds`), sparse at every level; a missing entry uses the operational default. Precedence
 * with the whole-year `acaMarketplaceOptOutMemberIds` list, as the health engine applies it:  - an explicit
 * `marketplaceMonths` wins, even for an opted-out member (the user stated the months);  - absent `marketplaceMonths`
 * for an opted-out member resolves to zero Marketplace months (the opt-out is never reverted to full    coverage
 * because these newer fields are empty);  - absent for a member not opted out resolves to the automatic count: the
 * complement of that member's Medicare entitlement months,    for a retired, age-known member, labeled and
 * user-editable. Absent Part B/D months use the automatic entitlement count: enrollment from the month the member turns
 * 65 (the month before for a first-of-the-month birthday), so the turning-65 year carries only its remaining months and
 * later years 12. §36B(c)(2)(B) caps Marketplace at `12 - max(partB, partD, entitlement)`. This derivation runs on both
 * engines with no stored rows.
 */
export interface HealthCoverageMonthsOverride {
  perMember: Record<string, Record<number, MemberCoverageMonths>>;
}

/**
 * Post-retirement asset-allocation override (the "growth vs income" glide). When present, a growth share is worked out
 * per retirement calendar year (linear glide from `startGrowthPct` to `endGrowthPct` over `glideStartYear` ->
 * `endYear`, with an optional `incomeOnlyYear` cutoff) and applied to each account separately; there is no pooled
 * bucket or income-first withdrawal order.  - Deterministic: every account except a Cash Balance Pension (which keeps
 * its scalar rate) grows at    `share·growthRatePct + (1-share)·incomeRatePct` (`balance-projection-runner-context.ts`,
 * `allocation-glide.ts`).  - Monte Carlo: the share sets each account's per-step stocks/bonds/cash mix (the non-stock
 * part split by the account's own    bonds:cash ratio) and sampled historical returns apply to it, so the two rates are
 * unused (`monte-carlo-glide.ts`,    `balance-projection-runner-mc-glide.ts`). `growthRatePct` / `incomeRatePct` are
 * forward-looking scenario-level annual rates (e.g. 7.0 / 3.0), deterministic only. `startGrowthPct` (0..100) is the
 * allocation at retirement. `endGrowthPct` is the target at `endYear`; `null` means no glide (flat at
 * `startGrowthPct`), paired with a `null` `endYear`, and years past `endYear` stay at it. The caller computes `endYear`
 * from the primary's birth year and the entered end age, keeping the engine member-agnostic. Absent: each account grows
 * at its own scalar rate or asset mix, unchanged over time.
 */
export interface RetirementAllocationOverride {
  growthRatePct: number;
  incomeRatePct: number;
  startGrowthPct: number;
  endGrowthPct: number | null;
  endYear: number | null;
  /**
   * Calendar year the glide begins: flat at `startGrowthPct` from retirement through this year, then linear toward
   * `endGrowthPct` at `endYear`. The modal takes "Start glide after N years into retirement" and stores `retirementYear
   * + N`. Absent starts at retirement; meaningful only when `endGrowthPct` and `endYear` are both set.
   */
  glideStartYear?: number | null;
  /**
   * Optional hard cutoff: from this calendar year the growth share is forced to 0% (100% income). The modal takes "100%
   * income at <primary>'s age N" and stores `primaryBirthYear + N`. Null or absent: no cutoff. With a glide it applies
   * after the glide's natural endpoint (a glide landing at 30% growth stays there until this year, then snaps to 0%);
   * without one the allocation is flat at `startGrowthPct` until then. Validated to be after the retirement year (and
   * after `endYear` when a glide is set).
   */
  incomeOnlyYear?: number | null;
}

/**
 * One Qualified Charitable Distribution directive: a member aged 70½+ sends a fixed real annual amount from one
 * designated traditional IRA (`RETIREMENT_IRA` + `PRE_TAX`) straight to charity. It counts toward that owner's IRA-pool
 * RMD and is excluded from taxable income/MAGI, leaving the portfolio once (it does not fund household spending). A
 * member may have several entries; the indexed per-person exclusion limit (§408(d)(8)) is consumed once across all of
 * them per owner-year. `start`/`end` reuse the `age`/`year` anchors of `preRetirementRothConversions` (an older client
 * ignores an unknown future kind); a single year is a one-year window. Resolved and hardened by `resolveQcdForScenario`
 * (scenario-resolution.ts): dangling or cross-owner ids, non-PRE_TAX-IRA sources and non-finite or negative amounts are
 * dropped, and `start` is clamped up to the 70½ first-eligible tax year.
 */
export interface QcdEntry {
  /** Household member id (the account `ownerId`) directing this gift. */
  readonly memberId: string;
  /** Source account id; must resolve to a `RETIREMENT_IRA` + `PRE_TAX` account owned by `memberId`. */
  readonly sourceAccountId: string;
  /**
   * Fixed real (today's-dollars) annual amount, inflated to nominal each projection year before the cap comparison;
   * finite, >= 0.
   */
  readonly annualAmountDollars: number;
  readonly start: Extract<MagiCapWindow['start'], { kind: 'age' | 'year' }>;
  readonly end: Extract<MagiCapWindow['end'], { kind: 'age' | 'year' }>;
}

// Sparse-optional additions on `overrides` need no schemaVersion bump (precedent `acaMarketplaceOptOutMemberIds`);
// `accountFloors` is the exception (v7 -> v8).
export interface ScenarioOverrides {
  retirementAge?: RetirementAgeOverride;
  socialSecurity?: SocialSecurityOverride;
  /**
   * Legacy scalar federal filing status; absent derives from household composition. Transition-unsafe: a stored `MFJ`
   * survives a spouse's death and keeps filing jointly. Kept alongside `taxFilingPlan`; the filing editor's first plan
   * save omits this key (an omission, never a stored null). See `lib/filing-status.ts`.
   */
  filingStatus?: FilingStatusOverride;
  /**
   * Scenario tax filing plan, the transition-safe successor to `filingStatus`: a union (`individual` | `joint` |
   * `separate`) able to express joint filing while both spouses live, separate tax units with their own status and
   * household size, death-year joint treatment, the post-death `Single` default, and year-bounded `QSS`/`HoH` exception
   * windows. Absent derives a plan from the legacy scalar (via the scalar x household-cardinality matrix) or from
   * household composition; present it supersedes the scalar. Resolved per projection year by `resolveFilingPlanForYear`
   * in both engines. The type lives in `filing-status.ts` to avoid a type-only import cycle.
   */
  taxFilingPlan?: TaxFilingPlan;
  contributions?: ContributionsOverride;
  lifeExpectancy?: LifeExpectancyOverride;
  inflation?: InflationOverride;
  discretionarySpending?: DiscretionarySpendingOverride;
  /**
   * Downturn spending guardrails, Monte Carlo only; absent or `enabled: false` is inert. Resolved first-ancestor-wins
   * by `resolveDownturnGuardrailsForScenario`; see `DownturnGuardrailsOverride`.
   */
  downturnGuardrails?: DownturnGuardrailsOverride;
  expenses?: ExpensesOverride;
  income?: IncomeOverride;
  withdrawalStrategy?: WithdrawalStrategy;
  /** Custom drawdown sequence; used only when `withdrawalStrategy.kind === 'customOrder'`. */
  customDrawdownOrder?: CustomDrawdownOrder;
  /**
   * MAGI cap overlay for ACA-subsidy management, valid with any named strategy. The `MagiCapDisabled` sentinel lets a
   * child turn off an inherited cap; read sites coerce it to "no cap" via `isMagiCapDisabled`.
   */
  magiCap?: MagiCapOverride | MagiCapDisabled;
  retirementAllocation?: RetirementAllocationOverride;
  /**
   * Fraction (0..1, default 0.5) of a POST_TAX (non-Roth) withdrawal assumed to be long-term gain/qualified dividend
   * for LTCG; the rest is untaxed return of cost basis.
   */
  assumedCostBasisFractionOfTaxableWithdrawal?: number;
  /**
   * MAGI for projection year 0, `MAGI(ret-2)` (IRMAA looks back two years), in whole dollars. Absent skips IRMAA for
   * year 0 unless the deterministic engine estimates it from the projected first-year MAGI. Split from the former
   * `magiBootstrapForFirstTwoYears` (scenario v2 -> v3).
   */
  magiBootstrapLookbackMinus2?: number;
  /**
   * MAGI for projection year 1, `MAGI(ret-1)`, in whole dollars; absent skips IRMAA for year 1 unless the engine
   * estimates it.
   */
  magiBootstrapLookbackMinus1?: number;
  /** Per-year ACA benchmark SLCSP overrides, sparse by tax year; absent years use the engine's age-based formula. */
  acaPtcBenchmark?: AcaPtcBenchmarkOverride[];
  /**
   * Per-account override of `plannedContributionPreTax`/`PostTax`, sparse; read via
   * `resolveAccountContributionsForScenario`.
   */
  accountContributions?: AccountContributionsOverride;
  /**
   * Per-account override of `planningReturnPct`, sparse; Planned projection method only (TWR is empirical); read via
   * `resolveAccountReturnsForScenario`.
   */
  accountReturns?: AccountReturnsOverride;
  /** Per-account override of `assetMix`, sparse; Monte Carlo only; read via `resolveAccountAssetMixForScenario`. */
  accountAssetMix?: AccountAssetMixOverride;
  /**
   * Per-account minimum-balance floors (see `AccountFloorsOverride`), nominal dollars, applying to every named
   * strategy; read and sanitised by `resolveAccountFloorsForScenario`. Its schemaVersion bump (v7 -> v8, identity
   * migration) makes a down-version client reject a floored scenario instead of mis-resolving it: a floor is
   * wrong-number class, not a safe degrade.
   */
  accountFloors?: AccountFloorsOverride;
  /**
   * Percent (0..100, absent = 100) of emergency-reserve HSA withdrawals assumed spent on qualified medical expenses;
   * modeled medical-qualified withdrawals are always 100% qualified. Qualified is tax-free; the rest is ordinary income
   * plus, before 65, the 20% HSA additional tax.
   */
  hsaQualifiedMedicalExpensePct?: number;
  /**
   * Account ids exempt from the early-withdrawal additional tax (10% before 59.5 on IRA/401k, 20% before 65 on HSA),
   * for exceptions the app doesn't model individually (SEPP/72(t), disability). Absent: none exempt.
   */
  earlyWithdrawalPenaltyExemptAccountIds?: string[];
  /**
   * Member ids treated as not on the ACA Marketplace (retiree, COBRA or spousal-employer coverage), so no premium tax
   * credit is credited for their pre-65 retirement years; the benchmark and covered-count narrow to the remaining
   * members. Absent: every retired pre-65 member stays on the Marketplace.
   */
  acaMarketplaceOptOutMemberIds?: readonly string[];
  /**
   * Per-member, per-year Medicare Part B/D and ACA Marketplace coverage months, so IRMAA is charged only for months
   * actually enrolled (Part B and D separately) and the ACA subsidy is priced on actual Marketplace months instead of a
   * whole-year on/off shortcut. Keyed by member id then tax year; precedence with `acaMarketplaceOptOutMemberIds` is in
   * `HealthCoverageMonthsOverride`.
   */
  healthCoverageMonths?: HealthCoverageMonthsOverride;
  /**
   * Federal-poverty-level region for the ACA subsidy (`'contiguous'`, `'alaska'`, `'hawaii'`), selecting the HHS
   * poverty-guideline schedule for the FPL denominator. Absent: `'contiguous'`.
   */
  acaFplRegion?: AcaFplRegion;
  /**
   * Working-years (still employed) Roth conversions, deterministic projection only (Monte Carlo untouched): each entry
   * moves the full `annualAmountDollars` (flat nominal, no inflation growth) from one pre-tax `sourceAccountId` to a
   * `targetRothAccountId` that must be a `RETIREMENT_ROTH_IRA` (the §408A double-tax guard) in each working year of its
   * `start`/`end` window, using the `MagiCapWindow` `age`/`year` anchors (an older client ignores an unknown future
   * kind). A one-year window is a single conversion. The displayed tax burden uses
   * `preRetirementRothConversionTaxRatePct` and is never deducted. Absent: none. Resolved and hardened by
   * `resolvePreRetirementRothConversions` (scenario-resolution.ts): non-finite amounts rejected, amounts clamped >= 0,
   * dangling or cross-household ids and non-pre-tax sources or non-Roth-IRA targets dropped (no-op, never an error).
   */
  preRetirementRothConversions?: ReadonlyArray<{
    readonly sourceAccountId: string;
    readonly targetRothAccountId: string;
    readonly annualAmountDollars: number;
    readonly start: Extract<MagiCapWindow['start'], { kind: 'age' | 'year' }>;
    readonly end: Extract<MagiCapWindow['end'], { kind: 'age' | 'year' }>;
  }>;
  /**
   * Assumed marginal tax rate (percent, clamped to [0, 100], absent = 0) used only for the displayed additional tax
   * burden of the working-years conversions, `converted x rate`; never deducted from any account.
   */
  preRetirementRothConversionTaxRatePct?: number;
  /**
   * Working-years total taxable income (post-standard-deduction whole dollars) used only by the Roth conversion
   * comparison page to size pre-retirement bracket headroom, `max(0, nextBracketCeiling - this -
   * existingAnnualConversionAmount)`. Already taxable income (not MAGI or gross). Drives no projection math; absent
   * shows a needs-input state, not zero headroom.
   */
  preRetirementTaxableIncomeDollars?: number;
  /**
   * Qualified Charitable Distributions: per-member directives giving a fixed real annual amount from a designated
   * traditional IRA straight to charity from the 70½ first-eligible tax year; see `QcdEntry`. Absent: no QCD.
   */
  qualifiedCharitableDistributions?: readonly QcdEntry[];
}
