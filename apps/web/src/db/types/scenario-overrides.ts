/**
 * Per-scenario override shapes and the `ScenarioOverrides` aggregate section
 * they all converge into. The cross-aggregate schedule/anchor + patch
 * vocabulary lives in `aggregate-base.ts`; the expense / income payload shapes
 * these overrides patch live in their own modules. Re-exported through the
 * `db/types` barrel.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is a
 * type-only schema contract for a single aggregate — ~26 distinct per-scenario
 * override interfaces (`RetirementAgeOverride`, `ContributionsOverride`,
 * `DownturnGuardrailsOverride`, `MagiCapOverride`, `AcaPtcBenchmarkOverride`, …)
 * that all converge into the one `ScenarioOverrides` shape the resolver, the
 * engines, and every scenario editor agree on by construction. Splitting the
 * override interfaces across further files would fragment one cohesive
 * aggregate's shape (a fake seam — the overrides only exist to compose
 * `ScenarioOverrides`), not reveal a real module boundary, and invite
 * divergence between overrides that must agree. Where a field's type union
 * lives elsewhere (`TaxFilingPlan` in `../../lib/filing-status.ts`,
 * `AcaFplRegion` in `../../lib/aca-ptc.ts`) it is type-only-imported to avoid
 * an import cycle, so only the field itself lands in this aggregate shape.
 * There is no runtime code here beyond one small pure type-guard
 * (`isMagiCapDisabled`) co-located with the union it guards. Trigger: a change
 * adding 5 or more lines here must either refactor the file back under the
 * limit or re-justify this exception in this note.
 */

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
 * Retirement-age override per scenario.
 *
 * Two modes the UI exposes via a three-radio picker:
 *
 * 1. **Independent** (`sameDateAnchor` undefined): each member sets
 *    their own age. `primary` and `secondary` are both editable;
 *    calculations read both directly.
 * 2. **Same-date** (`sameDateAnchor` = `'primary'` or `'secondary'`):
 *    the named anchor's age is editable; the other member's age is
 *    derived from `anchorBirthdate + anchorAge - otherBirthdate` so
 *    both members retire on the same calendar date. The derived age
 *    is still persisted into `primary` / `secondary` so calculations
 *    can read ages directly without consulting birthdates.
 *
 * Calculations always read `primary.age` and `secondary.age` directly.
 * `sameDateAnchor` is UI metadata — preserves the user's intent across
 * edits so toggling the anchor's age auto-recomputes the other.
 */
export interface RetirementAgeOverride {
  primary: RetirementAgePerMember;
  secondary?: RetirementAgePerMember;
  sameDateAnchor?: 'primary' | 'secondary';
}

/**
 * Social Security override per scenario. Carries claim ages plus
 * scenario-level forward assumptions (a benefit-reduction haircut and
 * a Cost-of-Living Adjustment percentage) so consumers projecting
 * lifetime SS income honor the same scenario knobs as everything else.
 *
 * Each household member sets their own claim age — there is no "same
 * as primary" shortcut (couples routinely claim at different ages to
 * optimize spousal / survivor benefits, so a same-age default would
 * mislead). `secondary` is optional in storage: only present when the
 * user has explicitly set the secondary member's claim age. The UI
 * defaults the secondary input to 67y 0m when a secondary household
 * member exists but no override value is recorded yet.
 *
 * `benefitReductionPct` (0 / 10 / 25 / 50) models a hypothetical
 * across-the-board cut to claimed benefits — the trust-fund
 * exhaustion scenarios published by SSA. `0` means no haircut.
 * `colaPct` is the assumed annual cost-of-living adjustment,
 * compounded for years after each member's SSA statement anchor year
 * (the `piaAsOfDate` year; the age-62 eligibility year when no
 * statement date is on file), regardless of claim age. Both
 * default to 0 / 2 respectively when absent everywhere in the parent
 * chain.
 *
 * `colaTracksInflation` ties the SS COLA to the scenario's general
 * inflation rate instead of the fixed `colaPct`. Default-on (product
 * decision): absent / `true` → the benefit grows at the scenario
 * inflation rate, so the projection's real-dollar SS line stays flat
 * (SS COLA is CPI-indexed in reality). Only an explicit `false` opts
 * out and falls back to the fixed `colaPct`. Resolve via
 * `resolveSsColaPct` — the single read point all engines share.
 */
export interface SocialSecurityOverride {
  primary: RetirementAgePerMember;
  secondary?: RetirementAgePerMember;
  /**
   * Per-member SURVIVOR-benefit claim age — the age at
   * which that member, if widowed, starts the survivor benefit. A decision
   * SEPARATE from the member's own claim age above (42 USC 402(e)/(f):
   * survivor benefits are payable from age 60 and carry their own reduction
   * schedule; delaying past the survivor's FRA earns nothing).
   *
   * Sparse-optional at both levels: the section and each member key may be
   * absent. ABSENCE SEMANTICS: a member with no survivor claim age has
   * their survivor-dependent results WITHHELD — the projection pays only
   * that member's own benefit after their spouse's death, flags
   * `survivorWithheld` on the affected years, and the UI prompts for the
   * missing input. Never silently defaulted (an early-claim default would
   * not be one-sided). No schemaVersion bump — sparse-optional additions on
   * `overrides` are forward-compatible (exact
   * precedent `acaMarketplaceOptOutMemberIds`).
   */
  survivor?: {
    primary?: RetirementAgePerMember;
    secondary?: RetirementAgePerMember;
  };
  benefitReductionPct?: number;
  colaPct?: number;
  colaTracksInflation?: boolean;
}

/**
 * @deprecated alias preserved for any external reference; the
 * canonical name is now `SocialSecurityOverride`.
 */
export type SocialSecurityClaimAgeOverride = SocialSecurityOverride;

/**
 * Future-contributions override per scenario.
 *
 * Single boolean: when true, the projection skips every contribution
 * add (planned + extrapolated company) and the household coasts on
 * pure compound growth from the latest balance to retirement. Useful
 * for "what if I lose my job tomorrow" / "early retirement" what-if
 * scenarios.
 *
 * Default when absent anywhere in the parent chain: contributions
 * continue until each account's owner retires.
 *
 * Note: per-account contribution overrides live on a separate
 * `accountContributions` section. The two coexist intentionally —
 * `stopContributionsToday` is a global short-circuit that wins over
 * any per-account amount, while per-account values let the user tweak
 * individual accounts without affecting the rest.
 */
export interface ContributionsOverride {
  stopContributionsToday: boolean;
}

