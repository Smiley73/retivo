/** Unit tests for `drawdown-engine-per-account-strategy-cap.ts`. */
import { describe, expect, it, vi } from 'vitest';
import {
  applyMonthlyDeposits,
  classifyCommittedYearDraw,
  classifyTrialYearDraw,
  distributeWithdrawalByCustomTiersWithCap,
  isMagiNeutralPostBucket,
  type TrialWithinYearInputs,
} from './drawdown-engine-per-account-strategy-cap';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';
import type { AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import type { MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy-helpers';

function makeState(overrides: Partial<AccountRunState>): AccountRunState {
  return {
    id: 'acct-1',
    pre: 0,
    post: 0,
    annualRatePct: 7,
    monthlyRate: 7 / 12,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_401K',
    deposits: new Float64Array(0),
    depositsPost: new Float64Array(0),
    ...overrides,
  };
}

function makeTrackers(n: number): {
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
} {
  return {
    yearWithdrawnByAcct: new Array(n).fill(0),
    yearPreWithdrawnByAcct: new Array(n).fill(0),
    yearPostWithdrawnByAcct: new Array(n).fill(0),
  };
}

describe('distributeWithdrawalByCustomTiersWithCap — cap inactive', () => {
  it('should_use_standard_distribution_when_capRemainingDollars_is_null', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', post: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'a1', pre: 100_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: null,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    expect(state[0].post).toBeCloseTo(80_000, 1);
    expect(state[1].pre).toBe(100_000);
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
    expect(onPreTaxDrawn).not.toHaveBeenCalled();
  });
});

describe('distributeWithdrawalByCustomTiersWithCap — cap active', () => {
  function makeCapConfig(
    capDollars: number,
    capOffYear = 2040,
    findLaterTaxableIndex?: MagiCapRuntimeConfig['findLaterTaxableIndex'],
  ): MagiCapRuntimeConfig {
    return {
      capDollars,
      capOffYear,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
      findTargetRothIndex: () => undefined,
      findLaterTaxableIndex: findLaterTaxableIndex ?? (() => undefined),
    };
  }

  it('should_skip_excluded_accounts_in_a_post_tax_tier', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0, 1]],
      excludedIndices: new Set([0]),
      target: 10_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig: makeCapConfig(10_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });

    expect(drawn).toBeCloseTo(10_000, 5);
    expect(state[0].post).toBe(50_000);
    expect(state[1].post).toBeCloseTo(40_000, 1);
    expect(trackers.yearWithdrawnByAcct[0]).toBe(0);
    expect(trackers.yearWithdrawnByAcct[1]).toBeCloseTo(10_000, 5);
  });

  it('should_return_zero_for_a_zero_balance_post_tax_tier', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', post: 0, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 5_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig: makeCapConfig(10_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });

    expect(drawn).toBe(0);
    expect(trackers.yearWithdrawnByAcct[0]).toBe(0);
  });

  it('should_draw_pre_tax_up_to_cap_then_skip_ahead_to_taxable_tier', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(15_000, 5);
    expect(state[0].pre).toBeCloseTo(40_000, 1);
    expect(state[1].post).toBeCloseTo(45_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_emit_breach_when_cap_exhausted_and_no_later_taxable_account', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(0, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 5_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(5_000, 5);
    expect(state[0].pre).toBeCloseTo(45_000, 1);
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
  });

  it('should_cap_pretax_and_pull_remainder_from_brokerage_when_preset_strategy_active', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 200_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(15_000, 5);
    expect(state[0].pre).toBeCloseTo(190_000, 1);
    expect(state[1].post).toBeCloseTo(45_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_draw_only_post_bucket_from_MIXED_account_when_routing_overflow', () => {
    // Skip-ahead must pull only from the MIXED post bucket; the MIXED pre bucket stays at $20k and the $2k residual breaches
    // from pre-tax.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', pre: 20_000, post: 3_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // 10k (cap) + 3k (MIXED post) + 2k (breach) = 15k.
    expect(drawn).toBeCloseTo(15_000, 5);
    expect(state[0].pre).toBeCloseTo(38_000, 1);
    expect(state[1].post).toBeCloseTo(0, 1);
    expect(state[1].pre).toBeCloseTo(20_000, 1);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(3_000, 1));
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(2_000, 1));
  });

  it('should_enforce_cap_when_MIXED_account_is_in_active_customOrder_tier', () => {
    // MIXED account (pre $40k, post $20k) alone in tier 0, cap $15k, target $20k: the post bucket covers the need, so pre stays
    // untouched and no cap breach occurs; a proportional draw would take 2/3 from pre and ignore the cap.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 40_000, post: 20_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(15_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 15_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    expect(state[0].post).toBeCloseTo(0, 1);
    expect(state[0].pre).toBeCloseTo(40_000, 1);
    expect(onPreTaxDrawn).not.toHaveBeenCalled();
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_draw_pretax_up_to_cap_in_MIXED_tier_then_breach', () => {
    // MIXED (pre $40k, post $5k), cap $10k, target $20k: post $5k first, pre up to the $10k cap, then $5k breaches from pre.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 40_000, post: 5_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    expect(state[0].post).toBeCloseTo(0, 1);
    // Pre: $40k − $10k (cap) − $5k (breach) = $25k.
    expect(state[0].pre).toBeCloseTo(25_000, 1);
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
  });

  it('should_skip_ahead_to_later_taxable_after_MIXED_tier_post_exhausted', () => {
    // MIXED (pre $30k, post $5k) then brokerage ($50k), cap $10k, target $20k: post $5k, pre $10k at the cap, the last $5k skips
    // ahead to the brokerage.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 30_000, post: 5_000, taxTreatment: 'MIXED' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    expect(state[0].post).toBeCloseTo(0, 1);
    expect(state[0].pre).toBeCloseTo(20_000, 1);
    expect(state[1].post).toBeCloseTo(45_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_exhaust_all_taxable_accounts_in_same_later_tier_before_breaching', () => {
    // Tier 1 holds two taxable accounts (brokerage $5k, savings $20k): after routing to the brokerage the scan must still reach
    // the savings account instead of recording a phantom $15k breach.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 30_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 5_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'a2', post: 20_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const resolver: MagiCapRuntimeConfig['findLaterTaxableIndex'] = (
      _tiers,
      _afterTierIdx,
      _state,
      visited,
    ) => {
      if (!visited.has(1)) return 1;
      if (!visited.has(2)) return 2;
      return undefined;
    };
    const magiCapConfig = makeCapConfig(10_000, 2040, resolver);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1, 2]],
      excludedIndices: new Set(),
      target: 30_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(30_000, 5);
    expect(state[0].pre).toBeCloseTo(20_000, 1);
    expect(state[1].post).toBeCloseTo(0, 1);
    // Savings: $20k − $15k overflow = $5k.
    expect(state[2].post).toBeCloseTo(5_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    // Two diversions: $5k (brokerage) + $15k (savings).
    expect(onTierOverrideDollars).toHaveBeenCalledTimes(2);
    expect(onTierOverrideDollars).toHaveBeenNthCalledWith(1, expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).toHaveBeenNthCalledWith(2, expect.closeTo(15_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_decrement_localCapRemaining_across_multiple_pre_tax_tiers', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 6_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', pre: 6_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(15_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 10_000,
      ...trackers,
      capRemainingDollars: 15_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(10_000, 5);
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[1].pre).toBeCloseTo(2_000, 1);
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
  });
});

