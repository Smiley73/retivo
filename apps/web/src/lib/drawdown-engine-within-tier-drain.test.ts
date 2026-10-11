/**
 * Unit tests for the within-tier sequential drain + the strict-order-
 * until-breach behaviour on the customOrder drawdown path.
 *
 * Within a custom tier, accounts drain in the LISTED order — account
 * `tier[0]` is fully emptied before `tier[1]` is touched — instead of the
 * balance-proportional split every other strategy uses.
 *
 * Under an active MAGI cap the engine follows the specified within-tier
 * order exactly, diverting to a cap-safe (post-tax / Roth) source only at the
 * dollar where the next in-order pre-tax draw would breach the cap; when no
 * cap-safe source remains it breaches (draws pre-tax anyway).
 *
 * The within-tier drain is sequential ONLY for customOrder. The shared
 * distributor stays balance-proportional for every preset caller — covered by
 * the non-customOrder regression assertion at the bottom.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  distributeWithdrawalByCustomTiers,
  type AccountRunState,
} from './drawdown-engine-per-account-strategy-helpers';
import { distributeWithdrawalByCustomTiersWithCap } from './drawdown-engine-per-account-strategy-cap';
import { buildMagiCapConfig } from './drawdown-engine-per-account-magi-cap';
import type { MagiCapWindow } from '../db/types';

function makeState(overrides: Partial<AccountRunState>): AccountRunState {
  return {
    id: 'acct',
    pre: 0,
    post: 0,
    annualRatePct: 0,
    monthlyRate: 0,
    taxTreatment: 'POST_TAX',
    accountType: 'BROKERAGE',
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

const CAP: MagiCapWindow = {
  start: { kind: 'retirementStart' },
  end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  magiCeilingAnnualDollars: 10_000,
  capMode: 'minimize',
  capMagiLine: 'irmaa',
};

describe('within-tier sequential drain (customOrder)', () => {
  it('should_fully_drain_the_first_in_order_account_before_touching_the_second', () => {
    // One tier, two post-tax accounts the user ordered acct1 → acct2.
    // Target $30k < acct1 balance: acct1 must absorb all of it, acct2 untouched.
    const state: AccountRunState[] = [
      makeState({ id: 'acct1', post: 40_000 }),
      makeState({ id: 'acct2', post: 40_000 }),
    ];
    const trackers = makeTrackers(2);

    const drawn = distributeWithdrawalByCustomTiers({
      state,
      tiers: [[0, 1]],
      excludedIndices: new Set(),
      target: 30_000,
      ...trackers,
      sequentialWithinTier: true,
    });

    expect(drawn).toBeCloseTo(30_000, 5);
    // acct1 drained to 0 before acct2 is touched.
    expect(state[0].post).toBeCloseTo(10_000, 5);
    expect(state[1].post).toBeCloseTo(40_000, 5);
  });

  it('should_spill_to_the_second_account_only_after_the_first_is_empty', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'acct1', post: 40_000 }),
      makeState({ id: 'acct2', post: 40_000 }),
    ];
    const trackers = makeTrackers(2);

    const drawn = distributeWithdrawalByCustomTiers({
      state,
      tiers: [[0, 1]],
      excludedIndices: new Set(),
      target: 55_000,
      ...trackers,
      sequentialWithinTier: true,
    });

    expect(drawn).toBeCloseTo(55_000, 5);
    expect(state[0].post).toBeCloseTo(0, 5);
    // acct2 covers the $15k overflow only after acct1 empties.
    expect(state[1].post).toBeCloseTo(25_000, 5);
  });
});

describe('strict-order-until-breach under an active cap', () => {
  // Single pre-tax tier with two pre-tax accounts in user order [pre1, pre2],
  // followed by a Roth tier (cap-safe). Cap = $10k.
  function preTierThenRoth(): {
    state: AccountRunState[];
    tiers: number[][];
  } {
    const state: AccountRunState[] = [
      makeState({ id: 'pre1', pre: 6_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }),
      makeState({ id: 'pre2', pre: 30_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'roth', post: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    ];
    return { state, tiers: [[0, 1], [2]] };
  }

  it('should_fill_the_cap_in_order_then_divert_the_over_cap_dollar_to_a_cap_safe_source', () => {
    const { state, tiers } = preTierThenRoth();
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();
    const magiCapConfig = buildMagiCapConfig(CAP, 2040);

    // Cap $10k; target $15k. In-order pre-tax fill: pre1 $6k → pre2 $4k (cap
    // reached at $10k). The over-cap $5k diverts to the cap-safe Roth tier.
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers,
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
      sequentialWithinTier: true,
    });

    expect(drawn).toBeCloseTo(15_000, 5);
    // pre1 fully drained ($6k), pre2 took the next $4k (cap = $10k total).
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[1].pre).toBeCloseTo(26_000, 1);
    // Over-cap $5k went to Roth; no breach.
    expect(state[2].post).toBeCloseTo(45_000, 1);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_breach_in_order_when_no_cap_safe_source_remains', () => {
    // Same pre tier, but the only cap-safe tier (Roth) is empty → breach.
    const state: AccountRunState[] = [
      makeState({ id: 'pre1', pre: 6_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }),
      makeState({ id: 'pre2', pre: 30_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({ id: 'roth', post: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    ];
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();
    const magiCapConfig = buildMagiCapConfig(CAP, 2040);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0, 1], [2]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
      sequentialWithinTier: true,
    });

    expect(drawn).toBeCloseTo(15_000, 5);
    // Cap-safe exhausted → the over-cap $5k breaches, drawn in order from pre2.
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[1].pre).toBeCloseTo(21_000, 1);
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
  });
});

describe('non-customOrder regression — proportional within-tier unchanged', () => {
  it('should_split_a_multi_account_tier_balance_proportional_when_not_customOrder', () => {
    // Two post-tax accounts in one tier, default flag (false): the $30k draw
    // splits proportional to balance ($40k : $20k = 2:1), NOT sequentially.
    const state: AccountRunState[] = [
      makeState({ id: 'a', post: 40_000 }),
      makeState({ id: 'b', post: 20_000 }),
    ];
    const trackers = makeTrackers(2);

    const drawn = distributeWithdrawalByCustomTiers({
      state,
      tiers: [[0, 1]],
      excludedIndices: new Set(),
      target: 30_000,
      ...trackers,
      // sequentialWithinTier omitted → proportional (preset-strategy behaviour).
    });

    expect(drawn).toBeCloseTo(30_000, 5);
    // Proportional: a loses 2/3 of $30k = $20k, b loses 1/3 = $10k.
    expect(state[0].post).toBeCloseTo(20_000, 1);
    expect(state[1].post).toBeCloseTo(10_000, 1);
  });
});
