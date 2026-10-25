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

/** Per-account ledger entry for the MC runner's sampling; annuity-elected CBPs are excluded upstream. */
export interface AccountMcLedgerEntry {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly contribPre: Float64Array;
  readonly contribPost: Float64Array;
  /** `'fixed'` bakes the growth into the series; `'tracks-inflation'` leaves a today's-dollars base the runner scales by `cumCpi[i]` (routed event dollars are nominal and unscaled). */
  readonly contribGrowthMode: ResolvedContributionGrowth['mode'];
  readonly deposit: Float64Array;
  /** Pre-tax slice of post-primary spouse contributions; no engine path reads it. */
  readonly depositPre: Float64Array;
  /** Designated-Roth slice of post-primary spouse contributions, routed to `post` by the named-strategy drawdown only; a MIXED account's Roth slice stays RMD-exempt (SECURE 2.0 §325). */
  readonly depositPost: Float64Array;
  readonly assetMix: AssetMix | null;
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
  readonly cbpPlanningReturnPct: number | null;
  readonly taxTreatment: AccountTaxTreatment;
  readonly accountType: AccountType;
  readonly ownerId: string;
  /** Planned-only post-tax base (today's dollars) taken before events route onto `contribPost`; non-null only for tracks-inflation, so the runner CPI-scales just the planned part. */
  readonly plannedContribPostBase: Float64Array | null;
  /** Minimum-balance floor in dollars, sanitised and enforced per MC path. */
  readonly floorDollars?: number;
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/** Builds a ledger entry: initial buckets split by tax treatment, with zeroed arrays for event routing to fill. */
export function buildLedgerEntry(args: {
  account: Aggregate<AccountPayload>;
  latestBalance: number;
  latestBalancePreTax?: number | null;
  latestBalancePostTax?: number | null;
  stepCount: number;
  retirementStepIdx: number;
  cbpPlanningReturnPct: number | null;
  assetMixSeries?: ReadonlyArray<AssetMix> | null;
  contributionGrowth?: ResolvedContributionGrowth;
  firstYear: number;
  todayMonthIndex?: number;
  floor?: { floorDollars: number; hsaMode: 'emergencyOnly' | 'strict' };
}): AccountMcLedgerEntry {
  const { account, latestBalance, stepCount, retirementStepIdx } = args;
  const { initialPre, initialPost } = splitInitialByTaxTreatment(
    latestBalance,
    account.payload.taxTreatment,
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
  // HSA is entered pre-tax but grows in the post bucket, as in the deterministic `computePerMonthContribution`.
  const preMonthly =
    account.payload.taxTreatment === 'HSA'
      ? 0
      : account.payload.plannedContributionPreTax / 12;
  const postMonthly =
    (account.payload.taxTreatment === 'HSA'
      ? account.payload.plannedContributionPreTax
      : account.payload.plannedContributionPostTax) / 12;
  // Fixed growth is baked month-precise from the today anchor to match the deterministic engine; tracks-inflation keeps a flat base the runner scales per path.
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
