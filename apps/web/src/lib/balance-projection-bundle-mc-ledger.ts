/**
 * MC per-account ledger construction — the `AccountMcLedgerEntry` type +
 * per-entry builders extracted from `balance-projection-bundle.ts` to keep
 * that file under the 800-line limit. Behaviour is identical to the inline
 * original; `balance-projection-bundle.ts` re-imports `buildLedgerEntry` and
 * re-exports the type so its public API is unchanged.
 */
import {
  defaultAssetMixForAccountType,
  type AssetMix,
  type AccountPayload,
  type AccountType,
  type AccountTaxTreatment,
  type Aggregate,
} from '../db/types';
import { splitInitialByTaxTreatment } from './tax-treatment-split';
import { contributionGrowthFactor } from './contribution-growth';
import type { ResolvedContributionGrowth } from './scenario-resolution';

/**
 * Per-account ledger entry consumed by the MC runner (per-account
 * sampling). One entry per active account that enters the MC simulation;
 * annuity-elected CBP accounts are excluded upstream.
 *
 * Each step the MC runner samples ONE historical
 * `(stockPct, bondPct, cashPct, cpiPct)` tuple per path and applies
 * it to each non-CBP account's `assetMix` to compute that account's
 * monthly return. CBP accounts (non-annuity-elected, `cbpPlanningReturnPct`
 * non-null) ignore the sampled tuple and use the monthly equivalent of
 * `cbpPlanningReturnPct` instead.
 *
 * Contribution / deposit arrays are pre-allocated to the simulation step
 * count by the runner; values outside the relevant phase are zero.
 */