/**
 * Per-scenario override for the per-account planned annual contribution
 * targets. Sparse: `perAccount` only carries entries for accounts the
 * scenario explicitly overrides. Missing entries (and missing accountIds
 * the user never touched) fall through to `Account.payload`'s
 * `plannedContributionPreTax` / `plannedContributionPostTax`.
 *
 * Each entry's `preTax` / `postTax` / `contributionGrowthPct` are
 * independently optional — a scenario can override just one side or just
 * the growth rate. An undefined side resolves to the account's baseline
 * value at projection time.
 *
 * Resolution: per-account first-ancestor-wins through the parent chain
 * (matches the per-key inheritance the user expects from the UI's
 * "resolved-from-parent" baseline column). See
 * `resolveAccountContributionsForScenario` (amounts) +
 * `resolveContributionGrowth` (rate) in `scenario-resolution.ts`.
 *
 * `ContributionsOverride.stopContributionsToday` remains a global
 * short-circuit above this section — when true, every contribution
 * (overridden or not) is skipped.
 */
interface AccountContributionsOverride {
  perAccount: Record<
    string,
    {
      plannedContributionPreTax?: number;
      plannedContributionPostTax?: number;
      /** Per-scenario override of the per-account annual-increase rate
       *  (percent). Absent → inherit the baseline / ancestor value (or
       *  tracks-inflation when nothing in the chain sets it). Explicit
       *  number (incl. `0`) → fixed COLA. Same accepted domain + boundary
       *  sanitisation as `AccountPayload.contributionGrowthPct`. */
      contributionGrowthPct?: number;
    }
  >;
}

/**
 * Per-scenario per-account minimum-balance floor.
 * Sparse: `perAccount` only carries entries for accounts the scenario
 * explicitly floors. Missing entries (and accountIds the user never set)
 * mean "no floor" — the account is fully drawable.
 *
 * A floor protects an eligible account (engine eligibility predicate:
 * `taxTreatment ∈ {POST_TAX, HSA}`) from discretionary depletion: the
 * drawdown engine never takes a discretionary withdrawal that would drop the
 * account below `floorDollars`. Floors are stored in NOMINAL dollars —
 * they do not inflation-adjust, so their real purchasing power erodes over
 * long horizons (disclosed in the UI).
 *
 * Per-FIELD resolution: `floorDollars` and `hsaMode` resolve
 * independently first-ancestor-wins, so a child overriding the dollar floor
 * never clobbers an ancestor's `hsaMode`.
 *
 * CWE-20 CONTRACT (sanitised by `resolveAccountFloorsForScenario` in
 * `lib/scenario-resolution.ts` — the sole engine-side consumer; import bundles
 * are the threat surface):
 *  - `floorDollars`: accepted domain is finite and `≥ 0`. A non-finite or
 *    negative value reads as "no floor". `null` clears the inherited floor.
 *    Absent inherits from the ancestor chain.
 *  - `hsaMode`: any value not STRICTLY EQUAL to `'strict'` reads as
 *    `'emergencyOnly'` (the default). `null` clears the inherited mode.
 *    POST_TAX accounts ignore this field entirely.
 */
interface AccountFloorsOverride {
  perAccount: Record<
    string,
    {
      /** Minimum balance to protect, NOMINAL dollars. Accepted domain: finite,
       *  `≥ 0`. Non-finite / negative → no floor (CWE-20, resolver boundary).
       *  `null` clears the inherited floor. */
      floorDollars?: number | null;
      /** HSA-only floor mode. `'emergencyOnly'` (default): the floor
       *  blocks only the emergency-reserve draw (PASS B); medical-qualified
       *  draws (PASS A) always proceed. `'strict'`: the floor blocks ALL draws
       *  including medical. Any value not strictly `'strict'` reads as
       *  `'emergencyOnly'` (CWE-20). `null` clears the inherited mode. Ignored
       *  for POST_TAX accounts. */
      hsaMode?: 'emergencyOnly' | 'strict' | null;
    }
  >;
}

/**
 * Per-scenario override for the per-account planned return rate.
 * Sparse: `perAccount` only carries entries for accounts the scenario
 * explicitly overrides. Missing entries fall through to
 * `Account.payload.planningReturnPct`.
 *
 * Affects only the **Planned** projection method on the Balance
 * Projection page. The TWR method is empirical (computed
 * from each account's own balance history) and is not overrideable as
 * a rate — overriding it would amount to lying about delivered
 * returns.
 *
 * Resolution: per-account first-ancestor-wins through the parent chain.
 * See `resolveAccountReturnsForScenario` in `scenario-resolution.ts`.
 */
interface AccountReturnsOverride {
  perAccount: Record<
    string,
    {
      planningReturnPct?: number;
    }
  >;
}

/**
 * Per-scenario override of the per-account asset mix. Sparse:
 * `perAccount` only carries entries for accounts the scenario explicitly
 * overrides. Missing entries fall through to `Account.payload.assetMix`.
 *
 * An override entry replaces the full `{ stocksPct, bondsPct, cashPct }`
 * triple — the form-level validator ensures the sum is 100.0 ± 0.05.
 * Affects the Monte Carlo projection only; deterministic methods do not
 * read the mix.
 *
 * Resolution: per-account first-ancestor-wins through the parent chain.
 * See `resolveAccountAssetMixForScenario` in `scenario-resolution.ts`.
 */
interface AccountAssetMixOverride {
  perAccount: Record<string, AssetMix>;
}

/**
 * Per-member life-expectancy override per scenario. Sparse: present
 * only when the scenario explicitly sets it. Each value is a whole
 * number of years (months dropped pre-launch). When absent in the
 * parent chain, math falls back to `DEFAULT_LIFE_EXPECTANCY_AGE`.
 *
 * Life expectancy is a scenario-level assumption — it's not a
 * household member field — so "what if I live to 100" modelling is
 * scoped per-scenario without touching the household record.
 */
export interface LifeExpectancyOverride {
  primary?: number;
  secondary?: number;
}

/**
 * Inflation override per scenario. Drives the chart band's annual
 * escalation of expense amounts. Default when absent in the parent
 * chain: 3%.
 *
 * `categoryRates` (optional, sparse) carries a per-category effective
 * inflation rate (percent) keyed by ExpenseCategory aggregate id. A
 * category absent from the map inflates at the general `ratePct`; the
 * seeded Medical category (`cat-medical`) defaults to
 * `ratePct + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` even when absent.
 * Sparse on save (only categories whose rate differs from their default
 * are stored); orphan keys (a category since deleted, or an imported
 * scenario referencing an absent category) are preserved verbatim and
 * are inert in the engine. Resolved per-key via
 * `resolveInflationForScenario`, which returns a prototype-safe `Map`
 * and drops dangerous keys / non-finite / out-of-`[0,10]` values.
 */
export interface InflationOverride {
  ratePct: number;
  categoryRates?: Record<string, number>;
}