function stateWithTargetedDeposit(
  overrides: Partial<AccountRunState>,
  amount: number,
): AccountRunState {
  const deposits = new Float64Array(1);
  deposits[0] = amount;
  return makeState({ ...overrides, deposits });
}

describe('applyMonthlyDeposits — a targeted deposit lands in the bucket matching the destination', () => {
  it('a rollover into a pre-tax account is held as pre-tax money', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'ira', pre: 100_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(150_000, 1);
    expect(state[0].post).toBeCloseTo(0, 1);
  });

  it('a rollover into a mixed account is held as pre-tax money', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'mix', pre: 60_000, post: 40_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(110_000, 1);
    expect(state[0].post).toBeCloseTo(40_000, 1);
  });

  it.each([
    ['a taxable brokerage', 'POST_TAX', 'BROKERAGE'],
    ['a Roth IRA', 'ROTH', 'RETIREMENT_ROTH_IRA'],
    ['an HSA', 'HSA', 'HSA'],
  ] as const)('a deposit into %s is held as after-tax money', (_label, treatment, accountType) => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'dest', pre: 0, post: 100_000, taxTreatment: treatment, accountType },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].post).toBeCloseTo(150_000, 1);
    expect(state[0].pre).toBeCloseTo(0, 1);
  });

  it('a shared household contribution never adds to a pre-tax account pocket (household-share guard)', () => {
    // The proportional household-share spread stays in the after-tax pocket even in a PRE_TAX account, so it never inflates the
    // drawable pre-tax balance or pushes the RMD floor above what can be withdrawn.
    const state = [
      makeState({ id: 'ira', pre: 100_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', deposits: new Float64Array(1) }),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 12_000, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(100_000, 1);
    expect(state[0].post).toBeCloseTo(12_000, 1);
  });

  it('the synthetic RMD-overflow cash carrier keeps its targeted credit in the after-tax pocket', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: RMD_OVERFLOW_CASH_ACCOUNT_ID, pre: 0, post: 5_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' },
        3_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[0].post).toBeCloseTo(8_000, 1);
  });
});

