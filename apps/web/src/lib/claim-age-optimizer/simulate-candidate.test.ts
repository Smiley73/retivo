/**
 * Tests for `simulateOneCandidate` — the helper is a thin
 * wrapper around `runBalanceProjection`. The tests exercise the wrapper
 * path (deterministic balance, MC delegation, per-candidate SS rebuild).
 */
import { describe, expect, it, vi } from 'vitest';
import { simulateOneCandidate } from './simulate-candidate';
import type { OptimizerMcRunner } from './types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import type { ScenarioAggregate } from '../scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');

function member(
  id: string,
  isPrimary: boolean,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: isPrimary ? 'Alex' : 'Sam',
      lastName: '',
      email: '',
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: {
      householdMemberId: memberId,
      pia,
      piaAsOfDate: '2026-01-01',
      notes: null,
    },
  };
}

function brokerage(ownerId: string): Aggregate<AccountPayload> {
  return {
    id: 'a1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: 'Brokerage',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    id: 'b1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId: 'a1',
      year: 2025,
      lastUpdated: '2025-12-31',
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

function baseScenario(id: string): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: id,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90 },
      },
    },
  };
}

describe('simulateOneCandidate', () => {
  it('should_return_positive_at_horizon_balance_for_known_fixture', async () => {
    const m = [member('m1', true, 1960)];
    const ss = [ssBenefit('m1', 1)];
    const sc = baseScenario('s');
    const value = await simulateOneCandidate({
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 67, ageMonths: 0 } },
      accounts: [brokerage('m1')],
      balances: [balanceRow(1_000_000)],
      members: m,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      metric: 'balance',
      today: TODAY,
    });
    // Sanity: 1M seed with no expenses + zero inflation deflator-equal-1
    // → at-horizon balance well above $1M (compounded across years).
    expect(value).toBeGreaterThan(1_000_000);
  });

  it('threads medicalCategoryIds so a flagged non-cat-medical category gets the +2pp default', async () => {
    const m = [member('m1', true, 1960)];
    const ss = [ssBenefit('m1', 1)];
    const sc = baseScenario('s');
    const careExpense = {
      id: 'e-care',
      householdId: 'h',
      schemaVersion: 2,
      version: 1,
      updatedAt: '2026-05-19T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'expense' as const,
      payload: {
        name: 'Care',
        categoryId: 'cat-care',
        amount: 30_000,
        frequency: 'yearly' as const,
        classification: 'essential' as const,
        start: { kind: 'retirementStart' as const },
        end: { kind: 'lifetime' as const, whose: 'last' as const },
      },
    };
    const common = {
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 67, ageMonths: 0 } },
      accounts: [brokerage('m1')],
      balances: [balanceRow(2_000_000)],
      members: m,
      ssBenefits: ss,
      expenses: [careExpense],
      incomeStreams: [],
      metric: 'balance' as const,
      today: TODAY,
    };
    // Flagged → cat-care grows at general+2pp → higher expenses → lower
    // at-horizon balance than the unflagged (general-rate) run.
    const flagged = await simulateOneCandidate({
      ...common,
      medicalCategoryIds: ['cat-care'],
    });
    const unflagged = await simulateOneCandidate({
      ...common,
      medicalCategoryIds: [],
    });
    expect(flagged).toBeLessThan(unflagged);
  });

  it('should_dispatch_to_mc_runner_when_metric_is_plan_success', async () => {
    const m = [member('m1', true, 1960)];
    const ss = [ssBenefit('m1', 2000)];
    const sc = baseScenario('s');
    const mcRunner: OptimizerMcRunner = vi.fn(async () => ({
      successProbability: 0.87,
    }));
    const value = await simulateOneCandidate({
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 65, ageMonths: 0 } },
      accounts: [brokerage('m1')],
      balances: [balanceRow(800_000)],
      members: m,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      metric: 'mc',
      today: TODAY,
      mcRunner,
    });
    expect(value).toBe(0.87);
    expect(mcRunner).toHaveBeenCalledTimes(1);
  });

  it('should_rebuild_ss_dependent_slice_per_candidate', async () => {
    // Two different candidate ages must not return the same value when
    // SS contributes to drawdown. Per-candidate overlay means the
    // runner re-resolves the chain with a different SS pair on each
    // call; non-zero PIA → different income series → different at-
    // horizon balance.
    const m = [member('m1', true, 1960)];
    const ss = [ssBenefit('m1', 3000)];
    const sc = baseScenario('s');
    const expense = {
      id: 'e1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-19T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'expense' as const,
      payload: {
        name: 'Living',
        categoryId: 'cat-housing',
        amount: 60_000,
        frequency: 'yearly' as const,
        classification: 'essential' as const,
        start: { kind: 'retirementStart' as const },
        end: { kind: 'lifetime' as const, whose: 'last' as const },
      },
    };
    const at62 = await simulateOneCandidate({
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 62, ageMonths: 0 } },
      accounts: [brokerage('m1')],
      balances: [balanceRow(800_000)],
      members: m,
      ssBenefits: ss,
      expenses: [expense],
      incomeStreams: [],
      metric: 'balance',
      today: TODAY,
    });
    const at70 = await simulateOneCandidate({
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 70, ageMonths: 0 } },
      accounts: [brokerage('m1')],
      balances: [balanceRow(800_000)],
      members: m,
      ssBenefits: ss,
      expenses: [expense],
      incomeStreams: [],
      metric: 'balance',
      today: TODAY,
    });
    expect(at62).not.toBe(at70);
  });

  // A Historical (TWR) candidate over a portfolio that
  // mixes a ≥2-yr account with a short-history account no longer bails to
  // the NaN sentinel — the short-history account falls back to its planned
  // rate and the optimizer ranks on a finite metric.
  it('should_return_finite_TWR_metric_for_a_mixed_short_history_portfolio', async () => {
    const m = [member('m1', true, 1960)];
    const ss = [ssBenefit('m1', 1)];
    const sc = baseScenario('s');
    // Two non-CBP accounts: `funded` has 2 yr of history (empirical rate);
    // `short` has a single year (no empirical rate → planned fallback).
    const funded: Aggregate<AccountPayload> = {
      ...brokerage('m1'),
      id: 'funded',
      payload: { ...brokerage('m1').payload, name: 'Funded' },
    };
    const short: Aggregate<AccountPayload> = {
      ...brokerage('m1'),
      id: 'short',
      payload: { ...brokerage('m1').payload, name: 'Short' },
    };
    const bal = (
      accountId: string,
      year: number,
      endingBalance: number,
    ): Aggregate<AccountBalancePayload> => ({
      ...balanceRow(endingBalance),
      id: `b-${accountId}-${year}`,
      payload: { ...balanceRow(endingBalance).payload, accountId, year },
    });
    const value = await simulateOneCandidate({
      scenario: sc,
      scenarios: [sc],
      candidate: { primary: { ageYears: 67, ageMonths: 0 } },
      accounts: [funded, short],
      balances: [
        bal('funded', 2024, 900_000),
        bal('funded', 2025, 1_000_000),
        bal('short', 2025, 250_000),
      ],
      members: m,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      metric: 'balance',
      projectionMethod: 'twr',
      today: TODAY,
    });
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBeGreaterThan(1_000_000);
  });
});