/**
 * Discretionary-adjustment override per scenario. `bumpPct` scales every
 * `discretionary` expense by `(1 + bumpPct/100)` while the year is
 * inside the active window. `durationYears = null` means whole
 * retirement; a positive integer means "first N retirement years".
 *
 * `bumpPct` is an integer percentage in [-100, +100]; the editor UI
 * constrains input to that range in 5% steps. Negative values reduce
 * discretionary spending; 0 = no change; positive values increase it.
 * Stored values outside [-100, +100] are clamped at the math layer
 * (no migration needed — the domain change is backward-compatible).
 */
export interface DiscretionarySpendingOverride {
  bumpPct: number;
  durationYears: number | null;
}

/**
 * Downturn-guardrails override per scenario. A risk-based dynamic-spending
 * rule the Monte Carlo projection applies per path per year: it cuts spending
 * in bad markets and raises it in good ones, keyed off the funded ratio
 * (portfolio ÷ present value of remaining net spending need). Opt-in
 * (`enabled` defaults false), so an absent / disabled config leaves the
 * projection byte-identical to the pre-feature engine.
 *
 * Fields (all percent):
 *   - `lowerBandPct` — funded ratio at/below which spending is CUT one step
 *     (default 85).
 *   - `upperBandPct` — funded ratio at/above which spending is RAISED one step
 *     (default 115).
 *   - `stepPct` — fixed adjustment step, % of the fixed real baseline spend
 *     (default 10).
 *   - `maxRaisePct` — raise ceiling as a % of the fixed real baseline spend
 *     (default 100 — guardrails only ever recover spending back to the planned
 *     baseline, never above it, so enabling them can only protect against
 *     running out; the user raises this to opt into spending more in good
 *     markets). Cuts are floored at essential spending (never below).
 *
 * Editor validation: `0 ≤ lowerBandPct < upperBandPct`, `0 < stepPct ≤
 * 100`, `maxRaisePct ≥ 100`. The bands/step/cap are behavioral planning
 * parameters, NOT calibration-snapshot values. Resolved
 * first-ancestor-wins by `resolveDownturnGuardrailsForScenario`. Fires in Monte
 * Carlo only — the fixed-return deterministic engine has no downturn
 * to react to. See "Spending guardrails" in docs/math-projections.md.
 */
export interface DownturnGuardrailsOverride {
  enabled: boolean;
  lowerBandPct: number;
  upperBandPct: number;
  stepPct: number;
  maxRaisePct: number;
  /**
   * Share of a year's DISCRETIONARY spending the guardrail preserves even at its
   * deepest cut, percent in `[0, 100]`. Essentials are never cut — this
   * dial only lifts the cut floor UP within the discretionary band. `0`
   * reproduces the pre-feature cut-all-discretionary floor; `100` protects
   * discretionary entirely. Optional (sparse-optional): an absent field is
   * materialized to the default `50` by `resolveDownturnGuardrailsForScenario`
   * (NOT `0` — the `?? 0` in `applyGuardrailStep` is only a defensive fallback
   * for a raw, unresolved config).
   */
  discretionaryFloorPct?: number;
}

/** Default guardrail knobs shared by the editor + the engine resolver. */
export const DEFAULT_DOWNTURN_GUARDRAILS: DownturnGuardrailsOverride = {
  enabled: false,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  // 100 = never spend above the planned baseline by default. On a healthy plan
  // the funded ratio sits in the raise band most of retirement, so a cap > 100
  // makes default guardrails predominantly a spend-MORE rule that can LOWER the
  // success probability — the opposite of what a downside-protection toggle
  // should do. Defaulting to 100 keeps the raise branch as recover-to-baseline
  // only (monotonically non-harmful to success); the user opts into spending
  // more by raising this.
  maxRaisePct: 100,
  // 50 = a freshly-enabled guardrail keeps HALF of each year's discretionary
  // spending at its deepest cut (gentler than cut-all-discretionary). Essentials
  // are never cut for any value; 0 reproduces the pre-feature floor, 100 protects
  // discretionary entirely. Mirrors DEFAULT_GUARDRAIL_CONFIG in guardrails.ts.
  discretionaryFloorPct: 50,
};

// Default annual inflation when no scenario in the chain sets
// `overrides.inflation` (3%).
// Consumed by both projection engines (balance-projection-runner-*,
// monte-carlo) and the expense charts' Future-dollars mode.
export const DEFAULT_INFLATION_PCT = 3;
/**
 * Percentage-point spread added to the resolved general inflation rate to
 * form the seeded Medical category's default effective rate (Medical
 * default = `ratePct + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT`). Source: the
 * long-run gap between the BLS Medical-care CPI and CPI-U (medical-care
 * prices have historically risen ~2 percentage points faster than overall
 * CPI). A plain scenario-assumption constant colocated with
 * `DEFAULT_INFLATION_PCT` — like that constant it lives outside the
 * calibration snapshot layer (the calibration policy governs IRS/CMS/SSA
 * year-keyed tables, not these two general assumptions). Applied to every
 * category flagged `isMedical === true` (resolved via
 * `medicalCategoryIdsFrom`), so a custom / recreated Medical category that
 * carries the flag also gets the +2pp default.
 */
export const DEFAULT_MEDICAL_INFLATION_SPREAD_PCT = 2;

export const DEFAULT_COLA_PCT = 2;
export const DEFAULT_DISCRETIONARY_DURATION_YEARS = 10;

/**
 * Per-scenario sparse override on the household's canonical expense
 * list.
 *
 * Ids in `disabledIds` / `patches` / `reEnabledIds` are stored with a
 * collision-safe prefix that distinguishes canonical aggregate ids
 * from scenario-only `added` `_localId`s: `aggregate:<uuid>` or
 * `local:<uuid>`. The per-id sparse resolvers in
 * [expense-override-resolution.ts] also accept unprefixed raw ids and
 * normalize them to `aggregate:<raw>` at read time (defensive
 * forward-compatibility insurance).
 *
 * - `disabledIds` — prefixed ids hidden when this scenario is active.
 *   Resolved per-id by walking the parent chain; the first ancestor's
 *   disable wins.
 * - `added` — scenario-only expenses. Each entry carries a `_localId`
 *   UUID that's stable across edits and used by the
 *   "Move to household list" affordance as the handle.
 * - `patches` — per-id partial payloads. Top-level replace per key;
 *   the resolver does not deep-merge. Patches resolve per-id along the
 *   parent chain (first ancestor's patch on a given id wins). A patch
 *   value of `null` for a key clears that inherited optional field for
 *   this scenario (the resolver drops the key after merging) — see
 *   `PatchWithClears`.
 * - `reEnabledIds` — prefixed ids that this scenario explicitly
 *   re-enables, overruling an ancestor's `disabledIds` entry for the
 *   same id. Same-scenario id appearing in both `disabledIds` and
 *   `reEnabledIds`: disable wins.
 */