function singleMonthWithin(args: {
  readonly need: number;
  readonly medical: number;
  readonly hsaIndices: ReadonlyArray<number>;
}): TrialWithinYearInputs {
  const expense = new Float64Array(12);
  expense[0] = args.need;
  const medicalDemand = new Float64Array(12);
  medicalDemand[0] = args.medical;
  return {
    yearIndex: 0,
    expense,
    income: new Float64Array(12),
    householdDeposit: new Float64Array(12),
    yearNetNeed: args.need,
    hsaIndices: args.hsaIndices,
    medicalDemand,
  };
}

function balanceShareFallback(
  cashLikeDraw: number,
  hsaBalance: number,
  otherCashLikeBalance: number,
): number {
  return cashLikeDraw * (hsaBalance / (hsaBalance + otherCashLikeBalance));
}

describe('classifyTrialYearDraw — named strategy surfaces the EXACT HSA total', () => {
  // A zero-growth HSA, a larger SAVINGS account and a pre-tax account: taxEfficient holds the HSA out of the tiers, so it is
  // drawn only through the medical-first and emergency passes.
  const HSA_IDX = 0;

  it('feeds the exact medical-first HSA total, not the balance-share proportion', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'hsa', post: 10_000, taxTreatment: 'HSA', accountType: 'HSA', monthlyRate: 0 }),
      makeState({ id: 'sav', post: 90_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS', monthlyRate: 0 }),
      makeState({ id: 'ira', pre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', monthlyRate: 0 }),
    ];
    // Need $20k, medical demand $4k: medical-first HSA = $4k, the router funds the other $16k from SAVINGS.
    const cls = classifyTrialYearDraw({
      state,
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 20_000,
      capRemainingDollars: null,
      within: singleMonthWithin({ need: 20_000, medical: 4_000, hsaIndices: [HSA_IDX] }),
    });
    expect(cls.hsaWithdrawalDollars).toBeCloseTo(4_000, 6);
    expect(cls.hsaMedicalQualifiedDollars).toBeCloseTo(4_000, 6);
    expect(cls.postTaxCashLikeDollars).toBeCloseTo(20_000, 6);
    // The balance-share fallback would have under-stated the HSA total ($2k).
    const fallback = balanceShareFallback(cls.postTaxCashLikeDollars, 10_000, 90_000);
    expect(fallback).toBeCloseTo(2_000, 6);
    expect(cls.hsaWithdrawalDollars).not.toBeCloseTo(fallback, 2);
  });

  it('includes the emergency residual in the exact HSA total when the non-HSA pool is exhausted', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'hsa', post: 10_000, taxTreatment: 'HSA', accountType: 'HSA', monthlyRate: 0 }),
      makeState({ id: 'sav', post: 5_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS', monthlyRate: 0 }),
    ];
    // Need $12k, medical $3k: medical-first HSA = $3k, the router drains $5k SAVINGS, the $4k residual is emergency HSA: total
    // $7k.
    const cls = classifyTrialYearDraw({
      state,
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 12_000,
      capRemainingDollars: null,
      within: singleMonthWithin({ need: 12_000, medical: 3_000, hsaIndices: [HSA_IDX] }),
    });
    expect(cls.hsaWithdrawalDollars).toBeCloseTo(7_000, 6);
    expect(cls.hsaMedicalQualifiedDollars).toBeCloseTo(3_000, 6);
    expect((cls.hsaWithdrawalDollars ?? 0) - (cls.hsaMedicalQualifiedDollars ?? 0)).toBeCloseTo(
      4_000,
      6,
    );
    // The balance-share fallback would have over-stated the HSA total ($8k) and the emergency basis.
    const fallback = balanceShareFallback(cls.postTaxCashLikeDollars, 10_000, 5_000);
    expect(fallback).toBeCloseTo(8_000, 6);
    expect(cls.hsaWithdrawalDollars).not.toBeCloseTo(fallback, 2);
  });
});