export interface AccountMcLedgerEntry {
  /** Stable account id (for correlation + targeted-event routing). */
  readonly id: string;
  /** Pre-tax bucket at `firstYear` step 0 (today). */
  readonly initialPre: number;
  /** Post-tax bucket at `firstYear` step 0 (today). */
  readonly initialPost: number;
  /** Per-step planned pre-tax contribution dollars (zero post-retirement).
   *  For a `'fixed'`-growth account the explicit fixed-nominal series is
   *  ALREADY baked here (today-anchored). For a `'tracks-inflation'`
   *  account this is the TODAY'S-dollars base series; the MC runner scales
   *  it by each path's own cumulative CPI per step (per-path flat-real). */
  readonly contribPre: Float64Array;
  /** Per-step planned post-tax contribution dollars. Targeted one-offs
   *  / post-primary contributions / CBP lump-sums land here at their
   *  event step when `targetAccountId` matches. Same growth semantics as
   *  `contribPre` (see `contribGrowthMode`). */
  readonly contribPost: Float64Array;
  /** Contribution-growth mode for the PLANNED base contribution series
   *  `'fixed'` → the explicit-rate growth is baked into
   *  `contribPre`/`contribPost` at ledger-build time (no per-path
   *  scaling). `'tracks-inflation'` → the series is today's-dollars base;
   *  the MC runner multiplies it by the path's `cumCpi[i]` so the
   *  contribution holds its real value on every inflation path. Targeted
   *  event dollars routed onto these arrays AFTER ledger build are NOT
   *  CPI-scaled (they are explicit nominal amounts). */
  readonly contribGrowthMode: ResolvedContributionGrowth['mode'];
  /** Per-step drawdown deposit dollars (post-retirement targeted
   *  events that routed to this account). SUMMED across all sources
   *  (CBP / one-off / post-primary `pre + post`) — the no-ledger kernel
   *  path reads this slot and is unchanged by the post-primary split. */
  readonly deposit: Float64Array;
  /** Per-step post-retirement post-primary spouse contribution PRE-tax
   *  (pre-tax-designated) slice. Recorded for auditability; NO engine path
   *  reads this field directly — the named-strategy drawdown reconstructs
   *  the pre amount as `deposit − depositPost`. Zero unless a
   *  post-primary contribution targeted this account in the drawdown window. */
  readonly depositPre: Float64Array;
  /** Per-step post-retirement post-primary spouse contribution POST-tax
   *  (designated-Roth) slice. Routed to the account's `post` bucket by the
   *  named-strategy drawdown only (a MIXED account's Roth slice stays
   *  RMD-exempt, §325). Zero unless a post-primary contribution targeted
   *  this account in the drawdown window. */
  readonly depositPost: Float64Array;
  /** Asset mix used to convert the sampled tuple into this account's
   *  monthly return. `null` when this account is a non-annuity CBP
   *  ledger — the runner uses `cbpPlanningReturnPct` instead. */
  readonly assetMix: AssetMix | null;
  /** Per-step asset-mix series derived from a `retirementAllocation`
   *  glide override. When present, `buildPerAccountReturnSeries` applies
   *  `assetMixSeries[i]` at each step instead of the flat `assetMix`.
   *  `null` when no override is set (default path — uses `assetMix`). */
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
  /** Non-null when this account is a non-annuity-elected CBP — the MC
   *  runner uses the monthly equivalent of this rate as a constant
   *  return for the account, unaffected by sampling. `null` for non-CBP
   *  accounts (which read `assetMix`). */
  readonly cbpPlanningReturnPct: number | null;
  /** Account tax treatment — drives per-account MC withdrawal
   *  classification for the tax cashflow. Mirrors `AccountPayload.taxTreatment`. */
  readonly taxTreatment: AccountTaxTreatment;
  /** Account type — cash-like / brokerage split for the MC tax
   *  cashflow. Roth is routed by `taxTreatment === 'ROTH'` (treatment-based),
   *  not by this type. Mirrors `AccountPayload.type`. */
  readonly accountType: AccountType;
  /** Owning member id — carried for per-member tax routing parity with
   *  the deterministic pass. */
  readonly ownerId: string;
  /** The PLANNED-ONLY post-tax contribution base (today's dollars),
   *  captured at ledger-build time BEFORE any targeted event dollars are
   *  routed onto `contribPost`. Non-null only for `'tracks-inflation'`
   *  accounts — the MC runner uses it to CPI-scale exactly the planned
   *  portion of `contribPost` per path while leaving routed nominal event
   *  dollars untouched (`contribPost[i] = (base × cumCpi) + (contribPost −
   *  base)`). `null` for `'fixed'` accounts (growth already baked, no
   *  per-path scaling) — and `contribPre` is itself the planned base
   *  (no events route to it), so no separate pre-tax base array is kept. */
  readonly plannedContribPostBase: Float64Array | null;
  /** Per-account minimum-balance floor in
   *  DOLLARS, resolved + CWE-20 sanitised. The MC strategy path threads this
   *  into `DrawdownAccountInput.floorDollars` so per-path floor enforcement
   *  matches the deterministic engine. Eligibility (taxTreatment ∈ {POST_TAX,
   *  HSA}) is enforced at the engine boundary. Absent / undefined ⇒ no
   *  floor. Serialized into the MC cache key so a floored scenario auto-misses
   *  the cache. */
  readonly floorDollars?: number;
  /** HSA floor mode (`'emergencyOnly'` default |
   *  `'strict'`). Only meaningful on a floored HSA account. */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/**
 * Build a per-account MC ledger entry: initial pre/post buckets split by
 * tax treatment, zero contribution/deposit arrays (the factory and the
 * runner fill them via `routeEventsToLedger` / event routing). Mirrors
 * the deterministic-side `buildPerAccountDrawdownLedger` split.
 */
export function buildLedgerEntry(args: {
  account: Aggregate<AccountPayload>;
  latestBalance: number;
  latestBalancePreTax?: number | null;
  latestBalancePostTax?: number | null;
  stepCount: number;
  retirementStepIdx: number;
  cbpPlanningReturnPct: number | null;
  assetMixSeries?: ReadonlyArray<AssetMix> | null;
  /** Resolved contribution-growth mode + rate for this account.
   *  Omitted → tracks-inflation with no per-path scaling effect (a flat
   *  today's-dollars base) — back-compat for direct-bundle test callers
   *  that don't resolve growth. */
  contributionGrowth?: ResolvedContributionGrowth;
  /** Calendar year of MC step 0 (= MC `firstYear` = `todayYear`). */
  firstYear: number;
  /** Today's calendar month index (0 = Jan) — together with `firstYear`
   *  forms the today-anchor `asOfMonth` so the baked fixed-growth series
   *  matches the deterministic engine for the same calendar month. */
  todayMonthIndex?: number;
  /** The resolved per-account floor + HSA mode
   *  for this account. Undefined ⇒ no floor (the common case). */
  floor?: { floorDollars: number; hsaMode: 'emergencyOnly' | 'strict' };
}): AccountMcLedgerEntry {
  const { account, latestBalance, stepCount, retirementStepIdx } = args;
  const { initialPre, initialPost } = splitInitialByTaxTreatment(
    latestBalance,
    account.payload.taxTreatment,
    // Actual stored buckets so MIXED accounts honor their split
    // (non-MIXED treatments ignore the value).
    resolveMixedBuckets(args.latestBalancePreTax, args.latestBalancePostTax),
  );
  const growthMode = args.contributionGrowth?.mode ?? 'tracks-inflation';
  const { contribPre, contribPost } = buildPlannedContribSeries({
    account,
    stepCount,
    retirementStepIdx,
    growth: args.contributionGrowth,
    asOfMonth: args.firstYear * 12 + (args.todayMonthIndex ?? 0),
    firstYear: args.firstYear,
  });
  // Capture the planned-only post-tax base (today's dollars) BEFORE the
  // factory routes any targeted event dollars onto `contribPost`. Only
  // needed for tracks-inflation accounts (the MC runner CPI-scales the
  // planned portion per path).
  const plannedContribPostBase =
    growthMode === 'tracks-inflation' ? contribPost.slice() : null;
  const assetMix =
    args.cbpPlanningReturnPct === null
      ? account.payload.assetMix ??
        defaultAssetMixForAccountType(account.payload.type)
      : null;
  return {
    id: account.id,
    initialPre,
    initialPost,
    contribPre,
    contribPost,
    deposit: new Float64Array(stepCount),
    depositPre: new Float64Array(stepCount),
    depositPost: new Float64Array(stepCount),
    assetMix,
    assetMixSeries: args.assetMixSeries ?? null,
    cbpPlanningReturnPct: args.cbpPlanningReturnPct,
    // Per-account tax metadata for the MC tax cashflow routing.
    taxTreatment: account.payload.taxTreatment,
    accountType: account.payload.type,
    ownerId: account.payload.ownerId,
    contribGrowthMode: growthMode,
    plannedContribPostBase,
    // Carry the resolved per-account floor +
    // HSA mode so the MC strategy path enforces it per path (parity with the
    // deterministic engine). Only set when a real floor resolved.
    ...(args.floor !== undefined
      ? { floorDollars: args.floor.floorDollars, floorHsaMode: args.floor.hsaMode }
      : {}),
  };
}

function resolveMixedBuckets(
  preTax: number | null | undefined,
  postTax: number | null | undefined,
): { preTax: number; postTax: number } | null {
  if (preTax === null || preTax === undefined) return null;
  if (postTax === null || postTax === undefined) return null;
  return { preTax, postTax };
}

function buildPlannedContribSeries(args: {
  account: Aggregate<AccountPayload>;
  stepCount: number;
  retirementStepIdx: number;
  growth: ResolvedContributionGrowth | undefined;
  asOfMonth: number;
  firstYear: number;
}): { contribPre: Float64Array; contribPost: Float64Array } {
  const { account, stepCount, retirementStepIdx, growth, asOfMonth, firstYear } =
    args;
  const contribPre = new Float64Array(stepCount);
  const contribPost = new Float64Array(stepCount);
  // Planned contributions: /12 each month from step 0 through
  // `retirementStepIdx - 1`, attributed per account (the same `/12` split
  // the household-level series uses).
  // HSA is single-sided: the HSA contribution is entered pre-tax (payroll deduction) and
  // stored in `plannedContributionPreTax`, but grows in the tax-free (post)
  // bucket. So source the amount from the pre-tax field yet route it to the
  // post bucket; `plannedContributionPostTax` is unused for HSA — matching the
  // deterministic `computePerMonthContribution` / `contribAdds` routing.
  const preMonthly =
    account.payload.taxTreatment === 'HSA'
      ? 0
      : account.payload.plannedContributionPreTax / 12;
  const postMonthly =
    (account.payload.taxTreatment === 'HSA'
      ? account.payload.plannedContributionPreTax
      : account.payload.plannedContributionPostTax) / 12;
  // The configured figure is the today's-dollars base. For a `'fixed'`
  // account we bake the explicit-rate growth here, month-precise +
  // TODAY-anchored (`asOfMonth`) so it matches the deterministic engine
  // for the same calendar month (step 0 = January of `firstYear`). For a
  // `'tracks-inflation'` account we leave the flat base — the MC runner
  // scales it by each path's own `cumCpi[i]`. The helper returns factor 1
  // for the tracks-inflation case (its rate is informational for MC), so
  // the base stays flat here.
  const bakeFixedGrowth = growth?.mode === 'fixed';
  const fixedPct = bakeFixedGrowth ? growth.ratePct : 0;
  for (let i = 0; i < Math.min(retirementStepIdx, stepCount); i += 1) {
    const factor = bakeFixedGrowth
      ? contributionGrowthFactor(fixedPct, firstYear * 12 + i, asOfMonth)
      : 1;
    contribPre[i] = preMonthly * factor;
    contribPost[i] = postMonthly * factor;
  }
  return { contribPre, contribPost };
}
