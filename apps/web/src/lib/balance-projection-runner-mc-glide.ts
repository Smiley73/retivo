/** Per-account glide-derivation helpers for the MC bundle assembler. */
import {
  defaultAssetMixForAccountType,
  type AccountPayload,
  type AccountBalancePayload,
  type Aggregate,
  type AssetMix,
  type RetirementAllocationOverride,
} from '../db/types';
import type { AccountProjection } from './balance-projection-runner-types';
import { buildGlideAssetMixSeries } from './monte-carlo-glide';

/** Shape of one per-account bundle entry returned by `buildAccountBundleItem`. */
export interface AccountBundleItem {
  readonly account: Aggregate<AccountPayload>;
  readonly latestBalance: number;
  readonly latestBalancePreTax: number | null;
  readonly latestBalancePostTax: number | null;
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
}

// `retirementStepIdx` is month-precise, so `assetMixSeries[retirementStepIdx]` is the first drawdown step;
// the real retirement year is passed because the index clamps to 0 for retired households.
function deriveAssetMixSeriesForAccount(
  effectiveAccount: Aggregate<AccountPayload>,
  retirementAllocation: RetirementAllocationOverride | null,
  retirementStepIdx: number,
  stepCount: number,
  todayYear: number,
  primaryRetirementYear: number,
): ReadonlyArray<AssetMix> | null {
  if (
    retirementAllocation === null ||
    effectiveAccount.payload.type === 'RETIREMENT_CASH_BALANCE'
  ) {
    return null;
  }
  const baseAssetMix =
    effectiveAccount.payload.assetMix ??
    defaultAssetMixForAccountType(effectiveAccount.payload.type);
  return buildGlideAssetMixSeries({
    baseAssetMix,
    allocation: retirementAllocation,
    retirementStepIdx,
    stepCount,
    firstYear: todayYear,
    retirementYear: primaryRetirementYear,
  });
}

/** Context values the per-account item builder needs from `buildAccountBundles`. */
export interface AccountBundleItemCtx {
  readonly stopContributionsToday: boolean;
  readonly assetMixOverrides: Map<string, AssetMix>;
  readonly retirementAllocation: RetirementAllocationOverride | null;
  readonly retirementStepIdx: number;
  readonly stepCount: number;
  readonly todayYear: number;
  /**
   * Calendar retirement year of the primary member; `retirementStepIdx` clamps to 0 for already-retired
   * households.
   */
  readonly primaryRetirementYear: number;
  readonly balancesByAccount: Map<string, ReadonlyArray<Aggregate<AccountBalancePayload>>>;
}

function buildEffectiveAccount(
  p: AccountProjection,
  ctx: Pick<AccountBundleItemCtx, 'stopContributionsToday' | 'assetMixOverrides'>,
): Aggregate<AccountPayload> {
  const mix = ctx.assetMixOverrides.get(p.account.id);
  const plannedPre = ctx.stopContributionsToday
    ? 0
    : p.account.payload.plannedContributionPreTax;
  const plannedPost = ctx.stopContributionsToday
    ? 0
    : p.account.payload.plannedContributionPostTax;
  return {
    ...p.account,
    payload: {
      ...p.account.payload,
      plannedContributionPreTax: plannedPre,
      plannedContributionPostTax: plannedPost,
      assetMix: mix ?? p.account.payload.assetMix,
    },
  };
}

/** Builds one `AccountBundleItem` from a single `AccountProjection` entry. */
export function buildAccountBundleItem(
  p: AccountProjection,
  ctx: AccountBundleItemCtx,
): AccountBundleItem {
  const effectiveAccount = buildEffectiveAccount(p, ctx);
  const assetMixSeries = deriveAssetMixSeriesForAccount(
    effectiveAccount,
    ctx.retirementAllocation,
    ctx.retirementStepIdx,
    ctx.stepCount,
    ctx.todayYear,
    ctx.primaryRetirementYear,
  );
  const accountBalances = ctx.balancesByAccount.get(p.account.id) ?? [];
  const latest =
    accountBalances.length > 0
      ? accountBalances.reduce((best, r) =>
          r.payload.year > best.payload.year ? r : best,
        )
      : null;
  return {
    account: effectiveAccount,
    latestBalance: p.latestBalance,
    latestBalancePreTax: latest?.payload.endingBalancePreTax ?? null,
    latestBalancePostTax: latest?.payload.endingBalancePostTax ?? null,
    assetMixSeries,
  };
}