describe('classifyCommittedYearDraw — inherited Roth IRA subset', () => {
  // The committed classifier is the one the Fill-mode conversion probe reads, and the trial classifier's tests cannot fail for
  // it.
  const ROTH_IRA_DRAW = 12_000;
  const PRE_TAX_DRAW = 30_000;

  function classify(rothIraState: Partial<AccountRunState>): ReturnType<
    typeof classifyCommittedYearDraw
  > {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({
        id: 'roth',
        post: 100_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        ...rothIraState,
      }),
    ];
    return classifyCommittedYearDraw(state, [PRE_TAX_DRAW, 0], [0, ROTH_IRA_DRAW]);
  }

  it('reports an inherited Roth IRA draw as a SUBSET of the Roth tranche', () => {
    const cls = classify({ inheritedAccount: true });
    expect(cls.rothInheritedTaxFreeDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
    // A subset, never a deduction: the Roth and funded totals do not move.
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
    expect(cls.fundedDollars).toBeCloseTo(PRE_TAX_DRAW + ROTH_IRA_DRAW, 6);
  });

  it('emits nothing for an inherited DESIGNATED-Roth plan (§402A unchanged)', () => {
    const cls = classify({ accountType: 'RETIREMENT_ROTH_401K', inheritedAccount: true });
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
  });

  it('emits nothing when the Roth IRA carries no inherited marker', () => {
    const cls = classify({});
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
  });

  it('attributes each stateful Roth slice to the ACCOUNT it left (per-owner funding)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'roth-ira-a', post: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
      makeState({ id: 'roth-401k-b', post: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_401K' }),
      makeState({
        id: 'roth-403b-inh',
        post: 100_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_403B',
        inheritedAccount: true,
      }),
    ];
    const cls = classifyCommittedYearDraw(state, [0, 0, 0], [5_000, 7_000, 3_000]);
    expect([...(cls.rothIraDollarsByAccountId ?? new Map())]).toEqual([['roth-ira-a', 5_000]]);
    expect([...(cls.rothDesignatedDollarsByAccountId ?? new Map())]).toEqual([
      ['roth-401k-b', 7_000],
    ]);
    expect([...(cls.rothInheritedDesignatedDollarsByAccountId ?? new Map())]).toEqual([
      ['roth-403b-inh', 3_000],
    ]);
    expect(cls.rothDollars).toBeCloseTo(15_000, 6);
    expect(cls.rothDesignatedDollars).toBeCloseTo(7_000, 6);
    expect(cls.rothInheritedDesignatedDollars).toBeCloseTo(3_000, 6);
  });
});