export interface ExpensesOverride {
  disabledIds?: string[];
  added?: Array<ExpensePayload & { _localId: string }>;
  patches?: Record<string, PatchWithClears<ExpensePayload>>;
  reEnabledIds?: string[];
}

/**
 * Per-scenario override of the canonical IncomeStream list. Same
 * sparse shape as ExpensesOverride — disable a canonical entry,
 * patch fields on a canonical entry, add a scenario-only entry
 * (carrying a `_localId` UUID for stable handle / move-to-canonical),
 * or re-enable an ancestor-disabled entry via `reEnabledIds`. Ids in
 * the three sparse sections carry the same `aggregate:<uuid>` /
 * `local:<uuid>` prefix convention as [ExpensesOverride].
 */
export interface IncomeOverride {
  disabledIds?: string[];
  added?: Array<IncomeStreamPayload & { _localId: string }>;
  patches?: Record<string, PatchWithClears<IncomeStreamPayload>>;
  reEnabledIds?: string[];
}

/**
 * Per-scenario withdrawal-strategy override.
 *   taxEfficient  — taxable accounts first → pre-tax (traditional IRA/
 *                   401k) → Roth; tax-integration layer runs per year.
 *                   The default for every scenario (absent strategy migrates
 *                   to it via scenario v8→v9).
 *   proportional  — proportional drain across all accounts each year;
 *                   tax-integration layer runs per year.
 *   rothFirst     — Roth first → taxable → pre-tax; tax-integration
 *                   layer runs per year.
 *   customOrder   — user-authored tier ordering (see CustomDrawdownOrder).
 */
export type WithdrawalStrategy =
  | { kind: 'taxEfficient' }
  | { kind: 'proportional' }
  | { kind: 'rothFirst' }
  | { kind: 'customOrder' };

/**
 * Custom per-account drawdown sequence. Accounts are organized
 * into numbered tiers (0-indexed); within a tier draws are SEQUENTIAL in the
 * listed order — account `tier[0]` is fully drained before `tier[1]` is
 * touched (the shipped within-tier behavior).
 * Accounts in
 * `excludedAccountIds` are never drawn from.
 *
 * Invariants (validated at save time):
 *  - No duplicate account IDs across tiers or between tiers and excluded.
 *  - Every opted-in household account appears in exactly one tier OR
 *    in `excludedAccountIds` (no unplaced accounts).
 *  - `tiers` has at least one non-empty array (at least one drainable tier).
 *
 * HSAs default to `excludedAccountIds` on first open.
 * Stale entries (account deleted since last save) are pruned silently
 * on load + dirty-flagged.
 */
export interface CustomDrawdownOrder {
  /** Ordered tiers of account IDs; tier[0] drained first. */
  tiers: string[][];
  /** Account IDs never drawn from (e.g. HSA reserve, future inheritance). */
  excludedAccountIds: string[];
}

/** Cap behavior mode. `minimize` is today's behavior (draw minimal
 *  pre-tax, convert $0); `fill` auto-converts leftover cap room to Roth. */
export type MagiCapMode = 'minimize' | 'fill';

/** Which MAGI line the cap ceiling targets. `irmaa` = federal/IRMAA
 *  MAGI (taxable-SS-only); `aca` = ACA-PTC MAGI (full-SS add-back). */
export type MagiCapLine = 'irmaa' | 'aca';

/**
 * One time-windowed MAGI-ceiling schedule.
 *
 * Each window owns its own start, end, ceiling, behavior mode, MAGI line, and
 * target Roth — a single rung of the user-authored conversion ladder. The
 * window is active in a calendar year iff `startYear ≤ year < endYear`, where
 * the years are resolved from `start` / `end` against the scenario's
 * retirement year + member birthdates (the engine collapses month-resolved
 * anchors to whole tax years; `end{kind:'age',years:N}` is EXCLUSIVE — the
 * year the member turns N — reproducing the legacy `year < birthYear+endAge`).
 *
 * Anchor subset: a cap window restricts the shared schedule unions to
 * STATIC, whole-year-resolvable kinds only —
 *   - `start ∈ { retirementStart, age, year }`,
 *   - `end ∈ { age, year }`.
 * `lifetime` / `durationFromStart` / `endOfRetirementYear` are NOT offered for
 * cap windows; the migration + engine normalize / reject others defensively.
 */
export interface MagiCapWindow {
  /** When this window's cap turns on (inclusive). Restricted to the static
   *  kinds `retirementStart | age | year`. */
  start: Extract<ScheduleStart, { kind: 'retirementStart' | 'age' | 'year' }>;
  /** When this window's cap turns off (exclusive). Restricted to the static
   *  kinds `age | year`. */
  end: Extract<ScheduleEnd, { kind: 'age' | 'year' }>;
  /** Maximum pre-tax taxable income (withdrawals + Roth conversions) per year,
   *  whole dollars, non-negative integer. 0 = no pre-tax income while the
   *  window is active (draw exclusively from taxable / Roth; convert nothing).
   *  Positive = allow up to that many pre-tax dollars per year before routing
   *  remainder to later taxable tiers (skip-ahead) or recording a breach if no
   *  taxable exists. Under Fill mode (`capMode = 'fill'`), leftover headroom
   *  below this ceiling is auto-converted to the target Roth.
   *  Required on the persisted window (the engine boundary is
   *  non-nullable; the UI blocks save until each window's ceiling is set). */
  magiCeilingAnnualDollars: number;
  /** Behavior mode. `'minimize'` = today's behavior (convert $0);
   *  `'fill'` auto-converts leftover cap room into the target Roth. */
  capMode: MagiCapMode;
  /** MAGI line the ceiling targets: federal/IRMAA or ACA-PTC. */
  capMagiLine: MagiCapLine;
  /** Account id of the user-designated target Roth for Fill-mode conversions.
   * Absent / dangling / non-Roth → Fill degrades to withdrawal-only
   *  fill (no conversions) with a per-window notice. */
  targetRothAccountId?: string;
}

