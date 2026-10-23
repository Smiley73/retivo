/** Per-account MC ledger entry type and builders, split out of `balance-projection-bundle.ts`. */
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
 * Per-account ledger entry for the MC runner's per-account sampling (annuity-elected CBPs are
 * excluded upstream).
 */
export interface AccountMcLedgerEntry {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  /** Planned pre-tax contribution per step (zero post-retirement). */
  readonly contribPre: Float64Array;
  /** Planned post-tax contribution per step, plus targeted events routed here. */
  readonly contribPost: Float64Array;
  /**
   * `'fixed'` bakes the explicit growth into the series; `'tracks-inflation'` leaves a
   * today's-dollars
   * base the runner scales by `cumCpi[i]` (routed event dollars are nominal and unscaled).
   */
  readonly contribGrowthMode: ResolvedContributionGrowth['mode'];
  /** Drawdown deposit dollars per step (post-retirement targeted events), summed across sources. */
  readonly deposit: Float64Array;
  /**
   * Pre-tax slice of post-primary spouse contributions; no engine path reads it (derived as
   * `deposit − depositPost`).
   */
  readonly depositPre: Float64Array;
  /**
   * Designated-Roth slice of post-primary spouse contributions, routed to the `post` bucket by the
   * named-strategy drawdown only; a MIXED account's Roth slice stays RMD-exempt (SECURE 2.0 §325).
   */
  readonly depositPost: Float64Array;
  readonly assetMix: AssetMix | null;
  /** Per-step mix from a `retirementAllocation` glide, applied instead of `assetMix`. */
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
  /** Non-null for a non-annuity CBP: its monthly equivalent is a constant return, not sampled. */
  readonly cbpPlanningReturnPct: number | null;
  readonly taxTreatment: AccountTaxTreatment;
  /** Roth routes by `taxTreatment`, not this type. */
  readonly accountType: AccountType;
  readonly ownerId: string;
  /**
   * Planned-only post-tax base (today's dollars) taken before events are routed onto `contribPost`;
   * non-null only for tracks-inflation, so the runner CPI-scales just the planned part.
   */
  readonly plannedContribPostBase: Float64Array | null;
  /**
   * Minimum-balance floor in dollars, sanitised (CWE-20) and enforced per MC path; absent means
   * none.
   */
  readonly floorDollars?: number;
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/**
 * Build a ledger entry: initial buckets split by tax treatment, with zeroed arrays for event
 * routing to fill.
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
  /** Omitted means tracks-inflation with a flat base (direct-bundle test callers). */
  contributionGrowth?: ResolvedContributionGrowth;
  firstYear: number;
  /** Today's month (0 = Jan), anchoring baked fixed growth to the deterministic engine. */
  todayMonthIndex?: number;
  floor?: { floorDollars: number; hsaMode: 'emergencyOnly' | 'strict' };
}): AccountMcLedgerEntry {
  const { account, latestBalance, stepCount, retirementStepIdx } = args;
  const { initialPre, initialPost } = splitInitialByTaxTreatment(
    latestBalance,
    account.payload.taxTreatment,
    // Actual stored buckets so MIXED accounts honor their split.
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
  // Planned-only base, captured before event routing; only tracks-inflation accounts need it.
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
    taxTreatment: account.payload.taxTreatment,
    accountType: account.payload.type,
    ownerId: account.payload.ownerId,
    contribGrowthMode: growthMode,
    plannedContribPostBase,
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
  // Planned contributions run /12 per month from step 0 to retirement. HSA is entered pre-tax but
  // grows in the tax-free (post) bucket, so its amount comes from the pre-tax field and routes to
  // post, as in the deterministic `computePerMonthContribution`.
  const preMonthly =
    account.payload.taxTreatment === 'HSA'
      ? 0
      : account.payload.plannedContributionPreTax / 12;
  const postMonthly =
    (account.payload.taxTreatment === 'HSA'
      ? account.payload.plannedContributionPreTax
      : account.payload.plannedContributionPostTax) / 12;
  // Fixed growth is baked month-precise from the today anchor (`asOfMonth`) to match the
  // deterministic engine; tracks-inflation keeps a flat base the MC runner scales per path (the
  // helper returns factor 1 there).
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
