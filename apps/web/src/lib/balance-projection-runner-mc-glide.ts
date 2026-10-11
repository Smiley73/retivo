/**
 * Per-account glide-derivation helpers for the MC bundle assembler.
 * Extracted from `balance-projection-runner-mc.ts` to keep that file
 * within the ≤400-line shape cap.
 */
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

/**
 * Derive the per-step asset-mix series for one account. Returns `null`
 * when no `retirementAllocation` override is set or the account is CBP.
 *
 * `retirementStepIdx` uses the month-precise
 * kernel convention — `Math.max(0, (retirementYear - todayYear) * 12 +
 * primaryRetirementMonth0)` — so `assetMixSeries[retirementStepIdx]` is the
 * FIRST drawdown step, aligning step-for-step with `buildStepInputs`.
 *
 * `primaryRetirementYear` is the actual calendar retirement year.
 * For already-retired households `retirementStepIdx` is clamped to 0,
 * so a `firstYear + floor(retirementStepIdx/12)` derivation would
 * collapse to `firstYear` — threading the real year avoids that.
 */
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
  /** Actual calendar retirement year of the primary member. Separate from
   *  `retirementStepIdx` because for already-retired households the step
   *  is clamped to 0 — threading the real year keeps the glide baseline
   *  anchored to the user's past retirement year, not today. */
  readonly primaryRetirementYear: number;
  readonly balancesByAccount: Map<string, ReadonlyArray<Aggregate<AccountBalancePayload>>>;
}

/**
 * Build the effective `AccountPayload` aggregate for one projection entry:
 * zeroes contributions when stopped and applies any per-account mix override.
 * Extracted from `buildAccountBundleItem` to keep that fn ≤40 lines.
 */
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

/**
 * Build one `AccountBundleItem` from a single `AccountProjection` entry.
 * Extracted so the `.map` call-site in `buildAccountBundles` is one
 * expression and the outer function stays ≤40 lines.
 */
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