/**
 * MAGI-ceiling overlay for ACA-subsidy / IRMAA management — a SCHEDULE of
 * non-overlapping time windows. Orthogonal to the
 * withdrawal strategy; applies to every named strategy.
 *
 * Each `MagiCapWindow` holds the year's total pre-tax taxable income
 * (withdrawals + Roth conversions) under its own ceiling while the window is
 * active. Windows must NOT overlap (UI-validated; the engine defensively picks
 * the earliest-start window on a residual resolved overlap); GAPS are allowed
 * and mean no cap that year (cap off → unlimited pre-tax, no conversions).
 *
 * `{ windows: [] }` ≡ no cap (the engine treats an empty ladder as cap-off
 * every year). The whole `windows` array is one inheritable key
 * (first-ancestor-wins; a child that sets `magiCap` replaces the entire parent
 * ladder — no per-window merge). The `MagiCapDisabled` sentinel disables
 * the whole ladder for a child.
 *
 * Migration (scenario v4→v5): the legacy single-window `MagiCapOverride`
 * (`magiCeilingAnnualDollars` + `endAgeMemberRole` + `endAge` + behavior keys)
 * becomes a one-window ladder `{ windows: [{ start:retirementStart,
 * end:{age, memberId:endAgeMemberRole, years:endAge}, …carried }] }` with
 * byte-identical deterministic output.
 */
export interface MagiCapOverride {
  /** Ordered ladder of non-overlapping cap windows. `[]` ≡ no cap. */
  windows: MagiCapWindow[];
}

/**
 * Explicit-disable sentinel for a child scenario's `magiCap` override
 * (discriminated union member alongside `MagiCapOverride`).
 *
 * A child that inherits an active MAGI cap from a parent can turn it off for
 * itself by storing this sentinel. Because per-key resolution is
 * first-ancestor-wins, the child's `{ disabled: true }` shadows the parent's
 * cap. Every read site coerces the sentinel to "no cap" (see
 * `isMagiCapDisabled`); the drawdown engine never sees it.
 *
 * Additive (no schemaVersion bump): existing data never carries this shape,
 * and no payload validator rejects unknown union members.
 */
export interface MagiCapDisabled {
  disabled: true;
}

/** Type guard: `true` when a resolved `magiCap` is the explicit-disable
 *  sentinel (`{ disabled: true }`) rather than a real cap. Read sites use
 *  this to coerce the sentinel to "no cap" before it reaches the engine. */
export function isMagiCapDisabled(
  v: MagiCapOverride | MagiCapDisabled | undefined,
): v is MagiCapDisabled {
  return v !== undefined && 'disabled' in v;
}

/**
 * ACA benchmark SLCSP override for a single calendar year.
 * When present, overrides the engine's age-based formula for that year.
 *
 * This SAME field is the annual SLCSP override the month-aware health engine
 * reuses (`roughHouseholdAnnualBenchmarkCents` takes it verbatim). No separate
 * benchmark field is added — a user override of the household's annual SLCSP
 * lives here, keyed by tax year.
 */
interface AcaPtcBenchmarkOverride {
  /** Tax year this override applies to. */
  taxYear: number;
  /**
   * WHOLE-YEAR benchmark SLCSP premium for the household, in dollars (not
   * cents) — the "Benchmark plan cost for the year" the editor collects.
   *
   * §36B(b)(2) sums the credit over Marketplace COVERAGE MONTHS, so the
   * integration layer prorates this figure to the household's covered months
   * (`overrideBenchmarkCentsForCoverageMonths`) before pricing. That is the
   * identity for a full covered year; storing a part-year figure here would be
   * charged twice.
   */
  annualSlcspDollars: number;
}

/**
 * One household member's Medicare / Marketplace coverage MONTHS for one tax year.
 * Each field is a whole month count 0..12; Part B
 * and Part D are INDEPENDENT (a member may enroll in one and not the other, or
 * start each in a different month during a mid-year ACA→Medicare transition).
 * Every field is sparse-optional — an absent field means "use the operational
 * default" (see `HealthCoverageMonthsOverride` precedence), never zero.
 */
export interface MemberCoverageMonths {
  /** Medicare Part B enrollment months this year (0..12). */
  partBMonths?: number;
  /** Medicare Part D enrollment months this year (0..12). */
  partDMonths?: number;
  /** ACA Marketplace coverage months this year (0..12). */
  marketplaceMonths?: number;
}

/**
 * Per-member, per-year Medicare/Marketplace coverage months.
 * `perMember` is keyed by household member id (the same ids as
 * `acaMarketplaceOptOutMemberIds`), then by tax year → month counts. Sparse at
 * every level: a member/year with no entry uses the operational default.
 *
 * PRECEDENCE with `acaMarketplaceOptOutMemberIds` (the existing whole-year
 * opt-out list) — the contract the health engine applies:
 *  - An EXPLICIT `marketplaceMonths` for a member/year WINS, even for a member
 *    on the opt-out list (the user has stated exactly how many months apply).
 *  - When `marketplaceMonths` is ABSENT for a member on the opt-out list → that
 *    member resolves to ZERO Marketplace months (the pre-existing opt-out is
 *    preserved — it is never silently reverted to full coverage just because
 *    these newer fields exist but are empty for that member).
 *  - When `marketplaceMonths` is ABSENT for a member NOT opted out → the
 *    AUTOMATIC count: the COMPLEMENT of that member's Medicare entitlement
 *    months for a retired, age-known member, labeled and user-editable.
 * Medicare Part B/D months absent → the AUTOMATIC entitlement count: enrollment
 * from the month the member turns 65 (the month BEFORE for a first-of-the-month
 * birthday), so the turning-65 year carries only that year's remaining months
 * and every later year carries 12. §36B(c)(2)(B) then caps Marketplace at
 * `12 − max(partB, partD, entitlement)`. This automatic derivation runs on BOTH
 * engines with no stored rows at all — it is not the retired whole-year
 * on/off rule.
 *
 * No schemaVersion bump — sparse-optional additions on `overrides` are
 * forward-compatible (exact precedent
 * `acaMarketplaceOptOutMemberIds`).
 */
export interface HealthCoverageMonthsOverride {
  perMember: Record<string, Record<number, MemberCoverageMonths>>;
}

/**
 * Per-scenario post-retirement asset-allocation override (the "growth
 * vs income" glide). When this section is present, a growth share is worked
 * out for each calendar year of retirement (linear glide between
 * `startGrowthPct` and `endGrowthPct` over `glideStartYear → endYear`, with an
 * optional `incomeOnlyYear` cutoff) and applied to EACH account separately.
 * There is no pooled growth or income bucket and no income-first withdrawal
 * order: withdrawals still follow the scenario's per-account strategy.
 *   - Deterministic projection: every account except a Cash Balance Pension
 *     (which keeps its own scalar rate) grows at the blend
 *     `share·growthRatePct + (1−share)·incomeRatePct` for that year
 *     (`balance-projection-runner-context.ts`, `allocation-glide.ts`).
 *   - Monte Carlo: the share sets each account's per-step stocks/bonds/cash mix
 *     (the non-stock part is split by the account's own bonds:cash ratio), and
 *     sampled historical returns are applied to that mix, so the two rates
 *     below are not used
 *     (`monte-carlo-glide.ts`, `balance-projection-runner-mc-glide.ts`).
 *
 * Field semantics:
 *   - `growthRatePct` / `incomeRatePct` — annual return rates for the
 *     growth and income sides of the blend (e.g. 7.0 / 3.0).
 *     Forward-looking, scenario-level; not tied to historical TWR
 *     per-account rates. Used by the deterministic projection only.
 *   - `startGrowthPct` — initial growth allocation at retirement
 *     (0..100). Income share = 100 − this.
 *   - `endGrowthPct` — target growth allocation at `endYear`. `null`
 *     means "no glide" (allocation stays flat at `startGrowthPct`
 *     through end-of-life). Must be paired with `endYear`.
 *   - `endYear` — calendar year by which `endGrowthPct` should be
 *     reached. Caller computes from primary's birth year + the user's
 *     entered "end age" (the engine stays pure / member-agnostic).
 *     `null` ↔ `endGrowthPct` null (paired). Years past `endYear`
 *     stay at `endGrowthPct`.
 *
 * Absence of this section ↔ each account grows at its own scalar rate
 * (deterministic) or its own asset mix (Monte Carlo), unchanged over time.
 */