describe('isMagiNeutralPostBucket — MIXED Roth-designated', () => {
  it('returns true for HSA', () => {
    expect(isMagiNeutralPostBucket(makeState({ taxTreatment: 'HSA', accountType: 'HSA' }))).toBe(true);
  });

  it('returns true for RETIREMENT_ROTH_IRA and pure employer Roth types', () => {
    for (const accountType of [
      'RETIREMENT_ROTH_IRA',
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      expect(isMagiNeutralPostBucket(makeState({ taxTreatment: 'ROTH', accountType }))).toBe(true);
    }
  });

  it('returns true for MIXED Roth-designated types (401K/403B/457B/TSP)', () => {
    for (const accountType of [
      'RETIREMENT_401K',
      'RETIREMENT_403B',
      'RETIREMENT_457B',
      'RETIREMENT_TSP',
    ] as const) {
      expect(
        isMagiNeutralPostBucket(makeState({ taxTreatment: 'MIXED', accountType })),
      ).toBe(true);
    }
  });

  it('returns false for MIXED IRA (non-Roth-designated)', () => {
    expect(
      isMagiNeutralPostBucket(makeState({ taxTreatment: 'MIXED', accountType: 'RETIREMENT_IRA' })),
    ).toBe(false);
  });

  it('returns true for cash-like POST_TAX types (SAVINGS/MM/CD)', () => {
    for (const accountType of ['SAVINGS', 'MONEY_MARKET', 'CD'] as const) {
      expect(
        isMagiNeutralPostBucket(makeState({ taxTreatment: 'POST_TAX', accountType })),
      ).toBe(true);
    }
  });

  it('returns false for brokerage POST_TAX', () => {
    expect(
      isMagiNeutralPostBucket(makeState({ taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' })),
    ).toBe(false);
  });
});

describe('account floors — MAGI-cap distributor', () => {
  function capCfg(capDollars: number): MagiCapRuntimeConfig {
    return {
      capDollars,
      capOffYear: 2040,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
      findTargetRothIndex: () => undefined,
      findLaterTaxableIndex: () => undefined,
    };
  }

  it('caps a floored POST_TAX tier draw at its drawable above the floor (committing draw)', () => {
    const state: AccountRunState[] = [
      makeState({
        id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 40_000,
      }),
    ];
    const trackers = makeTrackers(1);
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 80_000,
      ...trackers,
      capRemainingDollars: 50_000,
      magiCapConfig: capCfg(50_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });
    // Only $60k is above the $40k floor.
    expect(drawn).toBeCloseTo(60_000, 4);
    expect(state[0].post).toBeCloseTo(40_000, 4);
  });

  it('skip-ahead diverts a LATER-tier POST_TAX floor reserve before a pre-tax breach', () => {
    // Tier 1's floored brokerage is diverted below its floor too, so the whole need is cap-safe and no breach is recorded.
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'broker', post: 30_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[1].post).toBeCloseTo(10_000, 4);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(20_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(state[0].pre).toBeCloseTo(50_000, 4); // pre-tax untouched (cap-safe funded)
  });

  it('negative: once POST_TAX cap-safe reserves are exhausted a pre-tax breach still records', () => {
    // The reserve drains ($30k) but the need is $50k, so the $20k residual breaches pre-tax; pre-tax is never a reserve (floors
    // apply to POST_TAX/HSA only).
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'broker', post: 30_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 50_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[1].post).toBeCloseTo(0, 4); // reserve fully drained
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(30_000, 1));
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(20_000, 1));
    expect(state[0].pre).toBeCloseTo(30_000, 4); // $20k breached from pre-tax
  });

  it('a LATER-tier HSA below its floor is NEVER diverted as cap-safe (breach records)', () => {
    // findLaterTaxableIndex returns the HSA, but the reserve fallback is POST_TAX-only (a below-floor HSA is nonqualified
    // ordinary income), so only the $2k above the floor diverts and $18k breaches.
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'hsa', post: 30_000, taxTreatment: 'HSA',
        accountType: 'HSA', floorDollars: 28_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[1].post).toBeCloseTo(28_000, 4); // HSA stops at its floor (not cap-safe below)
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(2_000, 1));
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(18_000, 1));
  });

  it('an EARLIER-tier POST_TAX reserve is out of forward-only skip-ahead reach (breach records)', () => {
    // findLaterTaxableIndex scans only tiers after the current one, so an earlier-tier POST_TAX reserve is unreachable and a
    // breach still records.
    const state: AccountRunState[] = [
      makeState({
        id: 'broker', post: 25_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000, // sitting AT its floor
      }),
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => undefined };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[0].post).toBeCloseTo(25_000, 4); // earlier reserve untouched by skip-ahead
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(15_000, 1));
    expect(state[1].pre).toBeCloseTo(35_000, 4);
  });

  it('trial classifier and committing draw produce the same floor-constrained pre/post split', () => {
    // Floored brokerage (tier 0, floor $40k) then pre-tax, target $70k: $60k from the brokerage, $10k from pre-tax; the trial
    // classifier must see the same split.
    const within: TrialWithinYearInputs = {
      yearIndex: 0,
      expense: new Float64Array(12).fill(70_000 / 12),
      income: new Float64Array(12),
      householdDeposit: new Float64Array(12),
      yearNetNeed: 70_000,
    };
    const mkState = (): AccountRunState[] => [
      makeState({
        id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 40_000,
        // 0% growth keeps the trial drawable at exactly the floor-constrained $60k.
        annualRatePct: 0, monthlyRate: 0,
      }),
      makeState({ id: 'pre', pre: 100_000, taxTreatment: 'PRE_TAX', annualRatePct: 0, monthlyRate: 0 }),
    ];
    const cls = classifyTrialYearDraw({
      state: mkState(),
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 70_000,
      capRemainingDollars: null,
      within,
    });
    expect(cls.postTaxNonRothDollars).toBeCloseTo(60_000, 3);
    expect(cls.preTaxDollars).toBeCloseTo(10_000, 3);
    expect(cls.fundedDollars).toBeCloseTo(70_000, 3);
  });

  it('the trial classifier reaches the floor RESERVE for a floored-only year', () => {
    // Floored-only brokerage ($100k, floor $40k), target $80k: the trial sim runs the same drawFloorReserve as the committing
    // path ($60k above the floor + $20k reserve), all postTaxNonRoth.
    const within: TrialWithinYearInputs = {
      yearIndex: 0,
      expense: new Float64Array(12).fill(80_000 / 12),
      income: new Float64Array(12),
      householdDeposit: new Float64Array(12),
      yearNetNeed: 80_000,
    };
    const cls = classifyTrialYearDraw({
      state: [
        makeState({
          id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE', floorDollars: 40_000, annualRatePct: 0, monthlyRate: 0,
        }),
      ],
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 80_000,
      capRemainingDollars: null,
      within,
    });
    expect(cls.postTaxNonRothDollars).toBeCloseTo(80_000, 3); // reserve included
    expect(cls.fundedDollars).toBeCloseTo(80_000, 3);
  });

  it('does NOT floor an ineligible PRE_TAX account with a stray floor in the cap path', () => {
    const state: AccountRunState[] = [
      makeState({
        id: 'pre', pre: 100_000, taxTreatment: 'PRE_TAX', floorDollars: 40_000,
      }),
    ];
    const trackers = makeTrackers(1);
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 80_000,
      ...trackers,
      capRemainingDollars: 100_000,
      magiCapConfig: capCfg(100_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });
    expect(drawn).toBeCloseTo(80_000, 4);
    expect(state[0].pre).toBeCloseTo(20_000, 4);
  });
});