export interface RetirementAllocationOverride {
  growthRatePct: number;
  incomeRatePct: number;
  startGrowthPct: number;
  endGrowthPct: number | null;
  endYear: number | null;
  /** Calendar year at which the glide BEGINS (allocation stays flat at
   *  `startGrowthPct` from retirementYear up through this year, then
   *  interpolates linearly toward `endGrowthPct` at `endYear`). User
   *  enters this in the modal as "Start glide after N years into
   *  retirement"; the modal converts via `glideStartYear =
   *  retirementYear + N`. Optional / omitted ↔ start at retirement
   *  (offset 0). Only meaningful when `endGrowthPct` and `endYear`
   *  are both set; ignored on flat allocations. */
  glideStartYear?: number | null;
  /** Optional hard cutoff. Calendar year at which the growth share is
   *  forced to 0% — from this year forward the allocation is 100%
   *  income regardless of where the natural glide left off. User
   *  enters this in the modal as "100% income at \<primary\>'s age N";
   *  the modal converts via `incomeOnlyYear = primaryBirthYear + N`.
   *  Optional / null ↔ no hard cutoff (the natural glide / flat
   *  allocation continues forever). When set with a glide, applies
   *  AFTER the glide's natural endpoint — so a glide that lands at
   *  30% growth at age 75 stays at 30% until `incomeOnlyYear`, then
   *  snaps to 0%. When set without a glide, the allocation is flat at
   *  `startGrowthPct` until this year, then 0%. Validated to be >
   *  retirement year (and > `endYear` when a glide is set). */
  incomeOnlyYear?: number | null;
}

/**
 * Filing-status override per scenario. Sparse-optional — absent means
 * derive from projection-year alive-state (MFJ when both household members
 * are alive, Single otherwise; surviving-spouse year-of-death+1 → Single,
 * tax-conservative). HoH is override-only; no automatic HoH detection
 * (household model lacks child/dependent tracking).
 *
 * No schemaVersion bump: sparse-optional additions on `overrides` are
 * forward-compatible.
 */

/**
 * One Qualified Charitable Distribution (QCD) directive on a scenario.
 *
 * A member aged 70½+ directs a fixed REAL annual dollar amount from a single
 * designated traditional IRA (`RETIREMENT_IRA` + `PRE_TAX`) straight to charity.
 * The gift counts toward that owner's IRA-pool RMD and is excluded from taxable
 * income / MAGI, leaving the portfolio exactly once (it does NOT fund household
 * spending). One member may carry multiple entries; the indexed per-person
 * exclusion limit (§408(d)(8)) is consumed once across all of that member's
 * entries per owner-year.
 *
 * `start`/`end` reuse the EXACT `age` / `year` anchor shapes used by
 * `preRetirementRothConversions` (an older client seeing an unknown future kind
 * ignores the entry). A single-year "give $X in year Y" is a one-year-window
 * entry; "$10k/year" is a multi-year window.
 *
 * Sparse-optional on `ScenarioOverrides` (see `qualifiedCharitableDistributions`)
 * — absent → no QCD. Resolved + HARDENED by `resolveQcdForScenario`
 * (scenario-resolution.ts): dangling / cross-owner ids dropped, non-PRE_TAX-IRA
 * sources dropped, non-finite / negative amounts dropped, `start` clamped up to
 * the 70½ first-eligible tax year.
 */
export interface QcdEntry {
  /** Household member id (the account `ownerId`) directing this gift. */
  readonly memberId: string;
  /** Source account id — MUST resolve to a `RETIREMENT_IRA` + `PRE_TAX`
   *  account owned by `memberId`. */
  readonly sourceAccountId: string;
  /** Fixed REAL (today's-dollars) annual QCD amount; inflated to nominal each
   *  projection year before the cap comparison. Finite, ≥ 0. */
  readonly annualAmountDollars: number;
  /** When the QCD window turns on (inclusive). Restricted to `age` / `year`. */
  readonly start: Extract<MagiCapWindow['start'], { kind: 'age' | 'year' }>;
  /** When the QCD window turns off (exclusive). Restricted to `age` / `year`. */
  readonly end: Extract<MagiCapWindow['end'], { kind: 'age' | 'year' }>;
}

export interface ScenarioOverrides {
  retirementAge?: RetirementAgeOverride;
  socialSecurity?: SocialSecurityOverride;
  /** Federal filing status for this scenario (legacy scalar). Absent → derive
   *  from household composition. Transition-UNSAFE: a stored `MFJ` survives a
   *  spouse's death and keeps filing jointly forever. Retained
   *  alongside `taxFilingPlan`; the scenario filing editor's save path OMITS
   *  this key the first time the user stores a plan (a key omission, never a
   *  stored null). See `apps/web/src/lib/filing-status.ts`. */
  filingStatus?: FilingStatusOverride;
  /**
   * Scenario-level tax filing plan — the transition-SAFE
   * successor to the scalar `filingStatus` above. A discriminated union
   * (`individual` | `joint` | `separate`) expressive enough to represent: joint
   * filing while both spouses are alive; separate tax units each with their own
   * filing status and tax-household size; death-year joint treatment; the
   * post-death `Single` default; and user-entered, year-bounded `QSS`/`HoH`
   * exception windows.
   *
   * Sparse-optional: absent → the resolver derives a filing-plan view from the
   * legacy scalar `filingStatus` (via the documented scalar × household-
   * cardinality matrix) or from household composition when neither is set. When
   * present it supersedes the scalar. No schemaVersion bump — sparse-optional
   * `overrides` addition, forward-compatible
   * (exact precedent `acaMarketplaceOptOutMemberIds`). Resolved per projection
   * year by `resolveFilingPlanForYear` (../../lib/filing-status).
   * Both engines resolve every projection year through it,
   * and the scenario filing editor's save path materializes it. The
   * type lives in `filing-status.ts` (co-located with the resolver and
   * `FilingStatusOverride`) to avoid a type-only import cycle with this module.
   */
  taxFilingPlan?: TaxFilingPlan;
  contributions?: ContributionsOverride;
  lifeExpectancy?: LifeExpectancyOverride;
  inflation?: InflationOverride;
  discretionarySpending?: DiscretionarySpendingOverride;
  /**
   * Downturn (risk-based) spending guardrails — a Monte-Carlo-only dynamic-
   * spending rule that cuts spending in bad markets and raises it in good ones
   * off the funded ratio. Sparse-optional: absent → no guardrail (disabled).
   * `enabled: false` is also inert. No schemaVersion bump — sparse-optional
   * additions on `overrides` are forward-compatible
   * (exact precedent `acaMarketplaceOptOutMemberIds`). Resolved
   * first-ancestor-wins by `resolveDownturnGuardrailsForScenario`. See
   * `DownturnGuardrailsOverride`.
   */
  downturnGuardrails?: DownturnGuardrailsOverride;
  expenses?: ExpensesOverride;
  income?: IncomeOverride;
  withdrawalStrategy?: WithdrawalStrategy;
  /**
   * Custom per-account drawdown sequence. Only meaningful when
   * `withdrawalStrategy.kind === 'customOrder'`; ignored otherwise.
   */
  customDrawdownOrder?: CustomDrawdownOrder;
  /**
   * MAGI cap overlay for ACA-subsidy management. Valid with any named
   * withdrawal strategy.
   *
   * The `MagiCapDisabled` sentinel (`{ disabled: true }`) is an additive
   * union member that lets a child scenario explicitly turn off an
   * inherited cap; read sites coerce it to "no cap" via `isMagiCapDisabled`.
   */
  magiCap?: MagiCapOverride | MagiCapDisabled;
  retirementAllocation?: RetirementAllocationOverride;
  /**
   * Fraction of a POST_TAX (non-Roth) withdrawal assumed to be long-term
   * gain / qualified dividend for LTCG tax purposes. 0..1; defaults
   * to 0.5 when absent. E.g. 0.5 means 50% of the taxable withdrawal is
   * treated as LTCG/QDI, 50% as return of cost basis (untaxed).
   */
  assumedCostBasisFractionOfTaxableWithdrawal?: number;
  /**
   * MAGI bootstrap lookback for projection YEAR 0. IRMAA looks back
   * two years, so projection year 0 reads the MAGI from two years before
   * retirement: `MAGI(ret−2)`. In whole dollars. When absent, IRMAA is skipped
   * for year 0 unless the engine estimates it from the projected first-year
   * MAGI (deterministic engine only). Split from the former single
   * `magiBootstrapForFirstTwoYears` (scenario schemaVersion 2→3).
   */
  magiBootstrapLookbackMinus2?: number;
  /**
   * MAGI bootstrap lookback for projection YEAR 1: the MAGI from one
   * year before retirement, `MAGI(ret−1)`. In whole dollars. When absent, IRMAA
   * is skipped for year 1 unless the engine estimates it. Split from the
   * former single `magiBootstrapForFirstTwoYears` (scenario schemaVersion 2→3).
   */
  magiBootstrapLookbackMinus1?: number;
  /**
   * Per-year ACA benchmark SLCSP overrides. Keyed by tax year; absent
   * years fall back to the engine's age-based formula. Sparse array —
   * only years needing override need entries.
   */
  acaPtcBenchmark?: AcaPtcBenchmarkOverride[];
  // Per-account CBP payout elections used to live here as
  // `cashBalancePayouts`. The remodel moves the election
  // onto the linked IncomeStream via `linkedCbpAccountId`. No
  // migration is shipped — pre-remodel exports still parse (the field
  // is just ignored by the new code); re-configure CBP elections via
  // the Income form's "Linked CBP account" dropdown.
  /**
   * Per-scenario per-account override of `plannedContributionPreTax`
   * and `plannedContributionPostTax`. Sparse — only carries entries
   * for explicitly overridden accounts. Read via
   * `resolveAccountContributionsForScenario`.
   */
  accountContributions?: AccountContributionsOverride;
  /**
   * Per-scenario per-account override of `planningReturnPct`. Sparse
   * — only carries entries for explicitly overridden accounts. Affects
   * the Planned projection method only (TWR is empirical).
   * Read via `resolveAccountReturnsForScenario`.
   */
  accountReturns?: AccountReturnsOverride;
  /**
   * Per-scenario per-account override of `assetMix`. Sparse — only
   * carries entries for explicitly overridden accounts. Affects the
   * Monte Carlo projection only. Read via
   * `resolveAccountAssetMixForScenario`.
   */
  accountAssetMix?: AccountAssetMixOverride;
  /**
   * Per-scenario per-account minimum-balance floor.
   * Sparse — only carries entries for accounts the scenario explicitly floors.
   * Floor-eligible accounts (`taxTreatment ∈ {POST_TAX, HSA}`) are never
   * drawn below their floor for discretionary withdrawals. NOMINAL dollars (
   * no inflation adjustment). Read + SANITISED by
   * `resolveAccountFloorsForScenario` (the sole engine-side consumer; CWE-20
   * boundary — non-finite/negative floor → no floor, non-`'strict'` hsaMode →
   * `'emergencyOnly'`). schemaVersion bumped (v7→v8, identity migration) so
   * a down-version client rejects a floored scenario via the schema-ahead guard
   * rather than mis-resolving it (a floor is wrong-number-class, not
   * safe-degrade). Floors apply to every named withdrawal strategy.
   */
  accountFloors?: AccountFloorsOverride;
  /**
   * Scenario-level assumption: what percentage (0–100) of EMERGENCY HSA
   * withdrawals is assumed to go toward qualified medical expenses. This
   * applies only to the emergency-reserve pass; modeled medical-qualified
   * withdrawals are always 100% qualified. Qualified emergency withdrawals
   * are tax-free; the remaining nonqualified fraction is taxed as ordinary
   * income and, before age 65, carries the 20% HSA additional tax.
   * Sparse-optional: absent → treated as 100 (fully qualified, the tax-free
   * default). No schemaVersion bump — sparse-optional additions on
   * `overrides` are forward-compatible.
   */
  hsaQualifiedMedicalExpensePct?: number;
  /**
   * Scenario-level assumption: account ids exempt from the early-withdrawal
   * additional tax (IRA/401k-style 10% before 59.5; HSA 20% before 65). Lets
   * the user mark accounts they know qualify for an exception the app does
   * not individually model (SEPP/72(t), disability, etc.). Sparse-optional:
   * absent → treated as `[]` (no accounts exempt). No schemaVersion bump —
   * sparse-optional additions on `overrides` are forward-compatible.
   */
  earlyWithdrawalPenaltyExemptAccountIds?: string[];
  /**
   * Scenario-level assumption: household member ids treated as NOT on the ACA
   * Marketplace, so no ACA premium-tax-credit subsidy is credited for their
   * pre-65 retirement years. Lets the user model a member who actually has
   * retiree / COBRA / spousal-employer coverage rather than buying a Marketplace
   * plan. The premium-subsidy benchmark (and the household covered-count it
   * scales by) narrows to the remaining on-Marketplace members. Sparse-optional:
   * absent → treated as `[]` (every retired pre-65 member stays on the
   * Marketplace = current behavior). No schemaVersion bump — sparse-optional
   * additions on `overrides` are forward-compatible
   * (exact precedent `earlyWithdrawalPenaltyExemptAccountIds`).
   */
  acaMarketplaceOptOutMemberIds?: readonly string[];
  /**
   * Per-member, per-year Medicare Part B / Part D and ACA Marketplace coverage
   * MONTHS. Lets the projection charge IRMAA only for
   * the months a member is actually enrolled in each part (separately for Part B
   * and Part D), and price the ACA subsidy against the member's actual
   * Marketplace months — instead of the whole-year on/off shortcut. Sparse-
   * optional; keyed by member id then tax year. PRECEDENCE with
   * `acaMarketplaceOptOutMemberIds`: an explicit `marketplaceMonths` wins even
   * for an opted-out member; absent + opted-out → 0 Marketplace months (the
   * opt-out is preserved); absent + not opted-out → the AUTOMATIC birthday-month
   * count (`resolveMemberHealthCoverage`): Medicare entitlement from the month
   * the member turns 65 — the month before for a first-of-the-month birthday —
   * with Marketplace months as its complement, NOT the retired
   * whole-year on/off rule. No schemaVersion bump — forward-compatible. See
   * `HealthCoverageMonthsOverride`.
   */
  healthCoverageMonths?: HealthCoverageMonthsOverride;
  /**
   * Federal-poverty-level region for the ACA subsidy:
   * `'contiguous'` (48 states + DC), `'alaska'`, or `'hawaii'`. Selects which
   * HHS poverty-guideline schedule the FPL denominator uses (Alaska/Hawaii have
   * higher poverty lines). Sparse-optional: absent → `'contiguous'` (the current
   * implicit default; every existing scenario is unchanged). No schemaVersion
   * bump — forward-compatible.
   */
  acaFplRegion?: AcaFplRegion;
  /**
   * Working-years (still-employed) Roth conversions: a sparse list
   * of entries, each moving the FULL pre-tax → Roth-IRA amount per working year
   * of its window, in the DETERMINISTIC projection only (Monte Carlo untouched).
   * Each entry names one pre-tax `sourceAccountId`, one
   * `targetRothAccountId` (MUST resolve to a `RETIREMENT_ROTH_IRA`, the
   * §408A double-tax guard), an `annualAmountDollars`, and a `start`/`end`
   * working-year window reusing the EXACT `MagiCapWindow` anchor shapes
   * (`age` / `year` only — an older client seeing an unknown future kind ignores
   * the entry). A single-year "convert $X in year Y" is a one-year-window entry;
   * "$10k/year" is a multi-year window (one shape covers both). The
   * displayed additional tax burden uses `preRetirementRothConversionTaxRatePct`
   * and is NEVER deducted from the projection. The `annualAmountDollars`
   * is always a flat nominal figure — the typed dollars are converted as-is each
   * working year (no inflation growth).
   *
   * Sparse-optional: absent → no conversions. No schemaVersion bump — sparse-
   * optional additions on `overrides` are forward-compatible (exact precedent `acaMarketplaceOptOutMemberIds`).
   * Resolved + HARDENED by `resolvePreRetirementRothConversions`
   * (scenario-resolution.ts): non-finite amounts rejected, amount clamped ≥ 0,
   * dangling/cross-household source-or-target ids dropped, non-pre-tax source or
   * non-Roth-IRA target dropped (no-op, never error).
   */
  preRetirementRothConversions?: ReadonlyArray<{
    readonly sourceAccountId: string;
    readonly targetRothAccountId: string;
    readonly annualAmountDollars: number;
    readonly start: Extract<MagiCapWindow['start'], { kind: 'age' | 'year' }>;
    readonly end: Extract<MagiCapWindow['end'], { kind: 'age' | 'year' }>;
  }>;
  /**
   * Scenario-level assumed marginal tax rate (percent) used ONLY to compute the
   * DISPLAYED additional tax burden of the working-years Roth conversions
   * — `burden = converted × rate`. Display-only: never deducted from
   * any modeled account. Resolved + clamped to `[0, 100]`. Absent → 0 (no
   * displayed burden). Sparse-optional, no schemaVersion bump.
   */
  preRetirementRothConversionTaxRatePct?: number;
  /**
   * Working-years total taxable income (post-standard-deduction whole dollars)
   * used ONLY by the Roth conversion comparison page to size pre-retirement
   * bracket headroom: `headroom = max(0, nextBracketCeiling − this −
   * existingAnnualConversionAmount)`. Already taxable income (NOT MAGI / gross),
   * so no deduction is re-subtracted. Drives no projection math — the BETR page
   * reads it via the existing scenario aggregate; absent → the page shows a
   * needs-input state (not 0 headroom). Sparse-optional, no schemaVersion bump
   * (same precedent as `preRetirementRothConversions`).
   */
  preRetirementTaxableIncomeDollars?: number;
  /**
   * Qualified Charitable Distributions (QCDs): a sparse list of per-member
   * directives, each giving a fixed REAL annual amount directly from a
   * designated traditional IRA (`RETIREMENT_IRA` + `PRE_TAX`) to charity once
   * the member reaches the precise 70½ first-eligible tax year. The gift
   * counts toward that owner's IRA-pool RMD and is excluded from taxable income
   * / MAGI, leaving the portfolio exactly once.
   *
   * Sparse-optional: absent → no QCD. No schemaVersion bump — sparse-optional
   * additions on `overrides` are forward-compatible
   * (exact precedent `acaMarketplaceOptOutMemberIds`). Resolved + HARDENED by
   * `resolveQcdForScenario` (scenario-resolution.ts): dangling / cross-owner ids
   * dropped, non-PRE_TAX-IRA sources dropped, non-finite / negative amounts
   * dropped, `start` clamped up to the 70½ floor — all no-op, never error. See
   * `QcdEntry`.
   */
  qualifiedCharitableDistributions?: readonly QcdEntry[];
}
